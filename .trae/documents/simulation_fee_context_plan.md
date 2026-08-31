# 模拟盘交易费用上下文增强计划

## Summary

当前大模型交易决策确实没有拿到足够明确的“交易费用上下文”。代码检查确认：持仓传入了 `averageCost`、`currentPrice`、`todayPnL`、`unrealizedPnL`，并传入了一个静态 `feeModel` 字符串，但没有针对每个持仓提供：

- 开仓已发生费用估算
- 本次平仓/回补预估费用
- 回合交易总费用估算
- 扣费后净浮盈/净浮亏
- “毛浮盈为正但扣费后亏损”的明确标记

用户指出的场景成立：例如毛浮盈 `$4`，但开仓费用 `$3`、平仓费用 `$3`，扣费后实际是 `$-2`，如果模型只看持仓浮盈就可能误判。

本计划将使用后端现有估算费率模型为每个持仓生成结构化费用上下文，并将其注入大模型 prompt。Futu 模拟盘本身无法可靠返回真实订单费用：只读验证 `order_fee_query(..., trd_env=SIMULATE)` 返回 `Paper trading is not supported.`，因此本次不依赖 Futu 真实费用接口。

## Current State Analysis

### 1. 当前 prompt 费用信息不足

已检查文件：

- `api/simulation/llmTradingDecisionService.ts`
- `api/simulation/simulationTradingEngine.ts`
- `api/futu_bridge/futu_sim_account.py`
- `api/futu_bridge/futu_sim_orders.py`
- `api/simulation/futuSimulationOrderService.ts`
- `shared/types.ts`
- `tests/llmAutonomousTrading.test.ts`

当前 `buildDecisionPrompt(...)` 传给模型的信息包括：

- `account.summary.dailyPnL`
- `account.summary.totalPnL`
- `account.positions`
- `portfolioContext.allPositions`
- `currentPosition`
- `feeModel`
- `riskModel`

其中持仓字段包括：

- `averageCost`
- `currentPrice`
- `todayPnL`
- `unrealizedPnL`
- `pnlRatio`
- `positionRatio`

但没有结构化费用字段。

### 2. 当前费用模型只用于部分硬风控

`api/simulation/simulationTradingEngine.ts` 当前已有：

```ts
const MIN_TRADE_NOTIONAL = 1_000
const MAX_NOTIONAL_PCT = 0.3
const MAX_FEE_RATIO = 0.003
const PER_SHARE_FEE = 0.005
const MIN_ORDER_FEE = 1
```

并有：

```ts
function estimateRoundTripFee(quantity: number, price: number): number {
  const commission = Math.max(MIN_ORDER_FEE, quantity * PER_SHARE_FEE)
  const regulatoryEstimate = quantity * price * 0.0001
  return commission * 2 + regulatoryEstimate
}
```

该函数目前主要用于开仓风控 `canOpenPosition(...)`，但没有把每个持仓的“平仓后净收益”传给模型。

### 3. Futu 模拟盘无法直接取真实费用

Futu Python SDK 确实存在：

- `order_fee_query(order_id_list, trd_env, acc_id)`
- `history_deal_list_query(...)`
- `deal_list_query(...)`

但实际只读验证：

```text
order_fee_query(..., trd_env=TrdEnv.SIMULATE, acc_id=19855997)
ret -1
Paper trading is not supported.
```

当前 `/api/simulation/futu-orders` 返回的历史订单 `rawResponse` 也没有费用字段，字段主要包括：

- `order_id`
- `qty`
- `price`
- `dealt_qty`
- `dealt_avg_price`
- `amount`
- `currency`
- `session`
- 其他订单状态字段

结论：

- 不能把“真实费用抓取”作为主方案。
- 应该使用后端估算费率模型，并在字段中明确 `source: estimated`。

### 4. 用户决策

用户已确认：

- 费用来源采用“估算模型”，不新增页面配置、不固定 3 美金。
- 遇到“毛浮盈为正但扣费后净亏损”的场景，不做硬风控阻断；应强提醒大模型，除非止损/降风险，否则不应因为毛浮盈为正就平仓。

## Proposed Changes

### 1. 新增费用上下文类型

文件：`shared/types.ts`

新增类型：

