# Futu 模拟盘订单状态展示计划

## Summary

本计划澄清并修正模拟盘历史数据边界：

- SQLite 仅保存本系统生成的历史策略信号、历史模拟订单提交结果和大模型决策快照。
- Futu 模拟盘订单是外部交易系统的状态数据，应以 Futu OpenD 接口查询为准，不写入 SQLite 归档。
- 页面需要新增“Futu 订单状态”展示能力，默认查询近 7 天历史订单，并支持分页。
- 现有“历史模拟订单”表继续展示本系统提交记录和大模型决策结果，新增 Futu 订单表展示真实订单状态、成交数量、成交均价、更新时间等。

## Current State Analysis

### SQLite 持久化现状

- `api/simulation/simulationPersistence.ts`
  - 当前已切换为 SQLite 单文件数据库 `.data/simulation-history.sqlite3`。
  - 保存类型为 `SimulationHistoryKind = 'signals' | 'orders' | 'skipped'`。
  - `orders` 保存的是 `SimulatedOrderResult`，即本系统调用 Futu 下单桥后的提交结果和 `llmDecision` 快照。
  - 这符合用户确认的边界：SQLite 保存历史策略信号和大模型决策/提交结果。

- `api/futu_bridge/simulation_history_db.py`
  - 使用 Python 标准库 `sqlite3`。
  - 提供 append、read_latest、paginate、clear、migrate_jsonl。
  - 不应扩展为 Futu 订单状态归档，避免把外部订单状态复制为不可靠的二手数据。

### Futu 下单现状

- `api/futu_bridge/futu_sim_order.py`
  - 使用 `OpenSecTradeContext.place_order(...)` 提交 Futu SIMULATE 订单。
  - 返回字段包含 `orderId`、`ticker`、`side`、`quantity`、`orderType`、`orderSession`、`limitPrice`、`submittedAt`、`rawResponse`。
  - 只代表提交当下的结果，不代表之后订单状态。

### Futu 订单查询能力

通过只读环境探查确认 Futu Python SDK 支持：

- `OpenSecTradeContext.order_list_query(order_id='', status_filter_list=[], code='', start='', end='', trd_env='REAL', acc_id=0, acc_index=0, refresh_cache=False, order_market='N/A')`
- `OpenSecTradeContext.history_order_list_query(status_filter_list=[], code='', start='', end='', trd_env='REAL', acc_id=0, acc_index=0, order_market='N/A')`

实现时应使用：

- `trd_env=TrdEnv.SIMULATE`
- 当前模拟账户 `accountId`
- 美股市场 `TrdMarket.US`
- 默认查询近 7 天历史订单

### 页面现状

- `src/pages/SimulationTradingView.tsx`
  - 当前展示：
    - 历史策略信号
    - 历史模拟订单
    - 历史跳过原因与错误日志
  - 历史模拟订单来自 SQLite 分页 API `/api/simulation/history/orders`。
  - 尚未展示 Futu OpenD 实时订单状态。

- `src/hooks/useSimulationTrading.ts`
  - 当前加载 dashboard 和 SQLite 历史分页。
  - 需要新增 Futu 订单分页状态加载。

## Proposed Changes

### 1. 明确类型边界

文件：`shared/types.ts`

新增类型：

- `FutuSimulationOrder`
  - `orderId: string`
  - `ticker: string`
  - `code: string`
  - `side: string`
  - `orderType: string`
  - `orderStatus: string`
  - `orderStatusLabel: string`
  - `quantity: string`
  - `filledQuantity: string`
  - `remainingQuantity: string`
  - `price: string`
  - `filledAveragePrice: string`
  - `createTime: string`
  - `updatedTime: string`
  - `dealtAmount: string`
  - `currency: string`
  - `remark: string`
  - `rawResponse?: unknown`

