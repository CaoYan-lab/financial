# 实盘历史状态筛选实现计划

## Summary

本次目标是在实盘交易页面补齐两个筛选能力：

1. “待确认订单队列”支持按订单生命周期状态筛选。
2. “历史策略信号”支持同时按信号生命周期状态和交易方向筛选。

筛选必须在后端历史接口层完成，不能只做前端当前页过滤。原因是当前两个列表都已经分页，如果只过滤前端已加载的 12 条，会导致总数、页码和自动刷新结果不一致。

## Current State Analysis

### 前端当前状态

- 页面文件：`src/pages/LiveTradingView.tsx`
  - `pendingOrders` 来自 `history['pending-orders']`，当前展示生命周期订单列表。
  - 订单行已根据 `order.status` 决定展示“确认弹窗”按钮或状态标签。
  - 历史策略表 `HistoryTable` 当前只展示信号，不提供筛选控件。
  - 历史策略表已通过 `skippedItems` 对非 HOLD 信号展示“未进入待确认队列”的拦截原因。

- Hook 文件：`src/hooks/useLiveTrading.ts`
  - `loadHistory(kind, page, pageSize)` 当前只传 `page/pageSize`。
  - `historyPagesRef` 只记录分页页码，不记录筛选条件。
  - `refreshAll()` 会刷新 `signals`、`pending-orders`、`submitted-orders`、`skipped`、`futu-orders`，但没有筛选参数。

### 后端当前状态

- 路由文件：`api/routes/liveTradingRoutes.ts`
  - `/api/live-trading/history/signals` 调用 `livePersistence.paginate('signals', ...)`。
  - `/api/live-trading/history/pending-orders` 调用 `livePersistence.paginatePendingOrderLifecycle(...)`。

- 持久化文件：`api/live/livePersistence.ts`
  - `paginate(kind, page, pageSize)` 是通用分页。
  - `paginatePendingOrderLifecycle(page, pageSize)` 会读取 `pending_orders + rejected_orders`，按订单 id 合并成最新生命周期状态。
  - 当前生命周期合并逻辑在 TypeScript 层完成，最多读取最近 500 条。

- SQLite 桥接文件：`api/futu_bridge/live_history_db.py`
  - 表为单表 `live_events`，字段包含 `kind/ticker/side/status/created_at/payload`。
  - `payload` 存完整 JSON。
  - 当前 `paginate` 只支持按 `kind` 分页，不支持状态或方向筛选。

### 类型当前状态

- `shared/types.ts`
  - `QuantSignalSide = 'BUY' | 'SELL_SHORT' | 'SELL_TO_CLOSE' | 'HOLD'`
  - `LivePendingOrderStatus` 包含：
    - `PENDING_CONFIRMATION`
    - `CONFIRMED_SUBMITTING`
    - `SUBMITTED`
    - `REJECTED_BY_USER`
    - `BLOCKED_BY_RISK`
    - `SUBMIT_FAILED`
  - `LiveSkippedTicker` 已支持可选 `signalId` 和 `side`。

## Decisions

### 待确认订单状态筛选

按用户确认，订单筛选覆盖完整生命周期状态：

- `ALL`: 全部
- `PENDING_CONFIRMATION`: 待确认
- `CONFIRMED_SUBMITTING`: 提交中
- `SUBMITTED`: 已提交
- `REJECTED_BY_USER`: 已拒绝
- `SUBMIT_FAILED`: 提交失败
- `BLOCKED_BY_RISK`: 风控关闭

说明：

- 页面标题仍可叫“待确认订单队列”，但说明文案应明确这是“实盘候选订单生命周期列表”。
- 状态筛选会影响列表总数、页码和当前页内容。
- 切换筛选时重置到第 1 页。

### 历史策略信号筛选

按用户确认，历史策略信号同时支持两个筛选维度。

交易方向筛选：

- `ALL`: 全部方向
- `HOLD`: 观望
- `BUY`: 买入/空头回补
- `SELL_SHORT`: 卖空
- `SELL_TO_CLOSE`: 平仓卖出