```ts
export type EstimatedPositionFeeContext = {
  source: 'estimated'
  currency: string
  positionQuantity: number
  absPositionQuantity: number
  averageCost: number | null
  currentPrice: number | null
  grossUnrealizedPnL: number | null
  estimatedEntryFee: number | null
  estimatedExitFee: number | null
  estimatedRoundTripFee: number | null
  estimatedNetUnrealizedPnL: number | null
  estimatedExitFeeRatioToGrossPnL: number | null
  grossProfitButNetLoss: boolean
  note: string
}
```

说明：

- `grossUnrealizedPnL` 使用 Futu 持仓的 `unrealizedPnL` 解析值。
- `estimatedEntryFee` 用持仓数量和 `averageCost` 估算开仓费用。
- `estimatedExitFee` 用持仓数量和 `currentPrice` 或实时 `lastPrice` 估算平仓/回补费用。
- `estimatedRoundTripFee = estimatedEntryFee + estimatedExitFee`。
- `estimatedNetUnrealizedPnL = grossUnrealizedPnL - estimatedRoundTripFee`。
- `grossProfitButNetLoss = grossUnrealizedPnL > 0 && estimatedNetUnrealizedPnL < 0`。
- 字段使用 number，传给模型时也可以附加格式化字符串，避免模型自行解析 `$` 文本。

### 2. 提取费用计算工具函数

文件：新增 `api/simulation/feeContextService.ts`

职责：

- 统一维护模拟盘费用估算逻辑。
- 供交易引擎风控和 prompt 构造复用。

导出函数：

```ts
export function estimateSingleOrderFee(quantity: number, price: number): number
export function estimateRoundTripFee(quantity: number, entryPrice: number, exitPrice?: number): number
export function buildPositionFeeContext(position: Position, marketPrice?: number): EstimatedPositionFeeContext
export function parseMoneyNumber(value: string | undefined): number | undefined
export function feeModelDescription(): string
```

实现规则：

- `estimateSingleOrderFee(quantity, price)`：
  - `commission = max(MIN_ORDER_FEE, abs(quantity) * PER_SHARE_FEE)`
  - `regulatoryReserve = abs(quantity) * price * 0.0001`
  - 返回 `commission + regulatoryReserve`
- `estimateRoundTripFee(quantity, entryPrice, exitPrice = entryPrice)`：
  - `entryFee = estimateSingleOrderFee(quantity, entryPrice)`
  - `exitFee = estimateSingleOrderFee(quantity, exitPrice)`
  - 返回两者相加
- `buildPositionFeeContext(position, marketPrice)`：
  - `quantity = parse position.quantity`
  - `averageCost = parse position.averageCost`
  - `currentPrice = marketPrice ?? parse position.currentPrice`
  - `grossUnrealizedPnL = parse position.unrealizedPnL`
  - 如果价格或数量不可解析，对应费用字段返回 `null`，但不伪造数字。

原因：

- 当前费用常量散落在 `simulationTradingEngine.ts` 内部，不方便 prompt 层复用。
- 抽出服务后可以避免风控和 prompt 费用计算不一致。

### 3. 调整交易引擎复用费用服务

文件：`api/simulation/simulationTradingEngine.ts`

变更：

- 移除或停用本文件内重复的：
  - `PER_SHARE_FEE`
  - `MIN_ORDER_FEE`
  - `estimateRoundTripFee(...)`
  - `feeModelDescription(...)`
- 从 `feeContextService.ts` 导入：
  - `estimateRoundTripFee`
  - `feeModelDescription`

兼容：

- `canOpenPosition(...)` 继续使用估算回合费用约束。
- 保持现有开仓风控不变：
  - 最小名义金额
  - 账户权益 30%
  - 买力 95%
  - 费用比例上限 0.30%

### 4. 在大模型 prompt 中注入结构化费用上下文

文件：`api/simulation/llmTradingDecisionService.ts`

变更：

- 在 `summarizePositions(...)` 中为每个持仓增加：

```ts
estimatedFeeContext: buildPositionFeeContext(position)
```

- 在 `currentPosition` 中增加：

```ts
estimatedFeeContext: buildPositionFeeContext(input.position, input.marketData.lastPrice)
```

- 在 `portfolioContext` 中增加说明：

```ts
feeContextRules: {
  source: '费用为后端估算值，Futu SIMULATE 不支持真实 order_fee_query。',
  netPnLRule: '判断是否平仓/回补时必须优先看 estimatedNetUnrealizedPnL，而不是只看 unrealizedPnL。',
  grossProfitButNetLossRule: '若 grossProfitButNetLoss 为 true，说明毛浮盈为正但扣除开平仓估算费用后为亏损；除非用于止损、降低风险或避免更大回撤，不应仅因毛浮盈为正而平仓。',
}
```

