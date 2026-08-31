# 订单价格类型展示调整计划

## Summary

本次调整目标是修正模拟盘页面中订单价格与订单类型的展示方式。代码检查确认：当前真实下单逻辑确实会根据交易时段和持仓场景选择不同订单类型，尤其是 RTH 盘中空头回补使用 `MARKET` 市价单，盘前/盘后 ETH 使用 `MARKETABLE_LIMIT` 主动限价单。因此页面不应把“订单类型”和“价格”割裂展示，而应在价格单元格中直接注明订单类型，例如 `$100.00（主动限价）`、`市价`、`$100.00（限价）`。

## Current State Analysis

### 已确认的交易逻辑

- `api/simulation/simulationTradingEngine.ts`
  - `selectOrderTypeForDecision(...)` 当前规则：
    - `BUY` 且当前持仓为负数，并且 `orderSession === 'RTH'` 时返回 `MARKET`。
    - 其他真实可提交订单返回 `MARKETABLE_LIMIT`。
  - `orderSessionForMarket(...)` 当前规则：
    - `MORNING` / `AFTERNOON` / `AUCTION` / `TRADE_AT_LAST` 映射为 `RTH`。
    - `PRE_MARKET_BEGIN` / `PRE_MARKET_END` / `AFTER_HOURS_BEGIN` / `AFTER_HOURS_END` 映射为 `ETH`。
    - 夜盘和休市返回 `undefined`，当前模拟盘下单会跳过。
  - `marketableLimitPrice(...)` 会基于盘口加减滑点生成主动限价价格。

- `api/futu_bridge/futu_sim_order.py`
  - `MARKET` 会真正传给 Futu `OrderType.MARKET`，并且 `price=0`。
  - 非 `MARKET` 订单会传 `OrderType.NORMAL` 和 `limitPrice`。
  - 校验明确限制：
    - `MARKET` 只允许 `RTH`。
    - `MARKET` 只允许 `BUY`，用于空头回补场景。
    - `ETH` 必须使用非市价单。

### 当前页面展示问题

- `src/pages/SimulationTradingView.tsx`
  - `Futu 订单状态` 当前列为：`订单类型` 与 `委托价` 分开展示。
  - `历史模拟订单（大模型决策）` 当前列为：`订单类型`、`交易时段`、`限价` 分开展示。
  - `displayOrderType(...)` 已能显示 `市价` / `主动限价` / `限价`，但没有和价格绑定在同一个单元格。

当前展示会让用户在快速扫表时误以为“价格”和“订单类型”是两个独立维度，尤其在市价单时 `limitPrice` 可能显示 `MARKET`，而价格列名仍叫“限价”，语义不够准确。

## Proposed Changes

### 1. 调整历史模拟订单表格展示

文件：`src/pages/SimulationTradingView.tsx`

变更：

- 将 `历史模拟订单（大模型决策）` 的表头从：
  - 中文：`['标的', '方向', '数量', '订单类型', '交易时段', '限价', '模型确认', '状态']`
  - 英文：`['Ticker', 'Side', 'Qty', 'Order Type', 'Session', 'Limit', 'LLM Review', 'Status']`
- 调整为：
  - 中文：`['标的', '方向', '数量', '交易时段', '委托价', '模型确认', '状态']`
  - 英文：`['Ticker', 'Side', 'Qty', 'Session', 'Order Price', 'LLM Review', 'Status']`

行数据调整：

- 移除独立 `displayOrderType(order.orderType, language)` 单元格。
- 将原 `order.limitPrice` 替换为新的格式化函数输出：
  - `MARKET`：中文显示 `市价`，英文显示 `Market`。
  - `MARKETABLE_LIMIT`：中文显示 `$100.00（主动限价）`，英文显示 `$100.00 (Marketable Limit)`。
  - `LIMIT`：中文显示 `$100.00（限价）`，英文显示 `$100.00 (Limit)`。
  - 其他未知类型：中文显示 `$100.00（UNKNOWN）` 或 `UNKNOWN`，英文同理保留原始类型，避免隐藏异常数据。

原因：

- 用户已确认期望采用“价格列注明”方案。
- 价格和订单类型在交易语义上强相关，绑定展示更符合快速审阅大模型决策结果的需求。

### 2. 调整 Futu 订单状态表格展示

文件：`src/pages/SimulationTradingView.tsx`

变更：

