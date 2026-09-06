# 实盘交易 Worker 化实施方案

## 1. 目标

将 Futu 与 Longbridge 的实盘交易能力统一收敛到 `fin-worker`：

- `fin-web` 只负责登录鉴权、参数校验、任务入队、结果轮询和页面渲染。
- `fin-worker` 独占券商凭据、OpenD/SDK 连接、交易门禁、订单提交和订单详情查询。
- AIDAP PostgreSQL 的 `cloud_jobs` 作为控制面队列，`cloud_worker_status` 作为只读快照。
- 任何真实订单写操作都不能在 `fin-web` 内执行。
- 人工确认与自动提交共用相同的 Worker 门禁和订单服务。

## 2. 统一架构

```text
浏览器
  -> fin-web/APIG
     -> 鉴权与请求校验
     -> cloud_jobs 入队
     -> 有限时间轮询任务结果
  -> fin-worker（唯一 leader）
     -> 平台门禁复核
     -> 券商连接
     -> 提交/拒绝/过期/详情查询
     -> PostgreSQL 历史持久化
```

运行约束：

- `fin-worker` 固定 `MinInstance=1 / MaxInstance=1`。
- PostgreSQL advisory lock 保证只有一个交易 leader。
- 发布切换后必须确认旧 leader 会话释放，再允许新任务进入。
- Web 等待超时不代表订单失败；订单确认采用唯一 `confirmationId`，页面必须通过历史记录复核终态。

## 3. Longbridge 实现

### 3.1 网络与进程边界

- 行情、账户、Ark、Futu、PostgreSQL 保持原网络路径。
- Longbridge 订单提交和订单详情使用独立 Node 子进程。
- 子进程单独注入：

```text
HTTPS_PROXY=http://10.20.1.37:1080
HTTP_PROXY=http://10.20.1.37:1080
```

- ECS Relay 仅允许 `CONNECT openapi.longbridge.com:443`。
- 不要求固定出口 IP；以 VPC 私网入口、目标域名白名单和真实交易总门禁控制风险。

### 3.2 任务类型

| 任务类型 | Worker 行为 |
|---|---|
| `longbridge_live.settings` | 更新自动提交开关并复核门禁 |
| `longbridge_live.confirm` | 人工确认后调用 SDK 提交真实订单 |
| `longbridge_live.reject` | 拒绝待确认订单 |
| `longbridge_live.batch_expire` | 批量过期待确认订单 |
| `longbridge_live.order_detail` | 查询订单状态、成交、费用和状态时间线 |

### 3.3 门禁

真实提交要求：

```text
LONGBRIDGE_LIVE_TRADING_ENABLED=true
LONGBRIDGE_ORDER_PROXY_URL 已配置
```

自动提交默认关闭：

```text
LONGBRIDGE_AUTO_SUBMIT_ENABLED=false
```

### 3.4 订单详情

Worker 通过 SDK 调用：

- `orderDetail(orderId)`
- `todayExecutions({ orderId })`
- 无当日成交时回退 `historyExecutions(...)`

页面展示：

- 实时订单状态
- 委托数量、成交数量、委托价、成交均价
- 成交记录
- 状态时间线
- 费用明细

## 4. Futu 实现

### 4.1 网络与进程边界

- `fin-web` 不连接 OpenD。
- `fin-worker` 通过私网 `FUTU_OPEND_HOST:FUTU_OPEND_PORT` 连接 Windows ECS 上的 Futu OpenD。
- RSA 私钥只注入 Worker，Web 不保存或使用交易密钥。
- 订单提交、订单列表、订单详情、成交和费用查询全部由 Worker 调用 Python Bridge。

### 4.2 任务类型

| 任务类型 | Worker 行为 |
|---|---|
| `futu_live.settings` | 更新自动提交开关并复核 REAL 门禁 |
| `futu_live.confirm` | 人工确认后调用 OpenD 提交真实订单 |
| `futu_live.reject` | 拒绝待确认订单 |
| `futu_live.batch_expire` | 批量过期待确认订单 |
| `futu_live.orders` | 查询 REAL 历史订单列表 |
| `futu_live.order_detail` | 查询单笔订单、成交明细和真实费用 |

