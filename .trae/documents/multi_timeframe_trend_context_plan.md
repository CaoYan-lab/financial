# 多周期趋势上下文交易策略改造方案

## 背景与问题

当前模拟盘大模型交易主要基于短周期输入：

- 最近 `30-240` 根 `1m K线`
- 最近分时/逐笔点
- 当前盘口
- 当前持仓、账户、费用上下文

这会让模型天然偏向短线量化：只看近 `30-120min` 的价格波动，容易把噪声当成交易信号，导致频繁开仓、逆势交易或过早平仓。用户观察到启动量化运行较久后收益表现不好，符合这个输入结构的风险。

目标不是简单把过去 7 天全量 `1m K线` 塞给模型，而是建立“短周期执行 + 多周期趋势过滤”的决策结构：

- 短周期数据负责交易执行与价格选择。
- 7 日趋势上下文负责判断方向、过滤噪声、避免逆大周期开仓。
- prompt 中写入硬约束，禁止模型只凭短周期噪声交易。

## 目标

1. 给每轮模型决策增加过去 7 个交易日的趋势上下文。
2. 保留当前 `1m K线 / 分时 / 盘口` 作为执行层数据。
3. 后端先把 7 日历史 K线压缩成结构化摘要，避免传入过大的 token。
4. prompt 明确要求模型区分：
   - `executionWindow`：短周期执行窗口
   - `trendContextWindow`：中期趋势过滤窗口
   - `tradeHorizon`：本次决策预期持仓周期
5. 开仓必须通过趋势一致性检查；趋势冲突时默认 `HOLD`。
6. 趋势数据缺失时 fail-closed：禁止新开仓，但允许风险降低动作。
7. 历史策略信号记录本轮趋势上下文摘要，方便复盘。

## 非目标

- 不切换到全自动长期投资策略。
- 不把过去 7 天所有 `1m K线` 原样传给模型。
- 不取消短周期盘口、分时、`1m K线`。
- 不绕过现有风控、费用估算、订单类型和 Futu 下单逻辑。
- 不保证收益，只降低短线噪声交易概率，提高决策可解释性。

## 当前状态分析

### 数据窗口顾问

文件：`api/simulation/llmDataWindowAdvisor.ts`

当前默认：

```ts
const DEFAULT_RECOMMENDATION: LlmDataWindowRecommendation = {
  kline1mBars: 120,
  tickerPoints: 240,
  orderBookDepth: 5,
  pollIntervalSeconds: 60,
  reason: '大模型窗口建议不可用，使用默认数据窗口。',
  source: 'fallback',
}
```

当前 bounds：

```ts
kline1mBars: { min: 30, max: Math.max(30, Math.min(240, availability?.minKline1mBars || 240)) }
```

因此模型最多只能看到约 4 小时 `1m K线`。

### 交易决策 prompt

文件：`api/simulation/llmTradingDecisionService.ts`

当前传入：

```ts
marketData: {
  recentKlineBars: input.marketData.bars.slice(-input.dataWindow.kline1mBars),
  recentTickerPoints: input.marketData.tickerPoints.slice(-input.dataWindow.tickerPoints),
  asks: input.marketData.asks.slice(0, input.dataWindow.orderBookDepth),
  bids: input.marketData.bids.slice(0, input.dataWindow.orderBookDepth),
}
```

当前 prompt 没有显式多周期趋势上下文，也没有硬性要求“短周期信号必须接受中期趋势过滤”。

### 实时数据适配器

文件：`api/simulation/realtimeDataAdapter.ts`

当前只从 `realtimeStore` 读取实时缓存：

- `snapshot.klineBars`
- `snapshot.tickerPoints`
- `snapshot.asks`
- `snapshot.bids`

这适合作为执行层，不适合承载过去 7 天趋势。

## 设计方案

### 1. 新增趋势上下文类型

文件：`shared/types.ts`

新增：