信号生命周期状态筛选：

- `ALL`: 全部状态
- `HOLD`: 观望信号，仅历史入库，不进入待确认队列
- `PENDING_CONFIRMATION`: 已进入待确认
- `CONFIRMED_SUBMITTING`: 提交中
- `SUBMITTED`: 已提交
- `REJECTED_BY_USER`: 已拒绝
- `SUBMIT_FAILED`: 提交失败
- `BLOCKED_BY_RISK`: 风控关闭
- `SKIPPED`: 未进入待确认队列/被硬风控或数据条件拦截

状态推导规则：

1. `signal.side === 'HOLD'` 时，生命周期状态为 `HOLD`。
2. 若存在以 `signal.id` 关联的订单生命周期记录，则以订单最新状态为准。
3. 若存在以 `signalId` 关联的 skipped 记录，则生命周期状态为 `SKIPPED`。
4. 兼容旧数据：对没有 `signalId` 的 skipped 记录，可沿用当前前端逻辑的时间窗口兜底，即同 ticker、信号时间之后 10 秒内的 skipped 视为该信号的拦截结果。
5. 非 HOLD 且找不到订单/拦截记录时，状态显示为 `SKIPPED` 或 `UNKNOWN`。为避免页面出现不可解释状态，计划采用 `SKIPPED`，并在 UI 文案中称为“未入队/待追溯”。

## Proposed Changes

### 1. `shared/types.ts`

新增筛选类型，供前后端复用：

- `LivePendingOrderStatusFilter`
- `LiveSignalDirectionFilter`
- `LiveSignalLifecycleStatus`
- `LiveSignalLifecycleFilter`

推荐类型：

```ts
export type LivePendingOrderStatusFilter = 'ALL' | LivePendingOrderStatus
export type LiveSignalDirectionFilter = 'ALL' | QuantSignalSide
export type LiveSignalLifecycleStatus =
  | 'HOLD'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED_SUBMITTING'
  | 'SUBMITTED'
  | 'REJECTED_BY_USER'
  | 'BLOCKED_BY_RISK'
  | 'SUBMIT_FAILED'
  | 'SKIPPED'
export type LiveSignalLifecycleFilter = 'ALL' | LiveSignalLifecycleStatus
```

如果前端需要展示推导后的状态，可新增轻量字段类型而不改变 `QuantSignal` 原始结构：

```ts
export type LiveSignalHistoryItem = QuantSignal & {
  lifecycleStatus?: LiveSignalLifecycleStatus
  lifecycleReason?: string
}
```

### 2. `api/futu_bridge/live_history_db.py`

新增或扩展只读查询 action，用于服务端过滤并保证分页总数正确。

建议新增两个 action：

- `paginate_pending_order_lifecycle`
- `paginate_signal_lifecycle`

#### `paginate_pending_order_lifecycle`

输入：

- `page`
- `pageSize`
- `status`，可选，`ALL` 表示不过滤。

逻辑：

- 从 `live_events` 中读取 `kind IN ('pending_orders', 'rejected_orders')`。
- 以 `json_extract(payload, '$.id')` 作为订单 id。
- 对同一 id 取 `updatedAt/created_at/id` 最新记录。
- 若 `status !== 'ALL'`，按最新 payload 的 `status` 过滤。
- 返回 `SimulationHistoryPage<LivePendingOrder>` 格式。

#### `paginate_signal_lifecycle`

输入：

- `page`
- `pageSize`
- `direction`，可选，`ALL` 表示不过滤。
- `lifecycleStatus`，可选，`ALL` 表示不过滤。

逻辑：

- 以 `signals` 为主表。
- 交易方向直接用 `signals.side` 过滤。
- 对订单生命周期记录建立 `signalId -> latest order status` 映射：
  - `pending_orders/rejected_orders` 使用 `json_extract(payload, '$.intent.signalId')` 或 `json_extract(payload, '$.signal.id')`。
  - `submitted_orders` 使用 `json_extract(payload, '$.signalId')`。