### 4.3 门禁

真实提交要求：

```text
LIVE_TRADING_ENABLED=true
FUTU_LIVE_TRD_ENV=REAL
FUTU_OPEND_HOST/FUTU_OPEND_PORT 可达
```

自动提交默认关闭；开启时由 Worker 再次检查上述条件。

### 4.4 订单详情

新增 Python Bridge `futu_live_order_detail.py`，由 Worker 调用：

- `history_order_list_query` 获取订单状态和成交汇总。
- `history_deal_list_query` 获取逐笔成交。
- `order_fee_query` 获取真实费用。

返回字段：

- 订单号、标的、方向、类型、状态
- 委托数量、成交数量、剩余数量
- 委托价、成交均价、成交金额
- 创建时间、更新时间
- 逐笔成交编号、数量、价格、成交时间
- 费用总额和费用明细

## 5. Web API 契约

Longbridge：

```text
PUT  /api/longbridge/live-trading/settings
POST /api/longbridge/live-trading/pending-orders/:id/confirm
POST /api/longbridge/live-trading/pending-orders/:id/reject
POST /api/longbridge/live-trading/pending-orders/batch-expire
GET  /api/longbridge/live-trading/orders/:orderId/detail
```

Futu：

```text
PUT  /api/live-trading/settings
POST /api/live-trading/pending-orders/:id/confirm
POST /api/live-trading/pending-orders/:id/reject
POST /api/live-trading/pending-orders/batch-expire
GET  /api/live-trading/futu-orders
GET  /api/live-trading/futu-orders/:orderId/detail
```

所有接口在云端由 `routeOverrides.ts` 优先接管，禁止回落到直接调用券商服务的普通 Web 路由。

## 6. 失败语义

- 业务拒绝：任务本身标记成功，响应体 `ok=false`，避免队列自动重试真实订单。
- Worker 执行异常：任务标记失败，Web 返回 `502`。
- Web 等待超时：返回 `504` 和 `jobId`，任务可能仍在执行，禁止用户盲目重复确认。
- 查询失败不修改订单状态。
- 详情刷新只读，不触发撤单、改单或重新提交。

## 7. 发布与验收

1. 定向测试确认门禁、Payload 和历史持久化。
2. Python/Node 子进程语法检查。
3. Vite 生产构建。
4. 同一镜像发布到 `fin-web` 与 `fin-worker`。
5. Worker 收敛为单实例并确认新 leader 心跳。
6. 使用不存在订单 ID 验证控制请求确实由 Worker 处理。
7. 使用已有真实订单号执行只读详情查询。
8. 验证页面可查看订单状态、成交、费用，无需产生新订单。

## 8. 实施状态

- Longbridge：已实现并上线，订单详情能力随 `v25` 发布。
- Futu：已实现并随 `v26` 上线。
- 当前版本：`fin-web v34 / Revision 28`，`fin-worker v33 / Revision 32`。
- 已增加 `futu_live.cancel_order`、`longbridge_live.cancel_order` Worker 任务；真实撤单继续只允许由唯一 leader Worker 执行。
- 已增加统一托管订单监管器，量化评估停止后仍持续同步系统挂单；自动撤单为独立持久化开关，当前两平台均关闭。
- Futu 控制路由验收：设置读取与原值写回均为 HTTP 200；不存在订单确认返回 HTTP 400、`blockedByGate=false`，证明请求由 Worker 执行且未产生订单。
- Futu 详情验收：订单 `FH1D137F027EFF2000` 返回“全部成交”，成交 `1/1`，逐笔成交 1 条，真实费用明细 8 项，费用合计约 `2.54 USD`。
- Longbridge 详情验收：订单 `1281090161546940416` 可返回实时状态、委托/成交字段、状态时间线和费用集合。
- Git：未经人工检查不提交。