```ts
export type TrendContextWindow = {
  lookbackTradingDays: number
  barInterval: '15m' | '30m' | '1d'
  source: 'futu-history-kline'
  available: boolean
  reason?: string
}

export type TrendContextSummary = {
  ticker: string
  window: TrendContextWindow
  currentPrice: number
  previousClose?: number
  sevenDayHigh?: number
  sevenDayLow?: number
  pricePositionInRange?: number
  trendDirection: 'UP' | 'DOWN' | 'SIDEWAYS' | 'UNKNOWN'
  trendStrength: 'WEAK' | 'MEDIUM' | 'STRONG' | 'UNKNOWN'
  volatilityLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN'
  movingAverages: {
    short?: number
    medium?: number
    long?: number
  }
  supportLevels: number[]
  resistanceLevels: number[]
  summary: string
  updatedAt: string
}
```

说明：

- `pricePositionInRange`：当前价格在 7 日高低区间的位置，范围 `0-1`。
- `trendDirection`：用于 prompt 的方向过滤。
- `supportLevels/resistanceLevels`：后端粗略计算，不要求复杂技术分析。
- `summary`：中文摘要，便于模型读取。

### 2. 扩展数据窗口建议

文件：`shared/types.ts`

当前 `LlmDataWindowRecommendation` 只包含执行层数据窗口。建议扩展：

```ts
export type LlmDataWindowRecommendation = {
  kline1mBars: number
  tickerPoints: number
  orderBookDepth: number
  pollIntervalSeconds: number
  trendLookbackTradingDays?: number
  trendBarInterval?: '15m' | '30m' | '1d'
  strategyHorizon?: 'INTRADAY' | 'SWING_1_TO_7_DAYS'
  reason: string
  source: 'llm' | 'fallback'
}
```

默认值：

```ts
trendLookbackTradingDays: 7
trendBarInterval: '30m'
strategyHorizon: 'SWING_1_TO_7_DAYS'
```

决策：

- 执行层继续使用 `1m`，默认 `120` 根。
- 趋势层默认使用过去 `7` 个交易日的 `30m K线`。
- `30m` 比 `15m` token 更少，趋势更稳定；比 `1d` 更能反映盘前/盘后结构。

### 3. 新增趋势上下文服务

新增文件：`api/simulation/trendContextService.ts`

职责：

1. 对每个 ticker 拉取过去 7 个交易日历史 K线。
2. 计算结构化趋势摘要。
3. 做短 TTL 缓存，避免每轮每标的重复请求 Futu。
4. 数据失败时返回 `available=false`，由交易决策执行 fail-closed。

建议接口：

```ts
export async function loadTrendContext(
  ticker: string,
  input: {
    lookbackTradingDays: number
    barInterval: '15m' | '30m' | '1d'
    currentPrice: number
  },
): Promise<TrendContextSummary>
```

缓存策略：

- key：`${ticker}:${lookbackTradingDays}:${barInterval}`
- TTL：`5 分钟`
- 原因：趋势层不需要每 60 秒重新拉全量历史，避免 Futu API 压力。

### 4. 新增 Futu 历史 K线桥接

新增文件：`api/futu_bridge/futu_history_kline.py`

用途：

- 给后端趋势服务查询历史 K线。
- 不复用实时订阅缓存，避免把趋势层绑定到实时进程。

输入：

```json
{
  "ticker": "NVDA",
  "interval": "30m",
  "startDate": "2026-06-10",
  "endDate": "2026-06-17",
  "session": "ALL"
}
```

输出：

```json
{
  "ok": true,
  "ticker": "NVDA",
  "bars": [
    { "time": "...", "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 123456 }
  ],
  "warnings": []
}
```

交易时段规则：

- 趋势上下文默认使用 `Session.ALL`，让盘前、盘后、夜盘也能看到连续背景。
- 若后续发现夜盘数据噪声过高，可在趋势摘要中分别统计 RTH 与 ALL，但第一版先不复杂化。

### 5. 趋势摘要计算规则

文件：`api/simulation/trendContextService.ts`

第一版使用确定性规则，不再让模型自己从长 K线里猜：

```ts
sevenDayHigh = max(high)
sevenDayLow = min(low)
pricePositionInRange = (currentPrice - sevenDayLow) / (sevenDayHigh - sevenDayLow)
shortMa = MA(close, 6)
mediumMa = MA(close, 13)
longMa = MA(close, 26)
```

趋势方向：