- `FutuSimulationOrdersResponse`
  - `ok: boolean`
  - `orders: FutuSimulationOrder[]`
  - `page: number`
  - `pageSize: number`
  - `total: number`
  - `totalPages: number`
  - `startDate: string`
  - `endDate: string`
  - `accountId: string`
  - `warnings: string[]`

说明：

- 这些类型不进入 `SimulationHistoryKind`。
- SQLite 历史 `orders` 仍代表本系统提交结果；Futu 订单状态走独立接口。

### 2. 新增 Futu 订单查询桥接

新增文件：`api/futu_bridge/futu_sim_orders.py`

行为：

- 输入：
  - `host`
  - `port`
  - `accountId`
  - `page`
  - `pageSize`
  - `startDate`
  - `endDate`
  - 可选 `ticker`
- 使用 `OpenSecTradeContext(filter_trdmarket=TrdMarket.US, host=..., port=..., ai_type=1)`。
- 使用 `history_order_list_query(...)` 查询近 7 天历史订单：
  - `trd_env=TrdEnv.SIMULATE`
  - `acc_id=int(accountId)`
  - `start=startDate`
  - `end=endDate`
  - 如果传入 `ticker`，则 `code=US.{ticker}`
- 对返回 DataFrame 做字段归一化。
- 在 Python 内完成分页：
  - 先按更新时间/创建时间倒序排序。
  - 再做 `LIMIT/OFFSET` 等价切片。
- 失败时返回 `ok: false`、空数组和 warning，不影响 dashboard。

字段兼容策略：

- Futu DataFrame 字段名可能随版本不同，使用 `row.get(...)` 多候选读取。
- 关键候选：
  - 订单号：`order_id` / `orderID`
  - 股票代码：`code`
  - 方向：`trd_side`
  - 状态：`order_status`
  - 类型：`order_type`
  - 数量：`qty`
  - 成交数量：`dealt_qty`
  - 剩余数量：`qty - dealt_qty`
  - 价格：`price`
  - 成交均价：`dealt_avg_price`
  - 创建时间：`create_time`
  - 更新时间：`updated_time` / `update_time`
  - 成交金额：`dealt_amount`
  - 备注：`remark`

状态中文化：

- `SUBMITTED` / `WAITING_SUBMIT`：已提交
- `SUBMITTING`：提交中
- `FILLED_ALL`：全部成交
- `FILLED_PART`：部分成交
- `CANCELLED_ALL` / `CANCELLED_PART`：已撤单
- `FAILED` / `SUBMIT_FAILED`：失败
- 其他状态保留原始值。

### 3. 新增服务层

新增文件：`api/simulation/futuSimulationOrderService.ts`

职责：

- 调用 `loadSimulationAccountDashboard()` 获取默认模拟账户，或接收指定 `accountId`。
- 计算默认日期范围：
  - `endDate = 今日 UTC/本地日期`
  - `startDate = endDate - 7 天`
- 调用 `runPythonBridge<FutuSimulationOrdersResponse>('futu_sim_orders.py', payload)`。
- 参数归一化：
  - `page >= 1`
  - `1 <= pageSize <= 100`
  - `ticker` 转大写并仅允许用户股票池内标的时才传入，避免误查询。
- 返回 Futu 订单分页响应。

注意：

- 不写 SQLite。
- 不把 Futu 订单合并进 `SimulationDashboardResponse`，避免 dashboard 轮询变重。

### 4. 新增 API

修改文件：`api/routes/simulationRoutes.ts`

新增接口：

- `GET /api/simulation/futu-orders?page=1&pageSize=12`
- 支持可选参数：
  - `startDate=YYYY-MM-DD`
  - `endDate=YYYY-MM-DD`
  - `ticker=SPCX`

返回：

- `FutuSimulationOrdersResponse`

保留现有接口：

- `/api/simulation/history/orders`
  - 继续代表本系统历史模拟订单/大模型决策结果。

命名说明：

