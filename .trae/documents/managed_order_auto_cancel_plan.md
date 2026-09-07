# 实盘挂单监管与自动撤单实施计划

## Summary

为 Futu 实盘和 Longbridge 实盘增加统一的“已提交订单监管”能力：

- 券商返回订单号后，不再把本地 `SUBMITTED` 当作生命周期终点。
- `fin-worker` 持续同步本系统创建的真实挂单、部分成交与终态。
- 普通策略模型接收当前标的挂单摘要，避免重复或方向冲突的下单。
- 独立的挂单监管模型输出 `KEEP` / `CANCEL` 建议，不直接调用券商接口。
- 后端硬规则、所有权校验、状态复核和幂等锁通过后，才能执行真实撤单。
- 支持人工撤单与独立的自动撤单开关。
- 部分成交订单撤单时只撤剩余数量，已成交部分保持不变。

本计划不包含改单、追价后重新提交、模拟盘和独立 A 股实盘引擎。

## Current State Analysis

### 已有能力

- Futu 和 Longbridge 的提交、查询与详情已经迁移到 `fin-worker`。
- Worker 通过 PostgreSQL advisory lock 保证单 leader。
- Futu 详情可读取当前/历史订单、逐笔成交和费用。
- Longbridge 详情可读取订单状态、成交、状态时间线和费用。
- Longbridge SDK 提供 `TradeContext.cancelOrder(orderId)`。
- Futu OpenAPI 提供 `modify_order(ModifyOrderOp.CANCEL, orderId, 0, 0)`。
- 当前策略上下文已包含账户、持仓、K 线、盘口、趋势和候选池。

### 当前缺口

- `LivePendingOrder.status=SUBMITTED` 只表示券商受理成功，不表示已成交。
- 已提交订单没有持续同步；详情查询仅在用户打开页面时按需执行。
- 普通单票决策模型看不到真实挂单。
- 组合复核模型只看到提交前的待确认订单，不包含券商挂单。
- 没有统一的可撤状态映射、人工撤单 API、自动撤单门禁和撤单审计。
- 现有 `cloud_jobs` 失败任务默认重试，不能直接用于未经状态复核的真实撤单重试。
- 自动下单设置目前为 Worker 进程内状态，重启后回落到环境变量；自动撤单设置必须持久化。

## Assumptions & Decisions

- 平台范围：Futu 实盘与 Longbridge 实盘。
- 订单范围：仅管理本系统成功提交并已记录券商订单号的订单。
- 不导入、评估或撤销用户手工订单及其他终端创建的订单。
- 决策方式：确定性硬规则加专用模型。
- 自动撤单使用独立开关，默认关闭，不跟随自动下单开关。
- 人工撤单不依赖自动撤单开关，但必须通过订单所有权、券商连接和可撤状态检查。
- 默认时效：
  - `MARKETABLE_LIMIT`：提交后 90 秒未终态则硬规则撤单。
  - 普通 `LIMIT`：提交后 10 分钟未终态则硬规则撤单。
  - `MARKET`：不做基于时效的主动撤单，只同步终态。
- 券商状态同步每 15 秒执行一次。
- 模型复核每 60 秒执行一次；订单状态、成交量或价格显著变化时允许提前触发。
- 只有模型 `CANCEL + high` 才能自动执行；中低置信度仅展示建议和告警。
- 停止量化评估后停止新信号和新订单，但挂单监管器继续管理既有系统挂单。
- 模型不可用、输出不可解析或行情过期时保持 `KEEP`；已命中时效硬规则时不依赖模型。
- 第一版只支持撤单，不支持改单、追价或撤单后自动重下。
- 生产验证不得为了测试自动创建真实订单；需要真实撤单测试时另行取得明确授权。

## Proposed Changes

### 1. 建立统一托管订单模型

新增 `shared/managedOrderTypes.ts`：

- `ManagedBroker = 'futu' | 'longbridge'`
- `ManagedOrderStatus`
  - `TRACKING`
  - `PARTIALLY_FILLED`
  - `CANCEL_RECOMMENDED`
  - `CANCEL_REQUESTED`
  - `CANCEL_PENDING`
  - `FILLED`
  - `CANCELED`
  - `PARTIALLY_CANCELED`
  - `REJECTED`
  - `EXPIRED`
  - `UNKNOWN`