- `UP`：`shortMa > mediumMa > longMa` 且最近 close 高于 `mediumMa`
- `DOWN`：`shortMa < mediumMa < longMa` 且最近 close 低于 `mediumMa`
- 否则 `SIDEWAYS`

趋势强度：

- 用 `abs(shortMa - longMa) / currentPrice` 和最近波动判断：
  - `< 0.5%`：`WEAK`
  - `0.5%-1.5%`：`MEDIUM`
  - `> 1.5%`：`STRONG`

波动率：

- 使用最近 `30m` bar 的平均 high-low range：
  - `< 1%`：`LOW`
  - `1%-3%`：`MEDIUM`
  - `> 3%`：`HIGH`

支撑阻力：

- 第一版取最近 7 日低点、高点、以及靠近当前价格的局部 high/low。
- 数量控制：
  - `supportLevels` 最多 3 个
  - `resistanceLevels` 最多 3 个

### 6. 扩展交易决策输入

文件：`api/simulation/llmTradingDecisionService.ts`

`DecisionInput` 增加：

```ts
trendContext?: TrendContextSummary
```

prompt 的 `marketData` 改成两层：

```ts
marketData: {
  executionWindow: {
    recentKlineBars,
    recentTickerPoints,
    asks,
    bids,
    updatedAt,
  },
  trendContext: input.trendContext,
}
```

同时保留原字段兼容可读性也可以，但推荐用新结构让模型明确区分。

### 7. 增加 prompt 硬约束

文件：`api/simulation/llmTradingDecisionService.ts`

在 `hardConstraints` 增加：

```ts
'必须把 executionWindow 视为执行层，把 trendContext 视为方向过滤层。',
'禁止仅凭 30-120 分钟短期波动开仓。',
'若短期信号与 7 日趋势方向冲突，默认 HOLD，除非 reason 中明确给出趋势反转证据、风险收益比和费用覆盖理由。',
'若 trendContext.available=false，禁止新开 BUY 或 SELL_SHORT；但允许 SELL_TO_CLOSE、BUY 回补空头等降低风险动作。',
```

在 `requiredJson` 增加：

```ts
trendAlignment: 'WITH_TREND | AGAINST_TREND | REVERSAL_ATTEMPT | NO_TREND | UNAVAILABLE'
tradeHorizon: 'SCALP | INTRADAY | SWING_1_TO_7_DAYS'
whyNotNoise: '中文说明：为什么这不是仅由短周期噪声触发'
```

### 8. 解析和归一化模型输出

文件：`shared/types.ts`

扩展 `LlmTradingDecision`：

```ts
trendAlignment?: 'WITH_TREND' | 'AGAINST_TREND' | 'REVERSAL_ATTEMPT' | 'NO_TREND' | 'UNAVAILABLE'
tradeHorizon?: 'SCALP' | 'INTRADAY' | 'SWING_1_TO_7_DAYS'
whyNotNoise?: string
```

文件：`api/simulation/llmTradingDecisionService.ts`

在 `parseTradingDecision` 中解析这些字段。若缺失：

- `trendAlignment` 默认 `UNAVAILABLE`
- `tradeHorizon` 默认 `INTRADAY`
- `whyNotNoise` 默认 `'模型未说明短周期噪声过滤依据。'`

### 9. 后端 fail-closed 规则

文件：`api/simulation/simulationTradingEngine.ts`

每个 ticker 决策前：

1. 先加载执行层 `marketData`。
2. 再加载 `trendContext`。
3. 若 `trendContext.available=false`：
   - 如果当前无持仓：跳过新开仓，写 skipped log。
   - 如果已有持仓：仍允许进入模型决策，但 prompt 明确只能做风险降低动作或 HOLD。

推荐第一版逻辑：

- 不在后端硬拦截已有持仓。
- 对无持仓且趋势数据不可用，后端直接 skipped，避免模型乱开仓。
- 对已有持仓，模型可根据实时风险做止损/回补/平仓。

### 10. 历史策略信号记录趋势上下文

文件：`shared/types.ts`

扩展 `QuantSignal`：

