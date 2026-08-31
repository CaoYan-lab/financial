# 历史模拟订单与 Futu 订单联动详情页计划

## Summary

为模拟盘页面新增两个仅由列表行点击进入的独立详情路由：

- 从“历史模拟订单（大模型决策）”某一行点击进入详情页，展示该历史模拟订单本身、关联的历史策略信号、关联的 Futu 订单状态。
- 从“Futu 订单状态”某一行点击进入详情页，展示该 Futu 订单状态本身，并回溯关联的历史模拟订单和历史策略信号。

不在导航栏、按钮区、历史策略信号列表或其他位置增加入口。历史策略信号列表保持不可点击。

## Current State Analysis

### 前端现状

- 主页面为 `src/pages/SimulationTradingView.tsx`，路由在 `src/App.tsx` 中只有 `/simulation` 指向该页面。
- “Futu 订单状态”“历史策略信号”“历史模拟订单（大模型决策）”都通过同一个 `TablePanel` 展示。
- `TablePanel` 当前只接收 `headers: string[]` 和 `rows: string[][]`，没有行点击能力。
- “历史模拟订单”当前展示字段不包含内部历史事件 ID，也不显示 `signalId`。
- “Futu 订单状态”当前来自 `futuOrders.orders`，展示的是 Futu API 返回的订单状态，不包含明确的 `signalId` 字段。
- 上一轮已修复后续新订单 `signalId` 复用策略信号 `signal.id`；但已有历史数据存在旧问题：历史订单 `signalId` 可能与策略信号 `id` 有几十毫秒差异。

### 后端与数据现状

- 历史模拟订单、历史策略信号、跳过日志存储在 SQLite 表 `simulation_events`，由 `api/futu_bridge/simulation_history_db.py` 管理。
- `simulation_events` 表包含自增 `id`、`kind`、`ticker`、`side`、`strategy`、`created_at`、`payload`。
- `api/simulation/simulationPersistence.ts` 当前只提供分页和最新读取，没有按事件 ID、订单 ID、策略信号 ID 查询单条详情的接口。
- `api/routes/simulationRoutes.ts` 当前有：
  - `GET /api/simulation/history/signals`
  - `GET /api/simulation/history/orders`
  - `GET /api/simulation/futu-orders`
- Futu 下单桥 `api/futu_bridge/futu_sim_order.py` 下单时把 `signalId` 写入本地历史订单 payload，并尝试写入 Futu remark：`FinancialWorkbench SIM {strategy} {signal_id}`。由于 remark 长度限制，不能依赖 remark 完整反查。
- Futu 订单状态桥 `api/futu_bridge/futu_sim_orders.py` 能返回 `orderId`、`ticker`、`createTime`、`updatedTime`、`remark`、`rawResponse`。

### 可用关联关系

- 历史模拟订单 → 历史策略信号：
  - 首选：`SimulatedOrderResult.signalId === QuantSignal.id`
  - 兼容旧数据：若精确匹配失败，用同 `ticker + side` 且时间接近的策略信号做 fallback。时间窗口建议 `±5 秒`，优先选择 `generatedAt <= submittedAt` 且距离最近的信号。
- 历史模拟订单 → Futu 订单状态：
  - 首选：`SimulatedOrderResult.orderId === FutuSimulationOrder.orderId`
  - 对 `blocked-by-risk`、`unavailable`、失败订单，不查询 Futu 状态，详情页显示“无 Futu 真实订单”。
- Futu 订单状态 → 历史模拟订单：
  - 首选：`FutuSimulationOrder.orderId === SimulatedOrderResult.orderId`
  - 找不到时显示 Futu 订单详情，并标记“未找到关联历史模拟订单，可能是手动订单、旧数据缺失或非本系统提交订单”。

## Proposed Changes

### 1. 扩展历史持久化查询能力

文件：`api/futu_bridge/simulation_history_db.py`

新增只读 action：