- 在 system prompt 中强化：

```text
必须把交易费用作为净收益判断的一部分；如果持仓毛浮盈小于预计平仓费用或回合费用，不能把该持仓视为真实盈利。
```

- 在 `requiredJson.reason` 或 `riskAssessment` 要求中补充：
  - 若决策涉及平仓/回补，理由必须说明是否覆盖预估费用。

目的：

- 让模型避免“看到浮盈就平仓”的错误。
- 让模型在持仓盈利很小但费用较高时倾向 HOLD，除非明确是在止损或降风险。

### 5. 强提醒但不硬阻断

文件：`api/simulation/llmTradingDecisionService.ts`

按用户选择，本次不新增后端硬阻断规则。

不做：

- 不因 `estimatedNetUnrealizedPnL < 0` 自动拒绝 `SELL_TO_CLOSE` / `BUY`。
- 不阻止止损型平仓或空头回补。

只做：

- prompt 中明确费用后的净收益语义。
- 让模型理由和风险评估显式考虑费用覆盖。

原因：

- 平仓/回补可能是为了止损、降低空头挤压风险或控制仓位，而不一定追求本次净盈利。
- 硬阻断会误杀风险降低动作。

### 6. 前端展示可选增强

文件：`src/pages/SimulationTradingView.tsx`

计划不强制新增 UI，但建议在“历史策略信号”或“持仓/交易理由”中保持模型输出原文，让用户看到模型是否提到费用覆盖。

不新增独立费用表格，避免本次范围过大。

如果后续需要，可单独规划：

- 持仓表新增“扣费后净浮盈”列
- 模拟订单详情新增“预估开仓费/平仓费/回合费用”

本次核心目标是模型决策上下文正确。

## Assumptions & Decisions

- Futu SIMULATE 无法通过 `order_fee_query` 获取真实费用，已验证返回 `Paper trading is not supported.`。
- 当前方案使用估算费用，字段明确标记 `source: estimated`。
- 估算参数沿用当前后端已有模型：
  - 每笔最低费用 `$1.00`
  - 每股 `$0.005`
  - 名义金额 `1bp` 监管/滑点预留
- 本次不新增费用 UI 配置，不写入 SQLite。
- 本次不把 Futu 订单状态或费用同步到 SQLite，继续遵守“真实订单状态以 OpenD 实时接口为准”的约束。
- 本次不改大模型动作集合，不改仓位算法，不改下单串行逻辑。
- 本次不做硬风控阻断，只做结构化上下文和 prompt 强提醒。

## Verification Steps

### 1. 类型检查

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/tsc --noEmit
```

### 2. 单元测试

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/vitest run tests/llmAutonomousTrading.test.ts
```

新增测试点：

- `buildPositionFeeContext(...)` 对毛浮盈 `$4`、开仓费 `$3`、平仓费 `$3` 的场景，计算 `estimatedNetUnrealizedPnL = -2`，且 `grossProfitButNetLoss = true`。
- `buildDecisionPrompt(...)` 的 `currentPosition.estimatedFeeContext` 存在。
- `portfolioContext.feeContextRules` 包含“优先看 estimatedNetUnrealizedPnL”。
- 平仓/回补 prompt 中包含“覆盖预估费用”的要求。

### 3. 运行时只读验证

在量化引擎停止状态下调用 `/api/simulation/llm-test` 或构造测试 prompt，确认：

- prompt 不包含 API Key、Authorization、完整账户敏感明细之外的新增敏感内容。
- 对有持仓标的，`estimatedFeeContext` 包含：
  - `grossUnrealizedPnL`
  - `estimatedExitFee`
  - `estimatedRoundTripFee`
  - `estimatedNetUnrealizedPnL`
  - `grossProfitButNetLoss`

### 4. 行为验收

人工检查一次真实持仓，例如：

```text
SPCX qty=-5
unrealizedPnL=$0.10
```

预期：

- prompt 中该持仓会显示扣费后净收益为负。
- 模型不应再把 `$0.10` 毛浮盈当成可盈利回补依据。
- 如果模型仍建议回补，理由应是止损、降低风险、避免更大回撤，而不是“已经盈利”。

