# 交易策略与 Prompt 版本化配置计划

## Summary

本计划实现一个统一的 `trade_strategy/` 目录，用于管理实盘和模拟盘可选的交易策略版本、风控规则、LLM prompt、LLM input 上下文规则。

目标：

1. 将前面讨论的“机构风控兜底策略”落成文档和 YAML 配置文件。
2. 将给大模型的 prompt、input payload 结构、上下文规则从代码硬编码中抽离为可版本化 YAML 配置。
3. 实盘和模拟盘都可以独立选择策略版本。
4. 前端实盘页、模拟盘页都提供策略下拉选择，并支持查看策略摘要和完整配置内容。
5. 当前版本只允许前端选择和查看，不做前端在线编辑，避免实盘配置被误改。

用户已确认的关键决策：

- 策略版本选择作用域：实盘和模拟盘独立保存，互不影响。
- 配置格式：YAML。
- 前端查看粒度：摘要 + 全文展开查看。

## Current State Analysis

### 当前配置与持久化现状

- 当前只有大模型运行时配置：
  - `api/simulation/llmRuntimeConfigService.ts`
  - `CONFIG_KEY = 'llm_runtime_config'`
  - 保存位置：`.data/simulation-history.sqlite3` 的 `simulation_config` 表。
  - 实盘和模拟盘当前都调用同一套 `getLlmRuntimeConfig()` / `updateLlmRuntimeConfig()`。

- SQLite 配置桥：
  - `api/futu_bridge/simulation_history_db.py`
  - 已有 `get_config`、`set_config`。
  - 可复用来保存“当前选中的策略 id”，不需要新建数据库表。

### 当前实盘策略硬编码位置

- `api/live/liveTradingEngine.ts`
  - 写死了实盘开仓风控常量：
    - `MIN_TRADE_NOTIONAL`
    - `MAX_LONG_NOTIONAL_PCT`
    - `MAX_SHORT_NOTIONAL_PCT`
  - `openingRiskRejectionReason()` 使用这些常量做硬拦截。
  - `riskModelDescription()` 将这些常量拼成传给模型的自然语言。
  - `buildOrderIntent()` 调用 `openingRiskRejectionReason()`。

### 当前模拟盘策略硬编码位置

- `api/simulation/simulationTradingEngine.ts`
  - `passesOpeningRisk()` 写死模拟盘开仓风控：
    - 最低名义金额
    - 单笔最大权益百分比
    - 购买力保护线
    - 费用比例上限
  - `trendDecisionBlockReason()` 写死趋势过滤规则：
    - 趋势不可用禁止无持仓开仓。
    - 禁止 `AGAINST_TREND`。
    - 禁止 `SCALP` 作为无持仓新开仓理由。
    - `whyNotNoise` 不充分则禁止开仓。
  - `riskModelDescription()` 和 `feeModelDescription()` 被传入 prompt。

### 当前 Prompt 与 Input 上下文硬编码位置

- `api/simulation/llmTradingDecisionService.ts`
  - `buildDecisionPrompt(input)` 完整硬编码了：
    - system prompt。
    - hardConstraints。
    - portfolioContext。
    - feeContextRules。
    - actionSemantics。
    - forbiddenShortCoverLanguage。
    - marketData input shape。
    - requiredJson schema 描述。

- `api/live/liveTradingDecisionService.ts`
  - 实盘复用模拟盘的 `buildDecisionPrompt()`，但会替换 system role 为实盘语义。
  - 实盘 prompt 当前依赖 `riskModel` 和 `feeModel` 传入。

### 当前前端配置 UI

- 模拟盘页面：
  - `src/pages/SimulationTradingView.tsx`
  - 已有“大模型配置”区块，支持模型和并发下拉。

- 实盘页面：
  - `src/pages/LiveTradingView.tsx`
  - 已有“大模型配置”区块，支持模型和并发下拉。

- 当前没有策略版本下拉、策略内容查看、prompt 内容查看。

## Proposed Directory Structure

新增根目录：

```text
trade_strategy/
  README.md
  schemas/
    trade_strategy.schema.json
  strategies/
    institutional_risk_guard_v1.yaml
    aggressive_research_preview_v1.yaml
  prompt_packs/
    llm_autonomous_stock_trader_v1.yaml
    llm_autonomous_stock_trader_live_safe_v1.yaml
  docs/
    institutional_risk_guard_v1.md
```

