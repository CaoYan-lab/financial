# 实盘订单状态同步与筛选实现计划

## Summary

本计划替代上一版单纯“状态筛选”计划。新的优先级是：

1. 先修复实盘提交后的订单生命周期状态同步问题。
2. 再实现待确认订单按完整生命周期状态筛选。
3. 再实现历史策略信号按生命周期状态 + 交易方向筛选。

当前 SNDK 案例已经确认：

- 不是数据库没落失败状态。
- 本地 `.data/live-trading-history.sqlite3` 已有 `SUBMIT_FAILED` 和 `submitted_orders.ok=false`。
- Futu APP 通知的失败也能通过 `/api/live-trading/futu-orders?ticker=SNDK` 查到，真实 Futu 订单状态为 `FAILED`，订单号为 `FH1CB060376AA48000`。
- 页面仍显示“提交中”的根因是生命周期合并逻辑只按 payload `updatedAt` 比较，而失败记录 `2026-06-17T14:48:13Z` 少了毫秒，早于 `CONFIRMED_SUBMITTING` 的 `2026-06-17T14:48:13.788Z`，导致旧状态覆盖了失败状态。

## Current State Analysis

### 1. 提交接口同步返回现状

确认接口：

- `api/routes/liveTradingRoutes.ts`
- 路由：`POST /api/live-trading/pending-orders/:id/confirm`

当前流程：

1. 后端校验 `LIVE_TRADING_ENABLED=true` 和 `FUTU_LIVE_TRD_ENV=REAL`。
2. 读取 pending 订单，状态必须是 `PENDING_CONFIRMATION`。
3. 调用 `liveOrderQueueService.markSubmitting()`，写入 `CONFIRMED_SUBMITTING`。
4. 调用 `submitLiveOrder()`。
5. 调用 `liveOrderQueueService.markSubmitted()`，根据 `result.ok` 写入：
   - `SUBMITTED`
   - `SUBMIT_FAILED`

提交服务：

- `api/live/futuLiveOrderService.ts`
- `submitLiveOrder()` 调用 Python bridge `futu_live_order.py`。

Python bridge：

- `api/futu_bridge/futu_live_order.py`
- 调用 `trade_ctx.place_order(...)`。
- 如果 `ret != RET_OK`，返回：
  - `ok: false`
  - `orderId: unavailable`
  - `error: place_order REAL failed: ...`
- 如果 `ret == RET_OK`，返回：
  - `ok: true`
  - `orderId`
  - `rawResponse`

结论：

- 提交接口确实收到了失败返回，并已本地落库为失败。
- 但当前失败返回不一定带真实 Futu `order_id`。
- Futu 后续历史订单接口可能能查到真实失败订单号和 `FAILED/last_err_msg`，当前确认接口没有做二次同步回填。

### 2. SNDK 本地状态证据

本地历史库里 SNDK 已有：

- `pending_orders` 初始：`PENDING_CONFIRMATION`
- `pending_orders` 确认中：`CONFIRMED_SUBMITTING`
- `pending_orders` 失败：`SUBMIT_FAILED`
- `submitted_orders`：`ok=false`

失败原因：

```text
place_order REAL failed: Due to regulatory requirements, you are currently located in China mainland and cannot trade.
```

Futu REAL 历史订单接口查询 SNDK 返回：

- `orderId`: `FH1CB060376AA48000`
- `orderStatus`: `FAILED`
- `orderStatusLabel`: `失败`
- `last_err_msg`: 同监管限制原因

### 3. 页面显示错误根因

当前 `/api/live-trading/history/pending-orders` 调用：

- `livePersistence.paginatePendingOrderLifecycle(...)`

当前生命周期合并函数：

- 文件：`api/live/livePersistence.ts`
- 以 `updatedAt`/`createdAt` 计算 `eventTime()`。

问题：

- `CONFIRMED_SUBMITTING.updatedAt = 2026-06-17T14:48:13.788Z`
- `SUBMIT_FAILED.updatedAt = 2026-06-17T14:48:13Z`
- 时间戳精度不同，失败状态反而被判断为更早。
- 因此页面仍展示 `CONFIRMED_SUBMITTING`。