- 对 skipped 记录建立 `signalId -> skipped reason` 映射。
- 对新数据优先使用精确 `signalId` 关联。
- 对旧 skipped 数据没有 `signalId` 的情况，用 ticker + 时间窗口兜底：
  - `skipped.ticker == signal.ticker`
  - `skipped.updatedAt >= signal.generatedAt`
  - `skipped.updatedAt - signal.generatedAt <= 10 秒`
- 为每条信号输出：
  - 原始 signal payload
  - `lifecycleStatus`
  - `lifecycleReason`，例如 skipped reason
- 根据 `lifecycleStatus` 过滤后再分页。

说明：

- 这部分可以先用 Python 读取候选集合后在内存中推导，再分页。当前本地 SQLite 数据量可控，且桥接已有 JSON 解析模式。
- 如果后续历史量明显变大，再把关联推导下沉为 SQL CTE 优化。

### 3. `api/live/livePersistence.ts`

新增方法：

- `paginatePendingOrderLifecycle(page, pageSize, statusFilter)`
- `paginateSignalLifecycle(page, pageSize, directionFilter, lifecycleFilter)`

调整现有 `paginatePendingOrderLifecycle`：

- 由 TypeScript 内存合并改为调用 Python bridge action。
- 保留 fallback 行为：如果 bridge 失败，返回空页，不回退到旧 `pending_orders`，避免显示已关闭订单为可确认状态。

### 4. `api/routes/liveTradingRoutes.ts`

扩展历史接口 query 参数：

#### `/api/live-trading/history/pending-orders`

新增：

- `status=ALL|PENDING_CONFIRMATION|CONFIRMED_SUBMITTING|SUBMITTED|REJECTED_BY_USER|SUBMIT_FAILED|BLOCKED_BY_RISK`

调用：

- `livePersistence.paginatePendingOrderLifecycle(page, pageSize, status)`

#### `/api/live-trading/history/signals`

新增：

- `direction=ALL|HOLD|BUY|SELL_SHORT|SELL_TO_CLOSE`
- `lifecycleStatus=ALL|HOLD|PENDING_CONFIRMATION|CONFIRMED_SUBMITTING|SUBMITTED|REJECTED_BY_USER|SUBMIT_FAILED|BLOCKED_BY_RISK|SKIPPED`

调用：

- `livePersistence.paginateSignalLifecycle(page, pageSize, direction, lifecycleStatus)`

非法筛选值处理：

- 后端归一化为 `ALL`，不返回 400，避免前端旧缓存或手动 URL 参数导致页面不可用。

### 5. `src/hooks/useLiveTrading.ts`

新增筛选状态：

- `pendingOrderStatusFilter`
- `signalDirectionFilter`
- `signalLifecycleFilter`

新增 refs：

- `historyFiltersRef`

调整 `loadHistory`：

- 根据 kind 拼接对应 query 参数。
- `signals` 带 `direction/lifecycleStatus`。
- `pending-orders` 带 `status`。

新增设置函数：

- `setPendingOrderStatusFilter(status)`
- `setSignalDirectionFilter(direction)`
- `setSignalLifecycleFilter(status)`

行为：

- 切换筛选时将对应 history page 重置为 1。
- `refreshAll()` 使用当前 filter refs，保证自动刷新和手动刷新不丢筛选条件。
- 翻页时保留当前筛选条件。

### 6. `src/pages/LiveTradingView.tsx`

#### 待确认订单队列 UI

在队列表头区域增加状态筛选控件：

- 建议使用一组高密度按钮/chip，而不是长 select。
- 选项：
  - 全部
  - 待确认
  - 提交中
  - 已提交
  - 已拒绝
  - 提交失败
  - 风控关闭

显示逻辑：

- `Badge` 显示当前页活跃 pending 数量仍可保留。
- 标题总数使用筛选后的 `pendingOrdersPage.total`。
- 已关闭状态继续展示状态标签，不显示确认按钮。