- 页面上将两个表明确区分：
  - “历史模拟订单（大模型决策）”
  - “Futu 订单状态（接口实时查询）”

### 5. 前端 Hook 支持 Futu 订单分页

修改文件：`src/hooks/useSimulationTrading.ts`

新增状态：

- `futuOrders?: FutuSimulationOrdersResponse`

新增方法：

- `loadFutuOrders(page = 1, pageSize = 12)`

刷新策略：

- `refreshAll()` 除了 dashboard 和 SQLite 历史分页，也加载当前页 Futu 订单。
- 保持当前 3 秒刷新节奏，但 Futu 订单接口可考虑与 dashboard 分离：
  - 初版：一起刷新，用户可实时看到状态变化。
  - 如后续发现 OpenD 压力较大，再改为 10 秒刷新。

### 6. 页面新增 Futu 订单状态表

修改文件：`src/pages/SimulationTradingView.tsx`

新增一个独立 `TablePanel`：

- 标题：
  - 中文：`Futu 订单状态`
  - 英文：`Futu Order Status`

列：

- 标的
- 方向
- 订单类型
- 状态
- 数量
- 已成交
- 剩余
- 委托价
- 成交均价
- 创建时间
- 更新时间
- 备注

分页：

- 使用 `futuOrders.page / totalPages / total`
- 上一页/下一页触发 `loadFutuOrders(page)`

视觉顺序：

1. 账户与引擎状态
2. 持仓
3. Futu 订单状态（真实接口状态，优先展示）
4. 历史策略信号
5. 历史模拟订单（大模型决策/提交快照）
6. 历史跳过原因与错误日志

原因：

- 订单状态具有实时性，应放在系统历史快照之前。

### 7. 测试与验证

新增/修改测试：

- 新增 `tests/futuSimulationOrders.test.ts`
  - 测试服务参数归一化可通过纯函数抽出。
  - 测试分页参数 clamp。
  - 测试默认日期范围为近 7 天。

- 更新现有测试如有类型变更：
  - `tests/simulationPersistence.test.ts`
  - `tests/simulationStore.test.ts`

手工/API 冒烟：

- `GET /api/simulation/futu-orders?page=1&pageSize=5`
- 确认返回：
  - `ok`
  - `orders`
  - `page`
  - `pageSize`
  - `total`
  - `totalPages`
  - `startDate`
  - `endDate`

验证命令：

- `python3 -m py_compile api/futu_bridge/futu_sim_orders.py`
- `npm run check`
- `npm test`
- `npm run build`

## Assumptions & Decisions

- 已确认：SQLite 只保存系统生成的历史策略信号、历史模拟订单提交结果和大模型决策快照。
- 已确认：Futu 订单数据不写入 SQLite，以接口为准。
- 已确认：Futu 订单默认展示近 7 天历史，并支持分页。
- Futu 订单状态表应与“历史模拟订单（大模型决策）”分开，避免把提交快照和真实订单状态混淆。
- 初版不做订单详情弹窗，不做按状态筛选；只保留可选 `ticker/startDate/endDate` API 能力，为后续 UI 筛选预留。
- 如果 Futu OpenD 返回字段名与当前候选不完全一致，桥接脚本会通过 `rawResponse` 暴露原始行，便于快速补字段映射。

## Verification Steps

1. 运行 Python 编译：
   - `python3 -m py_compile api/futu_bridge/futu_sim_orders.py`
2. 运行类型检查：
   - `npm run check`
3. 运行测试：
   - `npm test`
4. 运行构建：
   - `npm run build`
5. 启动服务后访问：
   - `GET /api/simulation/futu-orders?page=1&pageSize=5`
6. 打开 `/simulation`：
   - 确认页面出现“Futu 订单状态”表。
   - 确认“历史模拟订单（大模型决策）”仍显示 SQLite 中的系统提交结果。
   - 确认 Futu 订单状态有分页，并显示状态字段。