### 目录职责

- `trade_strategy/README.md`
  - 说明策略目录结构、版本规则、字段含义、修改风险。

- `trade_strategy/schemas/trade_strategy.schema.json`
  - JSON Schema 用于校验 YAML 解析后的对象。
  - 计划只做运行时轻量校验，不引入复杂 schema validator；schema 先作为文档和测试依据。

- `trade_strategy/strategies/*.yaml`
  - 交易策略与风控策略配置。
  - 包含适用范围、风险预算、开仓限制、空头限制、费用规则、趋势过滤规则、后端硬拦截策略、展示文案。

- `trade_strategy/prompt_packs/*.yaml`
  - 大模型 prompt 和 input 上下文规则版本。
  - 包含 system prompt、hard constraints、action semantics、input sections、required JSON schema、禁止措辞等。

- `trade_strategy/docs/*.md`
  - 策略解释文档。
  - 先写 `institutional_risk_guard_v1.md`，说明机构风控框架来源、设计取舍和系统执行方式。

## YAML Schema Design

### Strategy YAML

示例文件：`trade_strategy/strategies/institutional_risk_guard_v1.yaml`

核心字段：

```yaml
id: institutional_risk_guard_v1
version: 1
label: 机构风控兜底策略 v1
summary: 多层风险预算框架，替代写死的 $1000 / 10% / 5% 开仓规则。
enabledFor:
  - simulation
  - live
references:
  - title: Morgan Stanley Concentrated Stock Solutions
    url: https://advisor.morganstanley.com/brian.hammersley/documents/field/b/br/brian-hammersley/Concentrated_Stock_Solutions.pdf
riskControls:
  minNotional:
    mode: warning
    amount: 0
    description: 不再把最低名义金额作为硬拦截，只作为费用效率提示。
  singleNameExposure:
    maxPctEquity: 0.05
    highConvictionMaxPctEquity: 0.08
    mode: hard_block
  shortExposure:
    maxSingleNamePctEquity: 0.03
    maxPortfolioShortPctEquity: 0.08
    mode: hard_block
  portfolioHeat:
    maxPctEquity: 0.05
    mode: hard_block
  perTradeLossBudget:
    maxPctEquity: 0.005
    mode: advisory
  buyingPowerProtection:
    maxPctBuyingPower: 0.95
    mode: hard_block
  feeDrag:
    maxRoundTripFeePctNotional: 0.02
    mode: hard_block
trendFilters:
  requireTrendForOpening: true
  blockAgainstTrendOpening: true
  blockScalpOpeningWhenFlat: true
  minWhyNotNoiseLength: 12
orderRules:
  marketableLimitSlippageBps: 15
  shortCoverRthOrderType: MARKET
  defaultOrderType: MARKETABLE_LIMIT
copy:
  riskModelDescription: |
    当前策略采用机构风控兜底框架：后端按账户权益、单票集中度、空头敞口、购买力保护、费用拖累和趋势上下文进行硬拦截；模型只给交易意图和理由，最终是否入队由后端风控决定。
```

### Prompt Pack YAML

示例文件：`trade_strategy/prompt_packs/llm_autonomous_stock_trader_v1.yaml`

核心字段：

