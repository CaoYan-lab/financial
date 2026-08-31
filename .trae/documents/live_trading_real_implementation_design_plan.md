# 真实操作盘 Coding 任务设计文档

## Summary

本设计用于把当前“实盘交易入口”从仅订单预览升级为真实操作盘能力。第一版采用“半自动队列”：复用模拟盘的大模型量化策略、数据窗口、信号库与风险规则，但大模型不得直接提交真实订单；所有可交易建议必须先进入实盘待确认队列，用户在弹窗二次确认后才调用 Futu REAL 交易接口。

本轮只完成设计文档。用户确认后，下一步动作不是代码实现，而是基于本文档输出实盘工作台原型图；如需要高保真可交互设计，再引入 Figma MCP 支持。

## Current State Analysis

### 已存在的实盘入口

- `src/components/workspace/LiveTradingPanel.tsx`
  - 当前是工作台上的“实盘交易入口”。
  - 只调用 `useTradePreview()` 生成订单预览。
  - 页面文案明确“不会提交真实订单，任何实盘订单必须再次显式确认”。
  - 当前字段仅支持手动输入 `ticker`、`side`、`quantity`、`limitPrice`，不具备大模型策略队列。

- `src/hooks/useTradePreview.ts`
  - 当前仅用于 `/api/trade/preview`。

- `api/routes/tradeRoutes.ts`
  - 当前只有 `POST /api/trade/preview`。
  - 失败时返回 `canSubmitLiveOrder: false`。

- `api/futu_bridge/futu_trade_preview.py`
  - 当前是纯预览脚本，不连接真实下单。
  - `canSubmitLiveOrder` 固定为 `False`。

### 已存在的实盘账户能力

- `api/futu_bridge/futu_account.py`
  - 已使用 `TrdEnv.REAL` 查询真实账户 summary 与 positions。
  - 返回 `trading.environment = "REAL"`，但 `liveTradingEnabled = False`。
  - 当前实盘持仓已经具备基础数据结构，可作为实盘策略上下文来源。

- `api/routes/accountRoutes.ts`
  - `GET /api/account/dashboard`
  - `GET /api/account/summary`
  - `GET /api/account/positions`
  - 已经可服务工作台账户与持仓展示。

### 模拟盘可复用能力

- `api/simulation/simulationTradingEngine.ts`
  - 已具备启动、停止、单轮评估、定时运行、并发 LLM 决策、硬风控、市场时段判断、下单意图构造、日志。
  - 当前会直接调用 `submitSimulatedOrder()` 提交 Futu SIMULATE 订单。
  - 实盘版不能直接复用这一提交路径，必须改造成“生成待确认订单”。

- `api/simulation/llmTradingDecisionService.ts`
  - 已封装大模型交易决策。
  - Prompt 当前写死为 Futu SIMULATE 场景，并声明 “SELL_SHORT is allowed only in Futu SIMULATE stock trading”。
  - 实盘版必须改写 prompt：目标环境为 Futu REAL，所有订单需要人工确认，允许 SELL_SHORT 但必须突出保证金、强平和风险。

- `api/simulation/realtimeDataAdapter.ts`
  - 已从实时行情缓存读取 K 线、分时、摆盘。
  - 实盘版可复用，保持 session-aware 行情和 fail-closed 数据完整性。

- `api/simulation/feeContextService.ts`
  - 当前用于估算模拟盘交易成本。
  - 已只读确认 Futu REAL 支持 `order_fee_query`；实盘版应提交前使用估算费用，提交成功并产生 `orderId` 后回填 Futu REAL 真实费用。

- `api/simulation/simulationPersistence.ts`
  - 通过 `.data/simulation-history.sqlite3` 持久化 `signals`、`orders`、`skipped`。
  - 用户已选择实盘历史库独立隔离，因此不复用同一个 DB 文件。

- `api/futu_bridge/futu_sim_order.py`
  - 当前下单接口使用 `TrdEnv.SIMULATE`。
  - 实盘版需要新建独立脚本，使用 `TrdEnv.REAL`，并保持更严格的 payload 校验。

- `api/futu_bridge/futu_sim_orders.py`
  - 当前查询模拟盘历史订单状态。
  - 实盘版需要新建独立脚本，使用 `TrdEnv.REAL` 查询真实订单状态。

### 已存在的模拟盘 UI

- `src/pages/SimulationTradingView.tsx`
  - 已有完整控制台：启动/停止/单轮评估、账户卡片、持仓、股票池、模型配置、运行状态、Futu 订单状态、历史策略信号、历史订单、跳过原因。
  - 实盘页面应借鉴布局，但必须把“历史模拟订单”替换为“待确认订单”和“实盘订单状态”。