- `ManagedOrder`
  - 平台、券商订单号、待确认订单号、信号号
  - 标的、方向、订单类型、交易时段
  - 委托数量、成交数量、剩余数量
  - 委托价、成交均价、最新价、价格偏离
  - 提交时间、券商更新时间、最近同步时间、终态时间
  - 当前监管状态、所有权证明、策略与交易周期
  - 最近模型建议、硬规则命中项、撤单结果
- `ManagedOrderDecision`
  - `action: KEEP | CANCEL`
  - `confidence: low | medium | high`
  - `source: hard_rule | model | manual`
  - `reason`、`riskAssessment`、`decidedAt`
- `ManagedOrderEvent`
  - 状态同步、模型建议、人工请求、撤单请求、券商响应和终态确认

现有 `LiveOrderResult` 保持兼容；提交成功后额外注册 `ManagedOrder`，不改变既有历史页面的数据来源。

### 2. PostgreSQL 持久化与并发控制

修改 `deploy/volcano/pg/schema.sql`，新增：

#### `managed_live_orders`

- 主键：`(platform, order_id)`
- 唯一关联：`(platform, pending_order_id)`
- JSONB 保存原始券商快照、策略上下文和撤单策略。
- 独立列保存当前状态、成交量、剩余量、提交时间、最近检查时间和版本号。
- 建立非终态订单索引：

```sql
WHERE terminal_at IS NULL
```

#### `managed_order_events`

- 追加式审计表。
- 字段包含 `request_id`、平台、订单号、事件类型、来源、决策、券商响应和时间。
- `request_id` 唯一，防止同一人工/自动撤单请求重复执行。

新增 `api/cloud/state/managedOrderStore.ts`：

- 提交成功后注册订单。
- 查询当前平台或标的的非终态托管订单。
- 使用事务和 `SELECT ... FOR UPDATE` 锁定单笔订单。
- 采用乐观版本号避免同步线程和撤单线程互相覆盖。
- 写入状态快照与追加式事件。
- 在 Worker 重启或 leader 切换后恢复所有非终态订单。

### 3. 持久化执行设置

新增 `api/cloud/state/brokerExecutionSettingsStore.ts`，使用现有 `app_config` 保存：

```text
futu_live.execution_controls
longbridge_live.execution_controls
```

配置结构：

```json
{
  "autoSubmitEnabled": false,
  "autoCancelEnabled": false,
  "marketableLimitTimeoutSeconds": 90,
  "limitTimeoutSeconds": 600,
  "brokerSyncIntervalSeconds": 15,
  "modelReviewIntervalSeconds": 60,
  "modelAutoCancelConfidence": "high"
}
```

修改：

- `api/live/liveSettings.ts`
- `api/longbridge/longbridgeLiveSettings.ts`
- `api/cloud/jobs/jobHandlers.ts`
- `api/cloud/http/routeOverrides.ts`

要求：

- Worker 启动时从 PostgreSQL 加载配置，环境变量只作为首次默认值。
- 设置更新仍由 Web 入队、Worker 执行。
- Futu 与 Longbridge 页面分别展示独立自动撤单开关。

### 4. 券商订单适配器

新增统一接口 `api/live/managedOrderBrokerAdapter.ts`：

```ts
interface ManagedOrderBrokerAdapter {
  getOrderSnapshot(input): Promise<ManagedBrokerOrderSnapshot>
  cancelOrder(input): Promise<ManagedCancelBrokerResponse>
}
```

#### Futu

新增 `api/futu_bridge/futu_live_cancel_order.py`：

1. 使用订单号、账户和标的选择交易市场。
2. 先调用 `order_list_query` / `history_order_list_query` 复核当前状态。
3. 仅允许本系统托管且状态仍可撤的订单进入下一步。
4. 调用：

```python
modify_order(ModifyOrderOp.CANCEL, order_id, 0, 0, trd_env=TrdEnv.REAL, acc_id=...)
```

5. 返回“撤单请求已受理”，不能立即当作“已撤单”。
6. 复用并扩展 `api/futu_bridge/futu_live_order_detail.py` 的状态与成交归一化。