这说明生命周期最新状态不能只依赖业务时间字段，应该优先使用 SQLite 自增 `historyId` 或数据库事件 id；必要时再使用状态优先级兜底。

### 4. 待确认订单筛选现状

- 前端 `LiveTradingView.tsx` 已能按 `order.status` 显示按钮或状态标签。
- 但没有状态筛选控件。
- 后端接口暂不支持 `status` query。

### 5. 历史策略信号筛选现状

- `signals` 只保存 `QuantSignal.side`，没有直接保存生命周期状态。
- 前端已可用 `skippedItems` 推导“未进入待确认队列”提示。
- 后端暂不支持按方向或生命周期状态筛选。

## Decisions

### 订单生命周期状态口径

以本地候选订单生命周期为页面主状态：

- `PENDING_CONFIRMATION`: 待确认
- `CONFIRMED_SUBMITTING`: 提交中
- `SUBMITTED`: 已提交到 Futu，但最终成交/失败仍需 Futu 历史订单同步
- `SUBMIT_FAILED`: 提交失败，包含 place_order 同步失败或 Futu 后续订单状态失败
- `REJECTED_BY_USER`: 用户已拒绝
- `BLOCKED_BY_RISK`: 风控关闭

### Futu 订单状态映射

从 `futu_live_orders.py` 返回的 `orderStatus` 映射到本地状态：

- `FAILED`、`SUBMIT_FAILED` -> `SUBMIT_FAILED`
- `CANCELLED_ALL`、`CANCELLED_PART` -> 可先保持 `SUBMITTED` 并在详情展示 Futu 状态；本次不新增本地撤单状态，避免扩大类型范围。
- `SUBMITTED`、`WAITING_SUBMIT`、`SUBMITTING` -> `SUBMITTED` 或 `CONFIRMED_SUBMITTING`，以是否已经拿到 Futu `orderId` 决定。
- `FILLED_ALL`、`FILLED_PART` -> `SUBMITTED`，成交细节由“实盘订单状态”表展示。

### 筛选口径

待确认订单状态筛选覆盖完整生命周期：

- `ALL`
- `PENDING_CONFIRMATION`
- `CONFIRMED_SUBMITTING`
- `SUBMITTED`
- `REJECTED_BY_USER`
- `SUBMIT_FAILED`
- `BLOCKED_BY_RISK`

历史策略信号筛选同时支持：

1. 交易方向：
   - `ALL`
   - `HOLD`
   - `BUY`
   - `SELL_SHORT`
   - `SELL_TO_CLOSE`

2. 信号生命周期状态：
   - `ALL`
   - `HOLD`
   - `PENDING_CONFIRMATION`
   - `CONFIRMED_SUBMITTING`
   - `SUBMITTED`
   - `REJECTED_BY_USER`
   - `SUBMIT_FAILED`
   - `BLOCKED_BY_RISK`
   - `SKIPPED`

## Proposed Changes

### 1. 修复生命周期合并：`api/live/livePersistence.ts`

#### 1.1 使用 SQLite 事件 id 判定最新状态

当前 `event_payload(row)` 会把 SQLite `id` 写入 `historyId`。

计划调整 `paginatePendingOrderLifecycle()`：

- 合并同一订单 id 时优先比较 `historyId`。
- `historyId` 大的事件一定更新。
- 只有缺失 `historyId` 时才回退到 `updatedAt/createdAt`。

推荐辅助函数：

```ts
function lifecycleVersion(order: Pick<LivePendingOrder, 'historyId' | 'updatedAt' | 'createdAt'>): number {
  if (typeof order.historyId === 'number') return order.historyId
  return Date.parse(order.updatedAt) || Date.parse(order.createdAt) || 0
}
```

这样 SNDK 的 `SUBMIT_FAILED` 事件 id `406` 会覆盖 `CONFIRMED_SUBMITTING` 事件 id `404`。

#### 1.2 生命周期列表纳入 submitted_orders

当前生命周期只合并：

- `pending_orders`
- `rejected_orders`