```ts
trendContext?: {
  available: boolean
  lookbackTradingDays: number
  barInterval: string
  trendDirection: string
  trendStrength: string
  pricePositionInRange?: number
  summary: string
}
trendAlignment?: string
tradeHorizon?: string
whyNotNoise?: string
```

文件：`api/simulation/simulationTradingEngine.ts`

`signalFromDecision(...)` 增加：

- `trendContext`
- `trendAlignment`
- `tradeHorizon`
- `whyNotNoise`

### 11. 前端展示增强

文件：`src/pages/SimulationTradingView.tsx`

历史策略信号表新增或合并展示：

- 趋势方向：`UP / DOWN / SIDEWAYS / UNKNOWN`
- 趋势一致性：`WITH_TREND / AGAINST_TREND / REVERSAL_ATTEMPT / NO_TREND`
- 交易周期：`INTRADAY / SWING_1_TO_7_DAYS`

为避免表格过宽，建议：

- 不新增过多列。
- 在“数据窗口”列追加：

```text
执行: 120 x 1m / 240 分时 / 5 档
趋势: 7日 30m / UP / WITH_TREND
```

详情页 `SimulationOrderDetailView.tsx` 的历史策略信号卡片增加完整展示：

- `trendContext.summary`
- `trendAlignment`
- `tradeHorizon`
- `whyNotNoise`

### 12. 数据窗口文案调整

文件：`api/simulation/simulationTradingEngine.ts`

当前：

```ts
dataWindow: `${decision.dataWindowUsed.kline1mBars} x 1m K线 / ${decision.dataWindowUsed.tickerPoints} 分时点 / ${decision.dataWindowUsed.orderBookDepth} 档摆盘 @ ${updatedAt}`
```

改为：

```text
执行: 120 x 1m K线 / 240 分时点 / 5 档摆盘 @ updatedAt
趋势: 7日 30m K线 / UP / MEDIUM
```

## 推荐默认策略规则

### 开多 BUY

允许条件：

- 趋势 `UP` 或 `SIDEWAYS` 且当前价格接近支撑。
- 短周期执行窗口出现确认信号。
- 盘口流动性允许，费用后仍有合理空间。

禁止条件：

- 7 日趋势为 `DOWN` 且没有明确反转证据。
- 当前价格处于 7 日区间高位但短周期只是小幅追涨。

### 卖空 SELL_SHORT

允许条件：

- 趋势 `DOWN` 或 `SIDEWAYS` 且接近阻力。
- 短周期弱势确认。
- 费用、滑点和回补风险可控。

禁止条件：

- 7 日趋势为 `UP` 且只是短周期回调。
- 盘前/盘后流动性差，买卖价差过大。

### 平多 SELL_TO_CLOSE

允许条件：

- 趋势转弱。
- 费用后净收益合理。
- 或用于止损/降低风险。

### 回补空头 BUY

允许条件：

- 趋势转强。
- 短周期反弹风险升高。
- 或费用后净亏扩大风险需要控制。

说明：

- 空头回补不以购买力作为主要判断依据。
- 继续沿用现有空头回补购买力文案清理规则。

## 测试计划

### 单元测试

新增/更新 `tests/llmAutonomousTrading.test.ts`：

1. prompt 包含 `executionWindow` 和 `trendContext`。
2. trendContext 不可用时，无持仓新开仓被 skipped。
3. trendContext 不可用但已有空头时，允许 `BUY` 回补。
4. 模型返回缺失 `trendAlignment/tradeHorizon/whyNotNoise` 时能默认填充。
5. `QuantSignal.dataWindow` 包含执行窗口和趋势窗口。
6. `grossProfitButNetLoss` 费用逻辑仍然保留。

新增 `tests/trendContextService.test.ts`：

1. 正确计算 7 日高低点。
2. 正确计算当前价格区间位置。
3. MA 多头排列输出 `UP`。
4. MA 空头排列输出 `DOWN`。
5. 横盘输出 `SIDEWAYS`。
6. 数据不足时输出 `available=false`。