```yaml
id: llm_autonomous_stock_trader_v1
version: 1
label: LLM 自主正股交易 Prompt v1
summary: 统一模拟盘和实盘的大模型交易决策 prompt 与 input 上下文规则。
enabledFor:
  - simulation
  - live
systemPrompts:
  simulation: |
    你是 Futu SIMULATE 模拟盘美股正股自主交易模型...
  live: |
    你是 Futu REAL 实盘美股正股半自动交易研究员...
hardConstraints:
  common:
    - 只允许 HOLD、BUY、SELL_SHORT、SELL_TO_CLOSE。
    - positionQuantity 可正可负；orderQuantity 必须是本次订单正整数。
    - BUY 可用于开多，也可用于空头回补；空头回补不应按开仓购买力判断。
  simulation:
    - 仅 Futu SIMULATE 模拟盘。
  live:
    - 仅生成实盘候选订单，真实提交必须人工二次确认。
inputSections:
  - task
  - universe
  - targetTicker
  - account
  - portfolioContext
  - currentPosition
  - feeModel
  - riskModel
  - marketData
  - requiredJson
contextRules:
  feeContextRules:
    netPnLRule: 判断是否平仓/回补时必须优先看 estimatedFeeContext.estimatedNetUnrealizedPnL。
  actionSemantics:
    BUY: 如果 targetExposure.exposureSide 为 SHORT，BUY 表示买入平仓/回补空头。
  forbiddenShortCoverLanguage:
    - 不要说购买力允许回补
    - 不要说购买力不足所以不能回补
requiredJson:
  approved: boolean
  action: HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE
  ticker: string
  orderQuantity: number
  limitPrice: number
  confidence: low | medium | high
  reason: string
  riskAssessment: string
  trendAlignment: WITH_TREND | AGAINST_TREND | REVERSAL_ATTEMPT | NO_TREND | UNAVAILABLE
  tradeHorizon: SCALP | INTRADAY | SWING_1_TO_7_DAYS
  whyNotNoise: string
  dataWindowUsed: object
```

## Proposed Code Changes

### 1. 添加 YAML 解析依赖

文件：

- `package.json`
- `package-lock.json`

新增依赖：

```json
"yaml": "^2.x"
```

原因：

- 用户明确要求 YAML。
- 当前项目没有 YAML 解析依赖。
- `yaml` 包适合 ESM/TypeScript，轻量且无需 Python bridge。

### 2. 新增共享类型

文件：

- `shared/types.ts`

新增类型：

- `TradeRuntimeMode = 'simulation' | 'live'`
- `TradeStrategyConfig`
- `TradePromptPackConfig`
- `TradeStrategyOption`
- `TradeStrategyRuntimeSelection`
- `TradeStrategyConfigResponse`
- `UpdateTradeStrategyConfigRequest`
- `TradeStrategyDocumentResponse`

重点字段：

- `activeStrategyId`
- `activePromptPackId`
- `strategyOptions`
- `promptPackOptions`
- `activeStrategy`
- `activePromptPack`
- `updatedAt`
- `warnings`

### 3. 新增策略加载服务

文件：

- `api/trade_strategy/tradeStrategyConfigService.ts`

职责：

1. 读取 `trade_strategy/strategies/*.yaml`。
2. 读取 `trade_strategy/prompt_packs/*.yaml`。
3. 做轻量校验：
   - id 必填且唯一。
   - label 必填。
   - enabledFor 包含 `simulation` 或 `live`。
   - riskControls / systemPrompts / requiredJson 等关键字段存在。
4. 提供：
   - `getTradeStrategyRuntimeConfig(mode)`
   - `updateTradeStrategyRuntimeConfig(mode, input)`
   - `getActiveTradeStrategy(mode)`
   - `getActivePromptPack(mode)`
   - `buildRiskModelDescription(mode)`
   - `buildDecisionPromptFromPack(mode, input)`

持久化选择：

- 使用 `.data/simulation-history.sqlite3` 的 `simulation_config` 表。
- key：
  - `trade_strategy_runtime_config:simulation`
  - `trade_strategy_runtime_config:live`

默认选择：

- simulation:
  - strategy: `institutional_risk_guard_v1`
  - promptPack: `llm_autonomous_stock_trader_v1`
- live:
  - strategy: `institutional_risk_guard_v1`
  - promptPack: `llm_autonomous_stock_trader_v1`

说明：

- 配置文件是版本源。
- SQLite 只保存当前选择，不保存 YAML 全量内容。
- 如果 YAML 读取失败，服务 fail-closed：返回 warning，并使用内置最小默认策略阻止开仓，而不是继续使用旧硬编码阈值。

### 4. 重构 Prompt 构建

文件：

- `api/simulation/llmTradingDecisionService.ts`
- `api/live/liveTradingDecisionService.ts`

改法：

1. 保留 `DecisionInput` 和 `parseTradingDecision()` 的现有逻辑。
2. 将当前 `buildDecisionPrompt(input)` 改为调用策略服务：
   - `buildDecisionPromptFromPack('simulation', input)`