Futu 第一版可撤状态白名单：

- `SUBMITTED`
- `WAITING_SUBMIT`
- `FILLED_PART`

其他状态先重新查询；券商返回不可撤时按业务终态处理，不自动重发。

#### Longbridge

新增 `api/longbridge/longbridgeSdkOrderCancelChild.mjs`：

1. 复用订单专用代理环境变量。
2. 先调用 `orderDetail(orderId)`。
3. 仅允许状态 `NotReported`、`WaitToNew`、`New`、`PartialFilled`。
4. 调用 `trade.cancelOrder(orderId)`。
5. 返回受理结果，由监管器继续轮询到终态。

修改 `api/longbridge/longbridgeLiveOrderService.ts`：

- 增加 `cancelLongbridgeManagedOrder`。
- 继续使用独立 Node 子进程，避免代理污染主进程。

### 5. 挂单监管器

新增 `api/live/managedOrderSupervisor.ts`：

- 只在 Worker leader 中运行。
- 量化引擎是否运行不影响监管器。
- 每 15 秒：
  1. 读取非终态托管订单。
  2. 并发受限地查询券商状态。
  3. 以券商状态为准更新成交量、剩余量和终态。
  4. 对部分成交保留已成交部分，只管理剩余数量。
  5. 执行确定性硬规则。
- 每 60 秒或状态发生重要变化时：
  1. 汇总托管挂单、持仓、最新行情、趋势、原始信号和策略周期。
  2. 调用专用挂单监管模型。
  3. 保存模型建议。
  4. 仅高置信度 `CANCEL` 且自动撤单已开启时进入撤单执行。

修改 `api/cloud/worker/workerServer.ts`：

- leader 获取成功后启动监管器。
- leader 丢失或进程关闭时停止监管器。
- 监管器状态写入 `cloud_worker_status`。
- 发布切换时旧 leader 不得继续发起撤单。

监管器硬规则：

- 已终态：只做状态归档，不调用撤单。
- `MARKETABLE_LIMIT` 超过 90 秒：撤单。
- 普通 `LIMIT` 超过 10 分钟：撤单。
- `MARKET`：不因超时自动撤单。
- 同一订单已有 `CANCEL_REQUESTED/CANCEL_PENDING`：禁止重复发送。
- 状态或剩余数量不确定：只同步与告警，不撤单。
- 行情缺失：不执行依赖价格判断的模型撤单；时效规则仍可执行。
- 普通下单风控发现同标的已有非终态系统挂单时，阻止生成重复或方向冲突的新订单。

### 6. 专用模型上下文与协议

新增 `api/live/managedOrderDecisionService.ts`：

输入：

- 当前全部系统托管挂单摘要。
- 当前标的持仓和组合敞口。
- 原始信号、策略、交易周期、提交原因。
- 最新价、买卖盘、K 线、趋势和数据时间戳。
- 委托价、挂单年龄、成交比例、剩余数量和价格偏离。
- 自动撤单策略和硬规则结果。

输出协议：

```json
{
  "decisions": [
    {
      "platform": "futu",
      "orderId": "券商订单号",
      "action": "KEEP",
      "confidence": "high",
      "reason": "中文理由",
      "riskAssessment": "中文风险说明"
    }
  ],
  "portfolioRationale": "中文组合说明"
}
```

解析约束：

- 只能引用输入中的 `(platform, orderId)`。
- 只能输出 `KEEP` 或 `CANCEL`。
- 模型无权输出改单、重下、数量或价格。
- 缺项、重复项、未知订单、非法动作全部转为 `KEEP`。
- 自动执行仅接受 `CANCEL + high`。

修改：

- `api/live/liveTradingDecisionService.ts`
- `api/longbridge/longbridgeLiveDecisionService.ts`
- `api/live/livePortfolioReviewDecisionService.ts`
- `api/live/liveTradingEngine.ts`
- `api/longbridge/longbridgeLiveTradingEngine.ts`

普通单票决策只注入 `managedOpenOrdersForTicker` 摘要，并增加硬约束：

- 有同方向未完成挂单时禁止重复下单。
- 有反方向未完成挂单时必须先由监管器处理，当前轮保持 `HOLD`。