- `src/hooks/useSimulationTrading.ts`
  - 已有 30 秒自动刷新、历史记录独立刷新、Futu 订单状态分页查询。
  - 实盘版可复制为 `useLiveTrading.ts`，但提交动作必须拆成：生成信号 -> 入队 -> 弹窗确认 -> 提交 -> 查询真实订单状态。

## Product Decisions Locked

1. 第一版运行方式：半自动队列。
   - 大模型自动或手动评估后生成策略信号。
   - 通过硬风控的交易建议进入“待确认队列”。
   - 不存在大模型直接调用实盘下单接口的路径。

2. 实盘卖空：确认后允许。
   - LLM 可以生成 `SELL_SHORT`。
   - 后端必须对卖空做额外风险标记。
   - 确认弹窗必须展示卖空、保证金、回补风险、订单类型、时段与预估费用。

3. 确认强度：二次确认。
   - 弹窗展示订单详情、账户影响、风险说明。
   - 用户点击确认后才提交。
   - 第一版不强制输入确认词。

4. 历史库：独立 SQLite。
   - 新增 `.data/live-trading-history.sqlite3`。
   - 不与 `.data/simulation-history.sqlite3` 混用。

5. 下一步：原型图。
   - 本文档确认后，先输出实盘工作台原型图。
   - 原型确认后再进入代码实现。

6. 实盘入口导航：直接进入二级页面。
   - 顶部导航中的“实盘入口”必须直接跳转 `/live-trading`。
   - 不再先跳到工作台内的 `/#trading` 卡片。
   - 工作台内仍可保留实盘入口卡片作为说明和二次入口，但主导航应直达实盘量化页面。

## Proposed Architecture

### 后端模块划分

新增 `api/live/` 目录，避免实盘逻辑散落到 `api/simulation/` 中。

建议文件：

- `api/live/liveTradingEngine.ts`
  - 复刻并改造 `simulationTradingEngine.ts`。
  - 负责启动、停止、单轮评估、定时评估、生成信号、生成待确认订单。
  - 不直接提交真实订单。
  - 调用 `liveOrderQueueService.createPendingOrder()` 而不是调用 Futu 下单。

- `api/live/liveAccountService.ts`
  - 封装真实账户读取。
  - 复用 `api/futu_bridge/futu_account.py` 或新增更明确的 `futu_live_account.py`。
  - 输出结构应与模拟盘 account dashboard 兼容，但标记 `environment: "REAL"`。

- `api/live/liveTradingDecisionService.ts`
  - 从 `llmTradingDecisionService.ts` 派生。
  - Prompt 改成 Futu REAL 场景。
  - 明确：
    - 所有下单建议必须等待人工确认。
    - BUY 可用于开多或空头回补。
    - SELL_TO_CLOSE 仅平多。
    - SELL_SHORT 为实盘卖空，高风险，必须保守。
    - 费用和净收益优先级高于毛收益。
    - 数据不完整时必须 HOLD。

- `api/live/liveOrderQueueService.ts`
  - 管理待确认订单状态。
  - 订单状态建议：
    - `PENDING_CONFIRMATION`
    - `CONFIRMED_SUBMITTING`
    - `SUBMITTED`
    - `REJECTED_BY_USER`
    - `BLOCKED_BY_RISK`
    - `SUBMIT_FAILED`
  - 每个待确认订单必须保留 `signalId`，确保信号与订单链路可追踪。

- `api/live/livePersistence.ts`
  - 独立 SQLite 文件：`.data/live-trading-history.sqlite3`。
  - 可复用 `simulationPersistence.ts` 的桥接模式。
  - 建议历史 kind：
    - `signals`
    - `pending_orders`
    - `submitted_orders`
    - `rejected_orders`
    - `skipped`
    - `confirmations`

- `api/live/futuLiveOrderService.ts`
  - 查询真实订单状态。
  - 缓存 TTL 仍建议 10 秒，避免触发 Futu 限频。
  - 真实订单状态一律从 Futu REAL 查询，不以本地库作为最终状态来源。

- `api/routes/liveTradingRoutes.ts`
  - 新增路由挂载到 `/api/live-trading`。
  - 建议接口：
    - `GET /dashboard`
    - `POST /start`
    - `POST /stop`
    - `POST /run-once`
    - `GET /history/signals`
    - `GET /history/pending-orders`
    - `GET /history/submitted-orders`
    - `GET /history/skipped`
    - `GET /futu-orders`
    - `POST /pending-orders/:id/confirm`
    - `POST /pending-orders/:id/reject`
    - `GET /llm-config`
    - `PUT /llm-config`