- `get_event_by_id`
  - 入参：`kind`, `id`
  - 返回：`item`，将 SQLite 自增 `id` 注入为 `historyId`
- `find_event_by_payload_field`
  - 入参：`kind`, `field`, `value`
  - 允许字段白名单：`id`, `orderId`, `signalId`
  - 使用 `json_extract(payload, '$.<field>') = ?` 查询
  - 返回最新一条匹配结果，并注入 `historyId`
- `find_nearest_signal`
  - 入参：`ticker`, `side`, `submittedAt`, `secondsWindow`
  - 查询 `kind='signals'`、同 ticker、同 side、`created_at` 在时间窗口内的记录
  - 按时间距离排序，优先 `created_at <= submittedAt`，返回最接近的一条，并注入 `historyId`

同时调整现有 `read_latest` 和 `paginate`：

- SELECT `id, payload` 而不是只 SELECT `payload`
- 返回 items 时给每条 payload 注入 `historyId`
- 不改变原始 `payload` 存储内容，不做数据库迁移

### 2. 扩展 TypeScript 类型

文件：`shared/types.ts`

新增可选字段：

- `QuantSignal.historyId?: number`
- `SimulatedOrderResult.historyId?: number`

新增详情响应类型：

```ts
export type SimulationLinkedOrderDetailResponse = {
  ok: boolean
  source: 'history-order' | 'futu-order'
  historyOrder?: SimulatedOrderResult
  signal?: QuantSignal
  futuOrder?: FutuSimulationOrder
  warnings: string[]
}
```

说明：

- `historyId` 是 SQLite 查询返回时注入的展示/路由字段，不要求落入 payload。
- `signal` 可缺失，用于兼容旧数据或手动 Futu 订单。
- `futuOrder` 可缺失，用于风险拦截订单、桥接失败订单、Futu 查询不可用场景。

### 3. 在 persistence service 增加详情查询方法

文件：`api/simulation/simulationPersistence.ts`

新增方法：

- `getOrderByHistoryId(historyId: number): SimulatedOrderResult | undefined`
- `getSignalByHistoryId(historyId: number): QuantSignal | undefined`
- `findOrderByOrderId(orderId: string): SimulatedOrderResult | undefined`
- `findSignalById(signalId: string): QuantSignal | undefined`
- `findNearestSignalForOrder(order: SimulatedOrderResult): QuantSignal | undefined`

实现规则：

- 所有方法都通过 SQLite bridge 的新增 action 查询。
- `findNearestSignalForOrder` 只在 `findSignalById(order.signalId)` 失败时使用。
- fallback 时间窗口固定为 `5` 秒，避免错误关联较远轮次。
- 对 `orderId` 为 `blocked-by-risk` 或 `unavailable` 的订单不使用 `findOrderByOrderId` 做唯一定位，历史订单详情入口必须使用 `historyId`。

### 4. 新增后端详情接口

文件：`api/routes/simulationRoutes.ts`

新增两个接口：

#### `GET /api/simulation/history/orders/:historyId/detail`

用途：历史模拟订单行点击后的详情接口。

数据流：

1. 用 `historyId` 查历史模拟订单。
2. 用 `order.signalId` 精确查历史策略信号。
3. 若精确查不到，使用 `ticker + side + submittedAt ±5 秒` fallback 查最近策略信号，并在 warnings 中说明使用了 fallback。
4. 若 `order.ok === true` 且 `order.orderId` 不是 `blocked-by-risk/unavailable`，调用 `loadFutuSimulationOrders`：
   - `ticker = order.ticker`
   - 日期范围取 `submittedAt` 当天前后各 1 天
   - `pageSize = 100`
   - 在返回 orders 中按 `orderId` 精确匹配 Futu 状态
5. 返回 `SimulationLinkedOrderDetailResponse`。

#### `GET /api/simulation/futu-orders/:orderId/detail`

用途：Futu 订单状态行点击后的详情接口。

查询参数：

- `ticker?: string`
- `startDate?: string`
- `endDate?: string`