3. 实盘 `requestLiveTradingDecision()` 调用：
   - `buildDecisionPromptFromPack('live', input)`
4. `buildDecisionPromptFromPack()` 仍生成和当前兼容的 OpenAI/Ark message 数组：
   - `[{ role: 'system', content }, { role: 'user', content: JSON.stringify(payload) }]`
5. input payload 的结构保持兼容现有测试：
   - `task`
   - `hardConstraints`
   - `universe`
   - `targetTicker`
   - `account`
   - `portfolioContext`
   - `currentPosition`
   - `feeModel`
   - `riskModel`
   - `marketData`
   - `requiredJson`

注意：

- 本次不改变模型返回 JSON 解析格式，避免扩大行为面。
- 只把 prompt 文案、约束列表、上下文规则变成版本化来源。

### 5. 重构风控执行

文件：

- `api/live/liveTradingEngine.ts`
- `api/simulation/simulationTradingEngine.ts`

#### 实盘

替换：

- `MIN_TRADE_NOTIONAL`
- `MAX_LONG_NOTIONAL_PCT`
- `MAX_SHORT_NOTIONAL_PCT`
- `openingRiskRejectionReason()`
- `riskModelDescription()`

改为：

- 从 `getActiveTradeStrategy('live')` 读取策略配置。
- `openingRiskRejectionReason(account, decision, limitPrice, strategyConfig)` 根据 YAML 执行：
  - 单票集中度上限。
  - 空头单票上限。
  - 空头组合上限。
  - 购买力保护线。
  - 费用拖累上限。
  - `minNotional.mode === hard_block` 时才硬拦截；默认 `warning` 不拦截。
- `riskModelDescription()` 使用 YAML 的 `copy.riskModelDescription`，并补充关键参数摘要。

#### 模拟盘

替换：

- `passesOpeningRisk()`
- `trendDecisionBlockReason()` 中可配置部分。
- `riskModelDescription()`。

改为：

- 从 `getActiveTradeStrategy('simulation')` 读取策略配置。
- 模拟盘保留比实盘更适合回测/演练的行为，但规则来源同一 YAML。
- 趋势过滤和 `whyNotNoise` 长度从 YAML 读取。

### 6. 新增 API 路由

文件：

- `api/routes/simulationRoutes.ts`
- `api/routes/liveTradingRoutes.ts`

新增接口：

```http
GET /api/simulation/trade-strategy-config
PUT /api/simulation/trade-strategy-config

GET /api/live-trading/trade-strategy-config
PUT /api/live-trading/trade-strategy-config
```

GET 返回：

- 当前 mode。
- active strategy id。
- active prompt pack id。
- 所有可选 strategy options。
- 所有可选 prompt pack options。
- active strategy 完整 YAML 解析内容。
- active prompt pack 完整 YAML 解析内容。
- updatedAt。
- warnings。

PUT 入参：

```json
{
  "strategyId": "institutional_risk_guard_v1",
  "promptPackId": "llm_autonomous_stock_trader_v1"
}
```

行为：

- 只允许选择 `enabledFor` 包含当前 mode 的配置。
- 保存后从下一轮评估生效。
- 不影响正在进行中的本轮 LLM 调用。

### 7. 前端 Hook

文件：

- `src/hooks/useSimulationTrading.ts`
- `src/hooks/useLiveTrading.ts`

新增：

- `tradeStrategyConfig`
- `saveTradeStrategyConfig(input)`
- `refreshTradeStrategyConfig()`

行为：

- dashboard 初次加载时并行加载策略配置。
- 保存策略配置后刷新策略配置和 dashboard。
- 保存失败显示页面错误。

### 8. 前端 UI

文件：

- `src/pages/SimulationTradingView.tsx`
- `src/pages/LiveTradingView.tsx`

新增区块：

标题建议：

- 模拟盘：`交易策略与 Prompt 版本`
- 实盘：`实盘策略与 Prompt 版本`

UI 内容：

1. 策略版本下拉：
   - 显示 `label`。
   - 保存 `strategyId`。
2. Prompt 版本下拉：
   - 显示 `label`。
   - 保存 `promptPackId`。
3. 当前摘要：
   - strategy summary。
   - prompt pack summary。
   - 更新时间。