组合复核注入所有平台内的系统挂单，计算真实“持仓 + 未成交委托”敞口。

### 7. 撤单执行状态机

人工和自动撤单统一走：

1. 生成唯一 `cancelRequestId`。
2. 锁定 `(platform, orderId)` 托管记录。
3. 校验订单属于本系统。
4. 查询券商最新状态。
5. 已成交/已撤/已拒绝/已过期则只同步终态，返回无操作。
6. 写入 `CANCEL_REQUESTED` 事件。
7. 调用券商撤单一次。
8. 写入 `CANCEL_PENDING`。
9. 每 2 秒查询一次，最多 20 秒：
   - `CANCELED`：撤单成功。
   - `PARTIALLY_CANCELED`：已成交部分保留，剩余部分撤销。
   - `FILLED`：撤单竞态失败，订单已完全成交。
   - 超时：标记 `UNKNOWN` 并告警。
10. `UNKNOWN` 后只允许监管器重新查询，不盲目重发撤单。

`cloud_jobs` 中撤单业务失败必须以“任务成功、响应 `ok=false`”返回，避免默认三次自动重试真实操作。

### 8. Web API

Futu：

```text
GET  /api/live-trading/managed-orders
POST /api/live-trading/futu-orders/:orderId/cancel
PUT  /api/live-trading/settings
```

Longbridge：

```text
GET  /api/longbridge/live-trading/managed-orders
POST /api/longbridge/live-trading/orders/:orderId/cancel
PUT  /api/longbridge/live-trading/settings
```

人工撤单请求体：

```json
{
  "cancelRequestId": "客户端生成的 UUID",
  "reason": "用户手工撤单"
}
```

云端任务类型：

- `futu_live.cancel_order`
- `longbridge_live.cancel_order`
- `futu_live.settings`
- `longbridge_live.settings`

所有写操作继续由 `routeOverrides.ts` 入队，Web 不直接连接券商。

### 9. 前端

修改：

- `src/hooks/useLiveTrading.ts`
- `src/hooks/useLongbridgeLiveTrading.ts`
- `src/pages/LiveTradingView.tsx`
- `src/pages/LiveOrderDetailView.tsx`
- `src/pages/longbridge/LongbridgeLiveTradingView.tsx`

新增功能：

- 自动撤单独立开关。
- “系统挂单监管”区域，显示：
  - 券商状态、挂单年龄、委托/成交/剩余数量
  - 委托价、最新价、价格偏离
  - 最近硬规则和模型建议
  - 撤单请求状态和失败原因
- 可撤订单显示撤单图标按钮和二次确认弹窗。
- 部分成交明确显示“撤销剩余数量”。
- 订单详情追加完整监管事件时间线。
- 自动撤单关闭时仍显示模型建议，不执行。
- 页面不展示或允许操作非系统订单。

### 10. 日志、指标与告警

结构化日志事件：

- `managed_order.registered`
- `managed_order.reconciled`
- `managed_order.rule_triggered`
- `managed_order.model_decided`
- `managed_order.cancel_requested`
- `managed_order.cancel_accepted`
- `managed_order.cancel_terminal`
- `managed_order.cancel_uncertain`

Worker 快照增加：

- 托管订单总数
- 当前可撤订单数
- 部分成交订单数
- 待确认撤单结果数
- 最近同步时间
- 最近模型复核时间
- 最近错误

告警条件：

- 券商同步连续失败 3 次。
- 撤单结果超过 20 秒仍未知。
- 自动撤单已开启但 Worker 心跳超过 45 秒。
- 非终态托管订单超过配置时限但未产生撤单事件。

## Failure Modes

- 提交成功但本地注册失败：提交结果持久化后由启动恢复任务补注册。
- 券商已成交、模型同时建议撤单：执行前复核发现终态，只同步成交。
- 部分成交后撤单：只撤剩余数量，记录 `PARTIALLY_CANCELED`。
- 撤单请求返回超时：禁止盲目重试，先重新查询券商状态。
- Worker leader 切换：数据库锁和 `cancelRequestId` 唯一约束防止双撤单。
- 模型不可用：自动撤单仅执行硬规则；其他订单保持不动并告警。
- 行情过期：禁止价格/趋势驱动的模型撤单，时效规则仍可执行。
- 自动撤单设置重启丢失：通过 `app_config` 持久化解决。
- 发现非系统订单：只展示在券商原订单列表，不进入监管器。