### 类型检查

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/tsc --noEmit
```

### Python 检查

```bash
python3 -m py_compile api/futu_bridge/futu_history_kline.py
```

### 回归测试

```bash
PATH="$PWD/.tools/node/bin:$PATH" node_modules/.bin/vitest run tests/llmAutonomousTrading.test.ts tests/simulationPersistence.test.ts tests/simulationStore.test.ts
```

### 手工验证

1. 启动实时订阅和后端服务。
2. 打开模拟盘。
3. 启动量化。
4. 后端日志中应出现趋势上下文加载结果。
5. 历史策略信号的数据窗口应显示执行窗口和趋势窗口。
6. 详情页能看到：
   - 趋势方向
   - 趋势强度
   - 趋势一致性
   - `whyNotNoise`
7. 若 Futu 历史 K线不可用，无持仓标的不应新开仓，应进入 skipped log。

## 风险与取舍

## 历史交易回放评测

评测时间：`2026-06-17`

数据来源：

- SQLite 历史库：`.data/simulation-history.sqlite3`
- 历史策略信号：`simulation_events.kind = signals`
- 历史模拟订单：`simulation_events.kind = orders`
- Futu 订单状态接口：`GET /api/simulation/futu-orders`
- 模拟盘账户接口：`GET /api/simulation/accounts`

### 1. 历史策略信号与历史订单关联完整性

读取结果：

- 历史策略信号：`2410` 条
- 历史模拟订单：`173` 条
- 时间范围：`2026-06-17T05:57:16.527Z` 至 `2026-06-17T12:12:10.106Z`
- 所有 `173` 条历史模拟订单均能关联到历史策略信号
  - `36` 条为精确 `signalId` 关联
  - `137` 条为旧数据通过 `ticker + side + submittedAt ±5 秒` fallback 关联
  - `0` 条关联缺失

结论：

- 历史记录本身是完整的，没有发现“有订单但找不到策略信号”的缺口。
- 大量 fallback 是早前订单 `signalId` 未复用策略信号 `id` 的历史遗留问题，不代表当前落库缺失。
- 这次收益不佳的主要矛盾不是历史漏记，而是交易决策逻辑过度依赖短周期信号。

### 2. 信号与订单动作分布

历史策略信号动作分布：

| 动作 | 数量 |
| --- | ---: |
| `HOLD` | `2215` |
| `BUY` | `100` |
| `SELL_SHORT` | `68` |
| `SELL_TO_CLOSE` | `27` |

历史模拟订单动作分布：

| 动作 | 数量 |
| --- | ---: |
| `BUY` | `84` |
| `SELL_SHORT` | `62` |
| `SELL_TO_CLOSE` | `27` |

订单执行结果：

| 结果 | 数量 |
| --- | ---: |
| `ok=true` 本地成功提交 | `55` |
| `ok=false` 风控/桥接失败/未提交 | `118` |

Futu 最终状态核对：

- 本地 `55` 笔 `ok=true` 订单全部能在 Futu 订单状态中匹配。
- 这 `55` 笔最终均为 `全部成交`。
- 因此历史模拟订单中的成功提交不是虚记录，而是真实影响了模拟盘持仓和盈亏。

### 3. 已成交订单结构

本地成功且 Futu 全部成交订单共 `55` 笔：

| 动作 | 成交笔数 |
| --- | ---: |
| `SELL_SHORT` | `25` |
| `BUY` | `25` |
| `SELL_TO_CLOSE` | `5` |

按标的成交活跃度：

| 标的 | 成交笔数 | 估算成交名义金额 | 动作结构 |
| --- | ---: | ---: | --- |
| `SNDK` | `9` | `$51,063.28` | `BUY 5 / SELL_SHORT 4` |
| `TSM` | `9` | `$26,341.78` | `SELL_TO_CLOSE 1 / SELL_SHORT 4 / BUY 4` |
| `SPCX` | `7` | `$17,601.30` | `BUY 3 / SELL_TO_CLOSE 2 / SELL_SHORT 2` |
| `MU` | `10` | `$16,868.48` | `SELL_SHORT 4 / BUY 5 / SELL_TO_CLOSE 1` |
| `AMZN` | `3` | `$16,005.85` | `SELL_SHORT 2 / BUY 1` |
| `INTC` | `5` | `$15,518.24` | `BUY 2 / SELL_TO_CLOSE 1 / SELL_SHORT 2` |
| `TSLA` | `3` | `$9,257.58` | `SELL_SHORT 2 / BUY 1` |
| `GOOG` | `2` | `$7,385.60` | `SELL_SHORT 1 / BUY 1` |
| `AMD` | `3` | `$4,683.10` | `SELL_SHORT 2 / BUY 1` |
| `NVDA` | `4` | `$4,161.35` | `SELL_SHORT 2 / BUY 2` |

典型动作序列：

```text
SNDK: BUY -> SELL_SHORT -> BUY -> SELL_SHORT -> BUY -> SELL_SHORT -> BUY -> SELL_SHORT -> BUY
TSM : SELL_TO_CLOSE -> SELL_SHORT -> BUY -> BUY -> SELL_SHORT -> SELL_SHORT -> BUY -> SELL_SHORT -> BUY
MU  : SELL_SHORT -> BUY -> SELL_SHORT -> BUY -> BUY -> SELL_TO_CLOSE -> SELL_SHORT -> BUY -> SELL_SHORT -> BUY
SPCX: BUY -> SELL_TO_CLOSE -> SELL_SHORT -> BUY -> BUY -> SELL_TO_CLOSE -> SELL_SHORT
```

结论：

- 多个标的出现明显的开仓、回补/平仓、再开仓循环。
- `SNDK`、`TSM`、`MU`、`SPCX` 的交易频率明显偏高。
- 这符合“短周期窗口诱导模型做短线噪声交易”的预期风险。

### 4. 模型理由审计

对 `55` 笔最终成交订单的策略理由做关键词审计：

- `51 / 55` 笔明确依赖短周期描述，例如：
  - `1分钟`
  - `1 分钟`
  - `K线`
  - `分时`
  - `短期`
  - `盘前价格`
- `55 / 55` 笔都没有出现 7 日趋势、中期趋势、多周期过滤等上下文。
- 至少 `8` 笔平仓/回补理由属于“锁定微利”或接近微利逻辑。

样例：

```text
SPCX SELL_SHORT:
盘前价格从 206 附近持续下跌至 204.4，K 线呈下降趋势，分时成交在 204.4 附近弱势整理。