4. 查看全文：
   - 使用 `<details>` 或折叠面板。
   - 展示 YAML 解析后的 JSON 或原始 YAML 内容。
   - 建议同时展示：
     - 风控参数摘要。
     - system prompt。
     - hard constraints。
     - context rules。
5. 保存按钮：
   - 文案：`保存策略版本`
   - 提示：`保存后从下一轮评估生效，不会绕过人工确认/实盘门禁。`

注意：

- 实盘页面必须保留 `LIVE_TRADING_ENABLED` 和人工确认说明。
- 策略选择不能绕过实盘二次确认。

### 9. 文档

文件：

- `trade_strategy/README.md`
- `trade_strategy/docs/institutional_risk_guard_v1.md`

内容：

- 说明当前默认策略不是“华尔街某机构秘方”，而是基于公开机构风控原则抽象出来的工程化兜底框架。
- 解释核心原则：
  - 风险预算。
  - 单票集中度。
  - 组合热度。
  - 空头风险单独约束。
  - 费用拖累。
  - 趋势与短周期噪声过滤。
  - 实盘人工确认。
- 记录默认参数和可调整字段。

## Assumptions & Decisions

1. `trade_strategy/` 放在项目根目录，而不是 `api/` 或 `src/`，因为它既服务后端执行，也服务前端查看。
2. YAML 文件是版本源；SQLite 只保存当前选择。
3. 实盘和模拟盘独立保存选择，key 分别为：
   - `trade_strategy_runtime_config:simulation`
   - `trade_strategy_runtime_config:live`
4. 前端只支持选择和查看，不支持编辑 YAML。
5. 本次不改变 LLM 输出 JSON schema，不改变订单确认流程。
6. 本次不引入复杂策略计算如完整 Kelly 参数估计；先落地可配置的机构风控兜底版本。
7. `minNotional` 默认改成 warning，不再硬拦截，除非 YAML 明确设置为 `hard_block`。
8. 若策略配置加载失败，后端 fail-closed：禁止新开仓，只允许降低风险动作。

## Testing Plan

### 单元测试

新增或扩展：

- `tests/tradeStrategyConfig.test.ts`
- `tests/llmAutonomousTrading.test.ts`
- `tests/liveTrading.test.ts`

覆盖：

1. YAML 策略能被加载和校验。
2. YAML prompt pack 能被加载和校验。
3. simulation/live 选择独立保存，互不影响。
4. 非当前 mode 的策略不能被保存。
5. `buildDecisionPrompt()` 仍生成两条 message，且 payload 保留现有关键字段。
6. 实盘 BUY 开仓不再被写死 `$1000` 最低名义金额拦截。
7. 实盘开仓仍受单票集中度、购买力保护、费用拖累硬风控约束。
8. 空头回补 BUY 仍不按购买力判断，也不受开仓 minNotional 约束。
9. 配置加载失败时 fail-closed，禁止新开仓。

### 类型检查和全量测试

执行：

```bash
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm run check
PATH=/Users/ShockCao/AICoding/Financial/.tools/node/bin:$PATH npm test
```

### 手工验收

1. 打开 `/simulation`。
2. 能看到“交易策略与 Prompt 版本”区块。
3. 能分别选择策略版本和 prompt pack。
4. 能展开查看摘要和全文内容。
5. 保存后刷新页面仍保持模拟盘选择。
6. 打开 `/live-trading`。
7. 实盘页面能独立选择不同策略版本，不影响模拟盘。
8. 查看全文能看到实盘 system prompt 和风控参数。
9. 启动下一轮模拟盘/实盘评估后，历史策略信号中模型理由不再出现旧的 `$1000 + 10% + 5%` 写死规则。
10. 实盘仍必须人工二次确认，策略选择不会直接提交真实订单。

## Rollout Notes

- 先保留旧函数名作为兼容入口，例如 `buildDecisionPrompt()`，内部改用 YAML 配置。
- 先创建一个默认策略版本和一个 prompt pack，保证现有行为可迁移。
- 默认策略不再硬编码 `$1000 / BUY 10% / SELL_SHORT 5%`。
- 后续要新增策略，只需要新增 YAML 文件，不需要改核心引擎代码。