### Futu Python Bridge

新增独立实盘脚本，不在模拟盘脚本中切换环境，降低误用风险。

- `api/futu_bridge/futu_live_order.py`
  - 对应 `futu_sim_order.py`。
  - 使用 `TrdEnv.REAL`。
  - 必须校验：
    - `accountId` 必须来自真实账户。
    - `confirmToken` 或后端确认记录存在。
    - `side` 仅允许 `BUY`、`SELL_SHORT`、`SELL_TO_CLOSE`。
    - 数量、价格、订单时段合法。
    - 期权代码不允许进入本正股策略。
    - ETH 不使用 MARKET。
  - `remark` 使用 `FinancialWorkbench LIVE {strategy} {signalId}`，并保留确认记录 ID。

- `api/futu_bridge/futu_live_orders.py`
  - 对应 `futu_sim_orders.py`。
  - 使用 `TrdEnv.REAL` 查询真实订单状态。

- `api/futu_bridge/futu_live_fee.py`
  - 接入已确认支持的 Futu REAL `order_fee_query`。
  - 返回 `order_id`、`fee_amount`、`fee_details` 的标准化 JSON。
  - 若真实费用暂不可查或接口失败，返回明确 warning，后端继续展示提交前估算费用作为兜底。

### 环境变量与交易环境门禁

当前代码没有统一的 `traenv` 环境变量；Futu SDK 层实际使用 `TrdEnv.REAL` / `TrdEnv.SIMULATE`。实盘实现应新增显式门禁，避免误提交。

建议新增：

- `FUTU_LIVE_TRD_ENV=REAL`
  - 只允许值为 `REAL` 时启用实盘提交。
  - Python bridge 仍硬编码 `TrdEnv.REAL`，该变量只作为后端门禁和 UI 展示。

- `LIVE_TRADING_ENABLED=false`
  - 默认关闭。
  - 只有显式设为 `true` 时，确认接口才可调用 `futu_live_order.py`。

- `LIVE_TRADING_HISTORY_DB_PATH=.data/live-trading-history.sqlite3`
  - 独立实盘历史库路径。

- `LIVE_MARKETABLE_LIMIT_SLIPPAGE_BPS=15`
  - 实盘主动限价单滑点保护。

- `LIVE_REQUIRE_MANUAL_CONFIRMATION=true`
  - 第一版固定为 true，不允许关闭。

### 风控规则

实盘版应在模拟盘规则基础上加严，不照搬“模拟盘可承受风险”的默认值。

建议第一版：

- 数据完整性：
  - 沿用 fail-closed。
  - K 线、分时、摆盘、账户、持仓、市场状态任一关键数据缺失时，不生成待确认订单。

- 订单类型：
  - RTH：
    - 空头回补 BUY 可使用 MARKET 或 MARKETABLE_LIMIT，但确认弹窗必须显示。
    - 其他方向默认 MARKETABLE_LIMIT。
  - ETH：
    - 只允许 MARKETABLE_LIMIT。
  - Overnight：
    - 第一版不提交真实订单，避免 Futu 实盘/账户权限差异。

- 仓位限制：
  - 开仓名义金额上限建议低于模拟盘 30%，第一版建议默认 10% 账户权益，可通过配置调整。
  - 卖空开仓建议更低，例如 5% 账户权益。
  - 回补空头、平多不受最小开仓金额限制，但不得超过可平仓数量。

- 卖空：
  - `SELL_SHORT` 必须进入高风险确认弹窗。
  - 如果真实账户不支持卖空、保证金不足、券源/权限不可确认，则阻断。

- 去重：
  - 沿用同标的同方向 15 分钟去重窗口。
  - 对实盘 pending 状态也生效，避免重复生成多个待确认订单。

- 费用：
  - LLM 判断必须优先使用净收益。
  - 确认弹窗必须显示提交前估算费用，标记 `estimated_pre_trade`。
  - 订单提交成功并产生 `orderId` 后，使用 Futu REAL `order_fee_query` 回填真实费用，标记 `actual_post_trade`。

## Frontend / Prototype Design Scope

下一步原型图需要覆盖以下页面和弹窗，不做代码实现：

1. 工作台实盘卡片升级
   - 当前 `LiveTradingPanel.tsx` 从“手动预览入口”升级为“实盘量化入口”。
   - 顶部导航“实盘入口”直接进入 `/live-trading` 二级页面；该卡片只作为工作台内的说明与辅助入口。
   - 显示：
     - REAL 环境标识。
     - 实盘门禁状态。
     - 待确认订单数量。
     - 今日已提交订单数量。
     - “进入实盘量化”按钮。