计划加入：

- `submitted_orders`

原因：

- `submitted_orders` 持有最终提交结果、`ok=false`、`error`、`orderId`。
- 如果 `pending_orders` 状态更新缺失，也能从 `submitted_orders` 反推出最新状态。

转换规则：

- `submitted_order.ok === true` -> `SUBMITTED`
- `submitted_order.ok === false` -> `SUBMIT_FAILED`

转换后的 `LivePendingOrder` 可通过原 pending 订单补齐 `intent/signal/llmDecision/riskWarnings`，再附上 `submittedOrder`。

### 2. Futu 同步回填：`api/live/futuLiveOrderService.ts`

新增一个提交后同步步骤，不改变下单门禁和人工确认流程。

#### 2.1 查询 Futu REAL 最新订单状态

在 `submitLiveOrder()` 中：

1. 调用 `futu_live_order.py` 得到同步返回。
2. 无论 `bridge.data.ok` 是 true 还是 false，只要有 ticker/accountId，都在短延迟后查询一次 `loadFutuLiveOrders({ ticker, pageSize: 20 })`。
3. 用以下条件匹配最可能对应的订单：
   - `ticker` 相同。
   - `remark` 包含 `FinancialWorkbench LIVE` 和 signal id 前缀，或包含 confirmation id。
   - `createTime/updatedTime` 在提交时间附近，例如 2 分钟内。
   - 如果同步返回已有 `orderId`，优先按 `orderId` 匹配。

#### 2.2 用 Futu 状态增强 LiveOrderResult

如果查到 Futu 订单：

- `orderId` 使用 Futu 真实 `orderId`。
- `rawResponse` 合并 Futu order rawResponse。
- 如果 Futu `orderStatus` 为 `FAILED/SUBMIT_FAILED`：
  - `ok=false`
  - `error` 优先使用 `rawResponse.last_err_msg`，其次使用原 error。
- 如果 Futu 状态不是失败：
  - 保留 `ok=true` 或原状态。

注意：

- 这里不把 Futu 的“已提交但未成交”误判为成功成交；只表示已经提交到 Futu。
- 成交/撤单等最终状态仍由“实盘订单状态”表展示。

### 3. 提交后状态落库：`api/live/liveOrderQueueService.ts`

当前 `markSubmitted()` 已经会：

- `replacePending(..., false)` 从内存 active pending 移除。
- append `pending_orders` 更新态。
- append `submitted_orders`。

计划确认并保持：

- `result.ok=false` 时 pending 状态为 `SUBMIT_FAILED`。
- `result.ok=true` 时 pending 状态为 `SUBMITTED`。

配合第 1 步修复后，列表会正确显示 `SUBMIT_FAILED`，不会停在 `CONFIRMED_SUBMITTING`。

### 4. 状态筛选接口：`api/routes/liveTradingRoutes.ts`

#### 4.1 pending orders

扩展：

```http
GET /api/live-trading/history/pending-orders?page=1&pageSize=12&status=SUBMIT_FAILED
```

调用：

```ts
livePersistence.paginatePendingOrderLifecycle(page, pageSize, status)
```

非法状态归一化为 `ALL`。

#### 4.2 signals

扩展：

```http
GET /api/live-trading/history/signals?page=1&pageSize=12&direction=BUY&lifecycleStatus=SUBMIT_FAILED
```

调用新增：

```ts
livePersistence.paginateSignalLifecycle(page, pageSize, direction, lifecycleStatus)
```

### 5. SQLite/Python 查询：`api/futu_bridge/live_history_db.py`

新增只读 action：

- `paginate_pending_order_lifecycle`
- `paginate_signal_lifecycle`

#### pending lifecycle 查询

逻辑：

- 读取 `pending_orders/rejected_orders/submitted_orders`。
- 按 pending order id 合并。
- 优先按 SQLite `id` 判定最新事件。
- 支持 status filter。

#### signal lifecycle 查询

逻辑：