- 将 `Futu 订单状态` 的表头从：
  - 中文：`['标的', '方向', '订单类型', '状态', '数量', '已成交', '剩余', '委托价', '成交均价', '创建时间', '更新时间', '备注']`
  - 英文：`['Ticker', 'Side', 'Type', 'Status', 'Qty', 'Filled', 'Remaining', 'Price', 'Avg Fill', 'Created', 'Updated', 'Remark']`
- 调整为：
  - 中文：`['标的', '方向', '状态', '数量', '已成交', '剩余', '委托价', '成交均价', '创建时间', '更新时间', '备注']`
  - 英文：`['Ticker', 'Side', 'Status', 'Qty', 'Filled', 'Remaining', 'Order Price', 'Avg Fill', 'Created', 'Updated', 'Remark']`

行数据调整：

- 移除独立订单类型单元格。
- 将原 `order.price` 替换为价格+类型格式：
  - `MARKET`：`市价` / `Market`。
  - `LIMIT`：`价格（限价）` / `Price (Limit)`。
  - `MARKETABLE_LIMIT`：`价格（主动限价）` / `Price (Marketable Limit)`。
  - 未知类型：保留类型原值放入括号。

原因：

- Futu 真实订单状态与历史模拟订单应保持一致的价格类型展示模式。
- 不改变任何订单状态来源，仍然以 OpenD 实时接口为准，不写入 SQLite。

### 3. 新增展示格式化函数

文件：`src/pages/SimulationTradingView.tsx`

新增函数：

- `displayOrderPriceWithType(price: string, orderType: string | undefined, language: 'zh' | 'en'): string`

规则：

- 若 `orderType === 'MARKET'`，直接返回 `市价` / `Market`。
- 若 `price` 为空、`unavailable` 或 `MARKET`：
  - 非市价未知场景下返回 `unavailable（类型）` 或 `unavailable (Type)`，不伪造价格。
- 若 `orderType` 可识别，返回 `价格（类型）`。
- 若 `orderType` 不可识别但存在，返回 `价格（原始类型）`。
- 若没有 `orderType`，仅返回 `price`。

保留现有：

- `displayOrderType(...)` 可暂时保留，因为其他位置或后续页面仍可能复用；如确认无引用，可在实现时删除，但不作为本计划必要项。
- `displayOrderSession(...)` 保留，继续展示 `盘中` / `盘前/盘后`。

### 4. 测试覆盖

文件：

- `tests/llmAutonomousTrading.test.ts`

现有覆盖已确认：

- ETH 空头回补不会使用市价单。
- RTH 空头回补使用市价单。

计划补充或保留验证：

- 若实现只改展示，可优先依赖 `tsc --noEmit`。
- 若需要更稳妥，可把价格类型格式化函数抽出为命名导出或独立纯函数文件，并增加单测覆盖：
  - `MARKET + MARKET` => `市价`
  - `$100.00 + MARKETABLE_LIMIT` => `$100.00（主动限价）`
  - `$100.00 + LIMIT` => `$100.00（限价）`
  - `$100.00 + UNKNOWN` => `$100.00（UNKNOWN）`

为了控制改动范围，默认不拆新文件，除非实现过程中发现当前页面函数难以测试。

## Assumptions & Decisions

- 已根据用户确认，采用“价格列注明”方案。
- 本次不修改订单类型选择逻辑。
- 本次不修改 Python 下单桥接。
- 本次不修改 SQLite 历史存储结构。
- 本次不改变 Futu 订单状态数据来源。
- 市价单展示为 `市价` / `Market`，不再显示 `MARKET（市价）`，因为市价单没有有效委托价。
- 主动限价单展示为 `价格（主动限价）`，明确区别于普通 `LIMIT`。
- 历史策略信号表格中的 `限价` 是模型建议价格，不是最终下单类型，本次不动，避免把“信号建议价”和“实际委托类型”混淆。

## Verification Steps

1. 运行 TypeScript 类型检查：

   ```bash
   PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/tsc --noEmit
   ```

2. 运行相关测试：

   ```bash
   PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/vitest run tests/llmAutonomousTrading.test.ts tests/realtimeStore.test.ts
   ```

3. 页面人工验收：

   - 打开 `http://localhost:5173/simulation`。
   - 检查 `历史模拟订单（大模型决策）`：
     - 不再有独立 `订单类型` 列。
     - `委托价` 列显示 `市价` 或 `$价格（主动限价）`。
   - 检查 `Futu 订单状态`：
     - 不再有独立 `订单类型` 列。
     - `委托价` 列显示价格与类型。
   - 确认历史策略信号表格未被误改。