数据流：

1. 调用 `loadFutuSimulationOrders` 查询 Futu 订单状态，优先使用传入的 `ticker/startDate/endDate` 缩小范围。
2. 在返回 orders 中按 `orderId` 精确匹配 Futu 订单。
3. 用 `orderId` 查历史模拟订单。
4. 若找到历史模拟订单，再用 `signalId` 查历史策略信号；精确失败则走 `findNearestSignalForOrder` fallback。
5. 找不到历史模拟订单时仍返回 Futu 订单，并在 warnings 中说明未找到本系统历史决策。

### 5. 新增前端详情页

新增文件：`src/pages/SimulationOrderDetailView.tsx`

路由模式：

- `/simulation/orders/:historyId`
- `/simulation/futu-orders/:orderId`

页面行为：

- 通过 `useParams` 判断是历史订单详情还是 Futu 订单详情。
- 历史订单详情调用 `/api/simulation/history/orders/:historyId/detail`。
- Futu 订单详情调用 `/api/simulation/futu-orders/:orderId/detail`，并从 `location.state` 或 URL query 带上 `ticker/startDate/endDate` 用于缩小 Futu 查询范围。
- 页面包含返回入口：返回 `/simulation`。这不是新业务入口，只是详情页返回。

展示结构：

- 顶部摘要：
  - 标的、方向、数量、订单状态、模型、提交时间、Futu orderId
- 卡片 1：历史模拟订单（大模型决策）
  - `historyId`
  - `orderId`
  - `signalId`
  - `side`
  - `quantity`
  - `orderType`
  - `orderSession`
  - `limitPrice`
  - `submittedAt`
  - `ok/error`
  - `llmDecision.approved`
  - `llmDecision.reason`
  - `llmDecision.riskAssessment`
- 卡片 2：历史策略信号
  - `historyId`
  - `id`
  - `ticker`
  - `model/modelLabel`
  - `side`
  - `confidence`
  - `quantity`
  - `limitPrice`
  - `reason`
  - `riskAssessment`
  - `dataWindow`
  - `rawModelOutput` 只做折叠展示或小字号展示，避免撑爆页面
- 卡片 3：Futu 订单状态
  - `orderId`
  - `ticker/code`
  - `side`
  - `orderStatus/orderStatusLabel`
  - `quantity`
  - `filledQuantity`
  - `remainingQuantity`
  - `price`
  - `filledAveragePrice`
  - `dealtAmount`
  - `createTime`
  - `updatedTime`
  - `remark`
  - `rawResponse` 折叠展示
- warnings 区域：
  - 展示未找到关联历史信号、未找到 Futu 状态、使用 legacy fallback 等情况。

### 6. 更新路由

文件：`src/App.tsx`

新增路由：

- `<Route path="/simulation/orders/:historyId" element={<SimulationOrderDetailView />} />`
- `<Route path="/simulation/futu-orders/:orderId" element={<SimulationOrderDetailView />} />`

不新增导航入口。

### 7. 让指定两张表的行可点击

文件：`src/pages/SimulationTradingView.tsx`

改动：

- 引入 `useNavigate`。
- `TablePanel` 增加可选参数：
  - `onRowClick?: (rowIndex: number) => void`
  - `clickableRows?: boolean`
- 只有传入 `onRowClick` 的表格行使用 `cursor-pointer`、hover 背景和键盘可访问属性。
- “Futu 订单状态”传入 `onRowClick`：
  - 点击第 `rowIndex` 行，读取 `futuOrders.orders[rowIndex]`
  - 跳转 `/simulation/futu-orders/${encodeURIComponent(order.orderId)}`
  - 通过 `state` 带上 `ticker/startDate/endDate`
- “历史模拟订单（大模型决策）”传入 `onRowClick`：
  - 点击第 `rowIndex` 行，读取 `history.orders?.items ?? data?.latestOrders ?? []`
  - 若该 order 有 `historyId`，跳转 `/simulation/orders/${order.historyId}`
  - 若是内存最新订单还没有 `historyId`，则先不跳转，并在当前页面显示错误提示“该订单尚未完成历史落库，请刷新后重试”