TSM BUY 回补:
最近30根1分钟K线及分时点显示买盘持续推高，短期动能偏多。

SNDK BUY 回补:
净盈利约 0.21 美元，虽微薄但为正。为避免盘前波动导致浮盈消失。
```

结论：

- 当前 prompt 没有要求模型证明“这不是短周期噪声”。
- 模型会把很短时间内的下跌/反弹解释为可交易信号。
- 费用上下文虽然已加入，但只能阻止“毛盈利但扣费后亏损”的一部分问题，不能解决趋势层缺失导致的反复交易。

### 5. 今日盈亏与持仓归因

账户读取结果存在实时浮动。两次读取期间，今日盈亏从约 `-$214.56` 波动到 `-$172.51`。以下以较新的账户快照为准：

| 指标 | 数值 |
| --- | ---: |
| 总资产 | `$49,977.70` |
| 今日盈亏 | `-$172.51` |
| 总盈亏 | `-$14.93` |

当前持仓：

| 标的 | 数量 | 当前价 | 今日盈亏 | 未实现盈亏 |
| --- | ---: | ---: | ---: | ---: |
| `SPCX` | `-5` | `$204.09` | `-$105.23` | `$0.03` |
| `AMD` | `-5` | `$519.32` | `$6.50` | `$0.51` |
| `INTC` | `-10` | `$120.73` | `-$88.04` | `-$5.60` |
| `AMZN` | `-5` | `$246.00` | `-$27.35` | `-$1.25` |
| `TSLA` | `-3` | `$401.60` | `$8.58` | `$1.08` |
| `TSM` | `0` | `$431.43` | `$33.03` | `-$9.70` |

亏损集中来源：

- `SPCX`: `-$105.23`
- `INTC`: `-$88.04`
- `AMZN`: `-$27.35`

这三个标的合计约 `-$220.62`，已经超过账户整体今日亏损，说明少数短周期方向判断错误对今日结果影响很大。

### 6. 用新方案回看历史交易是否合理

按“短周期执行 + 7 日趋势过滤”的新方案回看，当前历史交易可以分为三类：

#### A. 风险降低动作：相对合理

例如：

- 空头亏损扩大时 `BUY` 回补
- 多头持续亏损时 `SELL_TO_CLOSE`
- 费用后净收益为正且趋势不明时减小敞口

这些动作即使在新方案下也应被允许，因为它们属于风险降低，而不是新开方向风险。

但新方案会要求模型补充：

- 当前动作是否顺应 7 日趋势
- 是否只是短周期反弹/回落
- 为什么不继续持有
- 为什么不是短周期噪声

#### B. 微利回补/频繁平仓：部分不合理

例如：

- `SNDK` 多次 `SELL_SHORT -> BUY`
- `TSM` 多次 `SELL_SHORT -> BUY`
- 部分理由明确是“净盈利约 0.x 美元，锁定微利”

这些交易即使扣费后为正，也容易被滑点、盘口变化和下一轮信号反转吞噬。

新方案下，这类交易会被要求说明：

- `tradeHorizon` 是否真的只是 `SCALP`
- 若是 `SCALP`，为什么值得在模拟盘中频繁做
- 是否与 7 日趋势一致
- 若只是短周期噪声，默认 `HOLD`

评估：新方案大概率会减少这类交易。

#### C. 无持仓新开仓：当前最需要趋势过滤

典型问题：

- `SPCX SELL_SHORT` 理由只基于盘前从 `206` 跌到 `204.4`、`K线/分时弱势`
- `AMZN SELL_SHORT` 理由只基于盘前持续下跌和短周期弱势
- `INTC SELL_SHORT` 理由只基于短期下跌趋势
- `TSLA/NVDA/AMD` 多数开空也以 `1m K线/分时/盘前卖压` 为主

新方案下，无持仓新开仓必须满足：

- 趋势上下文可用
- 7 日趋势不冲突，或有明确反转证据
- `whyNotNoise` 解释充分
- 费用和盘口仍然通过

评估：如果新方案生效，当前不少无持仓 `SELL_SHORT` 会被降级为 `HOLD` 或至少需要更高证据门槛。

### 7. 新方案是否会让收益更好

不能仅凭这一次历史记录严格证明“收益一定更明显”，因为当前还没有真实的 7 日历史 K线回放结果，也没有逐笔执行前后的完整市场路径回测。

但从这次历史审计看，新方案大概率会改善当前策略的风险收益结构，原因是：

1. 当前实际亏损集中在少数短周期方向判断错误的标的上。
2. 当前 `55` 笔成交中 `51` 笔理由依赖短周期信号，且全部缺少 7 日趋势过滤。
3. 多个标的出现高频开仓、回补、再开仓循环，说明模型在短窗口里频繁改变方向。
4. 新方案会直接提高无持仓新开仓门槛，尤其是 `SELL_SHORT`。
5. 新方案不会禁止已有持仓的止损/回补，因此不会牺牲必要的风险控制。

预期改进：

- 成交笔数下降。
- 交易费用和滑点损耗下降。
- 逆中期趋势开仓减少。
- 短周期噪声触发的新仓减少。
- 历史策略信号更可复盘，因为会记录 `trendAlignment/tradeHorizon/whyNotNoise`。

收益判断：

- 更准确的说法是：新方案更可能降低当前这种短线噪声造成的亏损和回撤。
- 是否“收益更明显”需要上线后比较至少几个交易时段：
  - 每轮成交数
  - 新开仓胜率
  - 平均持仓时间
  - 费用后净盈亏
  - `AGAINST_TREND` 交易占比

### 8. 基于评测的方案调整

基于本次历史回放，原方案建议做两处强化：

#### 强化 1：第一版就加入后端硬拦截

原方案中提到：

```text
先不做后端硬拦截 AGAINST_TREND，第一版由 prompt 约束并持久化复盘字段。
```

评测后建议调整为：

- 对无持仓新开仓，若 `trendContext.available=false`，后端直接 skipped。
- 对无持仓新开仓，若模型返回 `trendAlignment=AGAINST_TREND` 且 `tradeHorizon` 不是明确的 `REVERSAL_ATTEMPT`，后端直接 skipped。
- 对无持仓新开仓，若 `whyNotNoise` 为空或过短，后端直接 skipped。

理由：

- 当前亏损主要来自短周期新开方向风险。
- 仅靠 prompt 可能仍被模型编造短线理由绕过。
- 后端硬拦截只限制新开仓，不限制平仓/回补等风险降低动作。

#### 强化 2：限制 SCALP 类交易

新增规则：

- 第一版不允许模型主动选择 `tradeHorizon=SCALP` 进行新开仓。
- 允许 `SCALP` 只用于已有持仓的风险降低动作，例如回补空头或平掉多头。

理由：

- 当前系统轮询周期约 60 秒，Futu 模拟盘盘前/盘后流动性有限。
- 多数“锁定微利”交易对费用和滑点非常敏感。
- 当前历史已经出现多次微利回补和再开仓循环。

#### 强化 3：历史评测指标纳入上线观察

上线后在日志或历史信号中持续观察：

- 每小时新开仓数量
- 每小时平仓/回补数量
- 同标的 30 分钟内反向交易次数
- `WITH_TREND / AGAINST_TREND / REVERSAL_ATTEMPT / NO_TREND` 分布
- `SCALP / INTRADAY / SWING_1_TO_7_DAYS` 分布
- 费用后净盈亏

若新方案仍出现短时间同标的反复开平，应继续收紧：

- 增加同标的冷却时间
- 增加趋势一致性硬拦截
- 增加最低预期收益/费用倍数，例如预期收益至少覆盖 `3x` 往返费用

### 风险 1：Futu 历史 K线请求增加 API 压力

缓解：

- 使用 5 分钟 TTL。
- 每轮只在缓存过期时查询。
- 趋势层使用 `30m` K线而不是 `1m`。

### 风险 2：趋势过滤导致交易机会减少

这是预期结果。当前问题是短线噪声交易过多，第一版应优先降低误交易，而不是追求频繁交易。

### 风险 3：盘前/盘后趋势和 RTH 趋势混杂

第一版使用 `Session.ALL`，保证扩展时段可用。后续如果发现扩展时段噪声过高，再拆成：

- `trendContextRth`
- `trendContextAllSessions`

### 风险 4：模型仍然编造反转理由

缓解：

- prompt 要求 `whyNotNoise`。
- 历史信号持久化 `trendAlignment` 和 `whyNotNoise`，方便复盘审计。
- 后续可增加后端硬规则：`AGAINST_TREND` 且非已有持仓风险降低动作时直接拦截。

## 分阶段落地

### Phase 1：趋势摘要后端能力

- 新增 `futu_history_kline.py`
- 新增 `trendContextService.ts`
- 新增趋势摘要类型
- 新增趋势服务单测

### Phase 2：交易 prompt 和决策解析

- 扩展 `DecisionInput`
- prompt 增加 `executionWindow/trendContext`
- prompt 增加趋势过滤硬约束
- `LlmTradingDecision` 增加趋势字段
- 解析模型返回字段

### Phase 3：引擎接入与 fail-closed

- `simulationTradingEngine.ts` 每个 ticker 加载 trend context
- 无持仓且 trend context 不可用时 skipped
- 有持仓时允许风险降低决策
- 历史策略信号记录趋势摘要

### Phase 4：前端复盘展示

- 历史策略信号数据窗口显示趋势摘要
- 详情页展示完整趋势上下文

### Phase 5：验证与调参

- 跑单测和类型检查
- 启动模拟盘观察至少 2-3 轮
- 检查是否减少逆势新开仓和短周期噪声交易

## 建议确认点

默认建议如下：

1. 趋势窗口：过去 `7` 个交易日。
2. 趋势 K线周期：`30m`。
3. 趋势 session：`Session.ALL`。
4. 趋势不可用：
   - 无持仓：禁止新开仓，写 skipped log。
   - 有持仓：允许风险降低动作或 HOLD。
5. 先不做后端硬拦截 `AGAINST_TREND`，第一版由 prompt 约束并持久化复盘字段；如果仍乱交易，再加硬拦截。