#### 历史策略信号 UI

在 `HistoryTable` 标题下增加两组筛选：

1. 信号状态：
   - 全部
   - 观望
   - 待确认
   - 提交中
   - 已提交
   - 已拒绝
   - 提交失败
   - 风控拦截

2. 交易方向：
   - 全部
   - 观望
   - 买入
   - 卖空
   - 平仓卖出

历史策略卡片中展示 lifecycle 状态：

- `HOLD`: 灰色 `观望`
- `PENDING_CONFIRMATION`: amber `待确认`
- `CONFIRMED_SUBMITTING`: cyan `提交中`
- `SUBMITTED`: emerald `已提交`
- `REJECTED_BY_USER`: slate `已拒绝`
- `SUBMIT_FAILED/BLOCKED_BY_RISK/SKIPPED`: red/amber 风险色

已有方向颜色保持：

- 开仓买入/卖空：红色
- 平仓卖出/平仓买入：绿色
- HOLD：灰色

### 7. 测试

#### 后端/持久化测试

扩展 `tests/liveTrading.test.ts` 或新增 `tests/liveTradingHistoryFilters.test.ts`：

覆盖：

- pending lifecycle 合并后，同一订单最新 `REJECTED_BY_USER` 能覆盖旧 `PENDING_CONFIRMATION`。
- pending status filter = `REJECTED_BY_USER` 只返回已拒绝。
- pending status filter = `PENDING_CONFIRMATION` 不返回已拒绝。
- signal direction filter = `BUY` 只返回 BUY。
- signal lifecycle filter = `HOLD` 只返回 HOLD。
- signal lifecycle filter = `SKIPPED` 能返回被 skipped 关联的非 HOLD 信号。
- signal lifecycle filter = `REJECTED_BY_USER` 能通过订单关联返回对应信号。

#### 类型/全量验证

执行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
```

#### 手工验收

1. 打开 `/live-trading`。
2. 在待确认订单队列选择 `已拒绝`，能看到 TSM 这类已拒绝记录，且操作列显示 `已拒绝`，没有“确认弹窗”按钮。
3. 在待确认订单队列选择 `待确认`，不应出现已拒绝订单。
4. 在历史策略信号选择交易方向 `BUY`，只展示买入相关信号。
5. 在历史策略信号选择生命周期 `风控拦截`，能看到 AAPL 这类“未进入待确认队列”的信号。
6. 切换筛选后页码回到第 1 页。
7. 点击“刷新当前页”或等待 30 秒自动刷新后，筛选条件不丢失。

## Assumptions & Constraints

- 筛选范围仅针对实盘页面 `/live-trading`，不影响模拟盘。
- 本计划不改 Futu REAL 下单流程、不改人工确认门禁、不改交易风控阈值。
- 本计划不改变 SQLite 表结构，只新增查询逻辑和 JSON payload 推导。
- 历史信号生命周期状态是“后端推导状态”，不是修改原始 `QuantSignal.side`。
- 对旧数据缺少 `signalId` 的 skipped 记录，使用当前已有的 ticker + 10 秒时间窗口兜底。

## Verification Steps

实现完成后必须验证：

1. `npm run check` 通过。
2. `npm test` 通过。
3. `/api/live-trading/history/pending-orders?status=REJECTED_BY_USER&page=1&pageSize=12` 返回已拒绝订单，且不包含待确认订单。
4. `/api/live-trading/history/pending-orders?status=PENDING_CONFIRMATION&page=1&pageSize=12` 不返回已拒绝订单。
5. `/api/live-trading/history/signals?direction=BUY&lifecycleStatus=ALL&page=1&pageSize=12` 只返回 BUY 信号。
6. `/api/live-trading/history/signals?direction=ALL&lifecycleStatus=SKIPPED&page=1&pageSize=12` 返回硬风控/未入队信号。
7. 前端筛选、翻页、刷新行为一致，筛选总数和页数正确。