2. 新增实盘量化页面
   - 建议路径：`/live-trading`。
   - 视觉结构借鉴 `SimulationTradingView.tsx`，但红/琥珀风险语义更强。
   - 核心区域：
     - 实盘安全门禁。
     - 真实账户资产与持仓。
     - 大模型策略股票池。
     - 模型配置。
     - 引擎运行状态。
     - 历史策略信号。
     - 待确认订单队列。
     - 实盘 Futu 订单状态。
     - 跳过与阻断原因。

3. 实盘订单确认弹窗
   - 弹窗必须展示：
     - 标的、方向、数量、订单类型、交易时段、限价/市价。
     - 关联 `signalId`、模型、置信度、模型理由。
     - 当前持仓与预计成交后持仓。
     - 预估名义金额、费用、滑点保护。
     - 卖空/回补/平多语义解释。
     - 风控检查结果。
   - 按钮：
     - `拒绝`
     - `确认提交真实订单`

4. 实盘订单详情页
   - 可借鉴 `SimulationOrderDetailView.tsx`。
   - 需要串起：
     - 策略信号。
     - 待确认记录。
     - 用户确认记录。
     - Futu REAL 订单状态。

5. 原型图交付方式
   - 优先在本地以高保真 HTML/React 原型描述页面结构。
   - 如需要进入 Figma 文件或使用 Figma 节点，则引入 Figma MCP 支持。

## Proposed Implementation Steps

以下为原型确认后的编码计划，不在当前步骤执行。

### Step 1: 类型与数据模型

- 修改 `shared/types.ts`
  - 新增 `LiveTradingDashboardResponse`。
  - 新增 `LiveEngineStatus`。
  - 新增 `LivePendingOrder`。
  - 新增 `LiveOrderConfirmation`。
  - 新增 `LiveOrderResult`。
  - 新增 `LiveHistoryKind`。
  - 保留 `QuantSignal`，继续要求 `model` 与 `modelLabel`。
  - 可将 `SimulatedOrderIntent` 泛化为 `TradingOrderIntent`，但避免破坏模拟盘现有行为。

### Step 2: 后端实盘服务骨架

- 新增 `api/live/livePersistence.ts`
  - 复用 SQLite bridge 模式。
  - 默认 DB：`.data/live-trading-history.sqlite3`。

- 新增 `api/live/liveAccountService.ts`
  - 调用真实账户桥接。
  - 输出实盘账户 dashboard。

- 新增 `api/live/liveOrderQueueService.ts`
  - 创建、查询、确认、拒绝 pending order。
  - 所有状态变化写入 SQLite。

- 新增 `api/live/liveTradingEngine.ts`
  - 复制 `simulationTradingEngine.ts` 的运行框架。
  - 替换账户来源为 REAL。
  - 替换 prompt 为 REAL。
  - 替换下单行为为“写入待确认队列”。

### Step 3: Futu REAL 桥接

- 新增 `api/futu_bridge/futu_live_order.py`
  - 使用 `TrdEnv.REAL`。
  - 只允许由确认接口调用。

- 新增 `api/futu_bridge/futu_live_orders.py`
  - 使用 `TrdEnv.REAL` 查询订单。

- 可选新增 `api/futu_bridge/futu_live_fee.py`
  - 使用 Futu REAL `order_fee_query` 查询真实订单费用。
  - 提交前仍使用估算费用；提交后优先展示真实费用。
  - 真实费用暂不可查时返回 warning，由后端估算兜底。

### Step 4: API 路由

- 修改 `api/app.ts`
  - 挂载 `app.use('/api/live-trading', liveTradingRoutes)`。

- 新增 `api/routes/liveTradingRoutes.ts`
  - 提供 dashboard、start、stop、run-once、history、pending confirm/reject、futu-orders、llm-config 接口。

### Step 5: 前端页面与 Hook

- 修改 `src/App.tsx`
  - 新增 `/live-trading` 路由。
  - 新增 `/live-trading/orders/:orderId` 订单详情路由。

- 修改 `src/components/common/AppNav.tsx`
  - 将顶部导航“实盘入口”从 `/#trading` 改为 `/live-trading`。
  - `/live-trading` 及其详情子页面高亮“实盘入口”。

- 修改 `src/components/workspace/LiveTradingPanel.tsx`
  - 从手动预览表单升级为实盘量化入口卡片。