- 以 `signals` 为主集合。
- direction 直接按 signal.side 过滤。
- 生命周期状态推导：
  - `HOLD` 信号 -> `HOLD`
  - 有订单生命周期 -> 订单最新状态
  - 有 skipped 精确 `signalId` -> `SKIPPED`
  - 旧 skipped 无 `signalId` -> ticker + 10 秒窗口 fallback -> `SKIPPED`
  - 非 HOLD 但无关联 -> `SKIPPED`，原因标为“未找到对应候选订单或拦截记录”
- 按 lifecycleStatus 过滤后分页。

### 6. 前端 Hook：`src/hooks/useLiveTrading.ts`

新增状态：

- `pendingOrderStatusFilter`
- `signalDirectionFilter`
- `signalLifecycleFilter`

新增函数：

- `setPendingOrderStatusFilter(status)`
- `setSignalDirectionFilter(direction)`
- `setSignalLifecycleFilter(status)`

行为：

- 切换筛选时对应列表回到第 1 页。
- 自动刷新、手动刷新和翻页都保留当前筛选条件。
- `loadHistory()` 根据 kind 带上对应 query 参数。

### 7. 前端页面：`src/pages/LiveTradingView.tsx`

#### 7.1 待确认订单队列筛选

增加状态筛选 chip：

- 全部
- 待确认
- 提交中
- 已提交
- 已拒绝
- 提交失败
- 风控关闭

操作列保持：

- `PENDING_CONFIRMATION` 显示“确认弹窗”
- 其他状态显示状态标签

#### 7.2 历史策略信号筛选

在 `HistoryTable` 中增加两组筛选：

1. 生命周期状态：
   - 全部、观望、待确认、提交中、已提交、已拒绝、提交失败、风控拦截
2. 交易方向：
   - 全部、观望、买入、卖空、平仓卖出

信号卡片展示生命周期标签：

- `SUBMIT_FAILED` 显示“提交失败”
- 如果有 `lifecycleReason`，显示具体失败原因。

### 8. 测试

新增或扩展 `tests/liveTrading.test.ts`：

1. 生命周期合并使用 `historyId`，`SUBMIT_FAILED` 能覆盖毫秒更晚但更旧的 `CONFIRMED_SUBMITTING`。
2. `submitted_orders.ok=false` 能推导为 `SUBMIT_FAILED`。
3. pending status filter = `SUBMIT_FAILED` 只返回提交失败订单。
4. pending status filter = `PENDING_CONFIRMATION` 不返回提交失败订单。
5. signal direction filter = `BUY` 只返回 BUY。
6. signal lifecycle filter = `SUBMIT_FAILED` 能返回 SNDK 类信号。
7. signal lifecycle filter = `SKIPPED` 能返回硬风控未入队信号。

## Acceptance Criteria

1. SNDK 这类提交失败订单在待确认订单队列中显示 `提交失败`，不再显示 `提交中`。
2. 如果 Futu 历史订单能查到真实失败订单号，页面或详情可展示真实 `orderId` 和 `last_err_msg`。
3. 待确认订单状态筛选总数、页数和当前页内容一致。
4. 历史策略信号支持生命周期状态 + 交易方向组合筛选。
5. 切换筛选后回到第 1 页。
6. 手动刷新和 30 秒自动刷新保留筛选条件。

## Verification Steps

实现后执行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
```

接口验证：

```bash
curl -sS 'http://localhost:3001/api/live-trading/history/pending-orders?status=SUBMIT_FAILED&page=1&pageSize=12'
curl -sS 'http://localhost:3001/api/live-trading/history/signals?direction=BUY&lifecycleStatus=SUBMIT_FAILED&page=1&pageSize=12'
curl -sS 'http://localhost:3001/api/live-trading/futu-orders?ticker=SNDK&page=1&pageSize=20'
```

手工验证：

1. 打开 `/live-trading`。
2. 待确认订单状态筛选选择“提交失败”，应看到 SNDK。
3. SNDK 操作列显示“提交失败”，不显示确认按钮。
4. 历史策略信号筛选选择方向“买入” + 状态“提交失败”，应看到 SNDK BUY 信号。
5. SNDK 详情应能看到 Futu 失败原因：监管限制导致无法交易。