## Verification

### 单元测试

新增：

- `tests/managedOrderPolicy.test.ts`
- `tests/managedOrderDecision.test.ts`
- `tests/managedOrderStore.test.ts`
- `tests/futuManagedOrderAdapter.test.ts`
- `tests/longbridgeManagedOrderAdapter.test.ts`

覆盖：

- 两家券商状态映射与可撤白名单。
- 90 秒/10 分钟硬规则。
- 市价单不做时效撤单。
- 模型非法订单号、非法动作和中低置信度不执行。
- 部分成交只撤剩余数量。
- 相同 `cancelRequestId` 幂等。
- 已成交与撤单竞态。
- 网络超时后只复核、不盲重试。
- 非系统订单拒绝撤单。

### Worker 与 API 集成测试

扩展：

- `tests/cloud/jobQueue.integration.test.ts`
- `tests/liveTradingFlows.test.ts`
- `tests/longbridgeLiveTradingDryRun.test.ts`

验证：

- Web 只入队，Worker 执行撤单。
- 业务失败不会触发任务自动重试。
- leader 重启后恢复托管订单。
- 引擎停止后监管器仍继续运行。
- 自动撤单开关独立于自动下单。

### 生产验收

1. 执行数据库迁移，部署 Web/Worker，保持 `autoCancelEnabled=false`。
2. 用现有系统订单历史验证补注册与终态同步。
3. 影子运行至少一个完整交易时段：
   - 每 15 秒同步真实挂单。
   - 每 60 秒生成模型建议。
   - 不执行自动撤单。
4. 验证人工撤单 UI 与 API，但不创建测试真实订单；仅在已有可撤系统挂单且用户明确确认时执行。
5. 检查 Futu/Longbridge 订单详情和监管事件一致。
6. 人工审核影子建议后再开启单个平台自动撤单。
7. 先开启 Futu 或 Longbridge 其中一端，观察至少一个交易时段，再开启另一端。
8. 验证停止量化后，新订单不再产生，已有挂单仍被监管。

## Rollback

- 立即关闭两个平台的 `autoCancelEnabled`。
- 保留人工撤单与只读状态同步。
- 监管器可停用，但不删除托管订单和事件审计。
- 回滚应用版本不回滚数据库表；新表为向后兼容增量。
- 不自动恢复已撤订单，也不自动重新提交。

## Implementation Status

- 2026-09-06 已完成 Futu 与 Longbridge 的统一托管订单、状态同步、硬规则、专用模型、人工撤单和自动撤单独立门禁。
- AIDAP 已创建 `managed_live_orders`、`managed_order_events`，并持久化两平台执行设置。
- 已发布镜像：
  - `fin-web`：`financial-workbench:v34`，Revision 28。
  - `fin-worker`：`financial-workbench:v33`，Revision 32，唯一 leader 已接管。
- 当前两平台均为影子模式：
  - `autoSubmitEnabled=false`
  - `autoCancelEnabled=false`
- 生产影子验证已识别一笔系统创建的 Longbridge 未成交限价单，并生成高置信度硬规则 `CANCEL` 建议；未向券商发送撤单请求。
- Futu 与 Longbridge 的不存在订单号撤单请求均在所有权校验阶段返回 HTTP 400，未调用券商。
- 相关测试 39 项通过、1 项按既有条件跳过；Vite 构建、Python 与 Node 子进程语法检查通过。
- 全量 TypeScript 检查仍受仓库既有共享类型缺失阻断，需独立收敛，不影响当前镜像采用的 Vite 构建流程。
- 未执行真实撤单；启用任何平台自动撤单前，仍需完成人工审核和至少一个完整交易时段的影子观察。

## Source References

- Longbridge Node SDK：`TradeContext.cancelOrder(orderId)`，本仓库 `node_modules/longbridge/index.d.ts`。
- Futu OpenAPI 改单撤单：
  - https://openapi.futunn.com/futu-api-doc/hk/trade/modify-order.html
  - https://openapi.futunn.com/futu-api-doc/trade/trade.html