- 新增 `src/pages/LiveTradingView.tsx`
  - 以 `SimulationTradingView.tsx` 为参考。
  - 重点增加“待确认订单队列”和“实盘确认弹窗”。

- 新增 `src/hooks/useLiveTrading.ts`
  - 复制并改造 `useSimulationTrading.ts`。
  - 自动刷新 dashboard、pending orders、REAL Futu orders。

- 新增或复用展示工具：
  - `src/utils/liveTradingDisplay.ts`
  - 可复用 `src/utils/simulationDisplay.ts` 的方向、订单类型、模型展示函数。

### Step 6: 测试

- 新增单元测试：
  - `tests/liveTradingEngine.test.ts`
    - 验证 LLM 生成的订单只进入 pending，不直接提交。
    - 验证数据缺失 fail-closed。
    - 验证 SELL_SHORT 进入高风险 pending。
  - `tests/liveOrderQueue.test.ts`
    - 验证 pending -> confirmed/submitted/rejected 状态流。
  - `tests/livePersistence.test.ts`
    - 验证独立 SQLite 文件与分页。
  - `tests/futuLiveOrders.test.ts`
    - 验证 REAL 订单查询参数、分页、缓存。
  - `tests/liveTradingPrompt.test.ts`
    - 验证 prompt 不再出现 SIMULATE 限定语，且包含人工确认和实盘风险约束。

## Acceptance Criteria

原型确认后的编码完成标准：

1. 工作台有清晰实盘入口，且与模拟盘入口视觉和语义区分明显。
2. `/live-trading` 页面可展示真实账户资产、实盘持仓、策略信号、待确认订单、实盘订单状态。
3. 大模型可以生成 BUY、SELL_SHORT、SELL_TO_CLOSE、HOLD 信号。
4. 任何 BUY、SELL_SHORT、SELL_TO_CLOSE 都不会被自动提交，必须先进入 pending。
5. 用户在确认弹窗点击确认后，后端才调用 `TrdEnv.REAL` 下单。
6. 用户拒绝订单后，订单状态持久化为 rejected，不再自动提交。
7. 实盘历史库与模拟盘历史库完全隔离。
8. 实盘订单最终状态从 Futu REAL 查询，不以本地库为准。
9. 新订单保持 `signalId` 链路，不生成断链 ID。
10. 日志覆盖实盘引擎启停、LLM 决策、pending 入队、用户确认、真实提交成功/失败，且不打印 API Key 和完整 prompt。

## Verification Steps

原型阶段验证：

1. 对照本文档检查原型是否覆盖实盘入口、实盘页面、确认弹窗、订单详情。
2. 检查原型中 REAL/SIMULATE 语义是否强区分。
3. 检查确认弹窗是否能让用户在提交前看到订单、费用、持仓变化和风险。
4. 检查卖空订单是否比普通订单有更明显风险提示。

编码阶段验证：

1. `npm test`
2. 针对实盘模块运行新增测试。
3. 手动调用 `GET /api/live-trading/dashboard`，确认 REAL 账户与持仓返回。
4. 手动调用 `POST /api/live-trading/run-once`，确认只生成 pending order，不提交 Futu。
5. 在 `LIVE_TRADING_ENABLED=false` 时调用确认接口，必须被阻断。
6. 在 `LIVE_TRADING_ENABLED=true` 且用户确认后，确认接口才调用 REAL bridge。
7. 查询 `/api/live-trading/futu-orders`，确认订单状态来自 Futu REAL。

## Assumptions & Constraints

- 本项目只做美股正股策略，不扩展期权实盘自动交易。
- 实盘版复用当前股票池，后续可单独做实盘股票池配置。
- 第一版允许 SELL_SHORT 进入确认队列，但后端必须在账户权限、保证金、券源不可确认时阻断。
- 第一版不实现一键批量确认，避免误提交。
- 当前代码没有统一 `traenv` 变量；设计中将其落为显式 `FUTU_LIVE_TRD_ENV=REAL` 与 `LIVE_TRADING_ENABLED` 双门禁。
- 本轮不修改业务代码，不启动服务，不提交任何真实订单。

## Next Action After User Confirmation

用户确认本文档后，下一步输出“真实操作盘原型图”，不是代码实现。

原型图应至少包含：

1. 工作台实盘入口卡片。
2. `/live-trading` 页面主视图。
3. 待确认订单队列表格。
4. 实盘订单二次确认弹窗。
5. 实盘订单详情页。

如需要 Figma 文件级交付或从 Figma 节点继续设计，将引入 Figma MCP 支持。