- “历史策略信号”不传 `onRowClick`，保持不可点击。

### 8. 抽取展示格式化函数

新增文件：`src/utils/simulationDisplay.ts`

移动或复制以下纯展示函数，供列表页和详情页复用：

- `displaySide`
- `displaySignalModel`
- `displayOrderType`
- `displayOrderPriceWithType`
- `displayOrderSession`

`SimulationTradingView.tsx` 改为从该文件导入，减少详情页重复逻辑。

### 9. 测试与兼容

更新或新增测试：

- `tests/simulationPersistence.test.ts`
  - 验证分页返回 items 注入 `historyId`
  - 验证按历史事件 ID 查询订单
  - 验证按 payload `orderId` 查询订单
  - 验证按 payload `id` 查询策略信号
  - 验证 legacy fallback 能根据 `ticker + side + submittedAt` 找到时间接近信号
- 可新增 `tests/simulationDetailRoutes.test.ts` 或在现有路由测试中覆盖：
  - 历史订单详情返回 order + signal
  - Futu orderId 找不到历史订单时返回 warning

验证命令：

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/tsc --noEmit
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/vitest run tests/simulationPersistence.test.ts tests/simulationStore.test.ts tests/llmRuntimeConfig.test.ts tests/llmAutonomousTrading.test.ts
```

若本地服务正在运行，手工验证：

1. 打开 `/simulation`
2. 点击“历史模拟订单（大模型决策）”任意一行
3. 确认进入 `/simulation/orders/:historyId`
4. 确认展示历史模拟订单、历史策略信号、Futu 订单状态三块内容
5. 返回 `/simulation`
6. 点击“Futu 订单状态”任意一行
7. 确认进入 `/simulation/futu-orders/:orderId`
8. 确认可回溯历史模拟订单和历史策略信号；若该 Futu 订单非本系统提交，则显示明确 warning
9. 确认“历史策略信号”列表行不可点击

## Assumptions & Decisions

- 详情采用独立路由，不采用抽屉或弹窗。
- 入口只来自两张表的行点击：
  - “历史模拟订单（大模型决策）”
  - “Futu 订单状态”
- 不给“历史策略信号”列表增加点击入口。
- 不做数据库迁移，不改写旧 payload。
- 通过查询返回时注入 `historyId` 解决历史事件定位问题，特别是 `blocked-by-risk` 这类非唯一 `orderId`。
- Futu 订单状态回溯历史模拟订单首选 `orderId` 精确匹配，不依赖 Futu remark，因为 remark 长度可能截断 `signalId`。
- 旧历史订单 `signalId` 与信号 `id` 不一致时，允许使用 `ticker + side + submittedAt ±5 秒` fallback，但详情页必须显示 warning，避免误以为是精确关联。
- 外部手动 Futu 订单、旧数据缺失、Futu 查询不可用时，详情页不报错崩溃，展示已有部分并给出 warning。

## Verification Steps

1. 类型检查通过：

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/tsc --noEmit
```

2. 单测通过：

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/vitest run tests/simulationPersistence.test.ts tests/simulationStore.test.ts tests/llmRuntimeConfig.test.ts tests/llmAutonomousTrading.test.ts
```

3. API 验证：

```bash
curl -s 'http://localhost:3001/api/simulation/history/orders/1682/detail'
curl -s 'http://localhost:3001/api/simulation/futu-orders/7862513/detail?ticker=SPCX'
```

预期：

- 第一个接口能返回历史模拟订单、历史策略信号和 Futu 状态。
- 第二个接口能通过 Futu orderId 回溯历史模拟订单和策略信号。

4. UI 验证：

- 两张指定列表行可点击。
- 历史策略信号列表不可点击。
- 详情页刷新后仍能通过 URL 重新加载。
- 详情页无新增导航入口。
