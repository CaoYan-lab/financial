# Futu 财报与盘后催化接入 LLM 计划

## Summary

目标是解决“盘后财报大超预期、半导体板块盘后大涨，但实盘 LLM 没理解到催化”的问题。

方案采用“Futu 优先 + Longbridge 兜底”的数据源策略：

* 优先使用当前本机 `futu-api 10.07.6708` 已支持的 F10 / Stock Fundamentals API。

* 在关键盘后/盘前催化窗口，将财报、财报日前后价格表现、分析师评级/预期摘要、板块联动信号结构化后注入实盘单标的 LLM Prompt。

* 财报上下文不常驻喂给 LLM。必须经过“事件门控”判定，只有财报新鲜度、交易时段、价格异动或持仓风险满足条件时才注入完整上下文。

* 如果 Futu OpenD、权限、接口时效或字段缺失导致无法获取财报上下文，则用项目已有 Longbridge 能力作为兜底数据源，并把降级原因写入 LLM 上下文和日志。

* 不让 LLM 只靠 1m K 线、盘口、ticker points 判断盘后异动；财报发布后的异常跳涨必须有“催化事件上下文”。

## Current State Analysis

### 当前 Futu 能力

当前仓库已有 Futu Python bridge，主要包括：

* `api/futu_bridge/futu_realtime_subscribe.py`：实时 quote / ticker / kline / order book 订阅。

* `api/futu_bridge/futu_history_kline.py`：历史 K 线，当前趋势上下文依赖它。

* `api/futu_bridge/futu_snapshot.py`：市场快照、技术指标、期权链/期权快照。

* `api/futu_bridge/futu_account.py`、`futu_live_order.py`、`futu_live_fee.py`：账户、下单、费用。

当前实盘 LLM 数据流：

* `api/live/liveTradingEngine.ts`

  * 在每个 ticker 评估时调用 `loadStrategyMarketData(...)` 获取 Futu 实时缓存。

  * 调用 `loadTrendContext(...)` 获取 7 日 / 30m 趋势。

  * 调用 `requestLiveTradingDecision(...)` 让单标的 LLM 决策。

* `api/live/liveTradingDecisionService.ts`

  * Prompt 当前只注入 `marketData`、`trendContext`、账户、持仓、风控。

  * 没有注入财报、公告、分析师预期、财报后价格反应、板块联动催化。

* `api/simulation/realtimeDataAdapter.ts`

  * `StrategyMarketData` 当前只包含价格、K 线、分时点、盘口、市场状态。

### 当前缺口

1. Futu 实盘链路没有财报数据 bridge。
2. LLM Prompt 没有 `eventContext` / `earningsContext`。
3. 盘后异动只表现为价格跳涨，LLM 不知道是财报驱动、板块驱动，容易按“短线噪声/追高风险”处理。
4. 组合策略候选池也没有收到财报催化字段，组合裁决无法按“重大催化新信息”提高优先级。
5. 当前 Longbridge CLI 在本机命令行不可用，但项目已有 `api/longbridge` 适配层和 longbridge skill 能力描述，适合作为后续兜底路径。
6. 当前项目已有市场状态归一化和 LLM 时段门禁：
   * `api/simulation/usOvernightLlmGate.ts` 可识别 `PRE_MARKET_BEGIN`、`AFTER_HOURS_BEGIN`、`OVERNIGHT` 等。
   * `api/simulation/marketSessionService.ts` 已将盘前/盘后视为可交易扩展时段。
   * `api/live/liveTradingEngine.ts` 当前默认仍受 `disableUsOvernightLlm` 门禁影响，夜盘可能跳过 LLM；本计划不改变夜盘默认门禁，只针对盘后/盘前关键催化窗口注入财报上下文。

### Futu 支持判断

本机只读探针显示：

* `futu-api` 版本：`10.07.6708`

* `OpenQuoteContext` 已包含：

  * `get_financials_statements`

  * `get_financials_earnings_price_move`

  * `get_financials_earnings_price_history`

  * `get_research_analyst_consensus`

  * `get_research_rating_summary`

  * `get_financials_revenue_breakdown`

  * `get_corporate_actions_dividends`

  * `get_shareholders_*`

Futu 官方下载页也显示新版 OpenAPI 已新增 Stock Fundamentals API，覆盖财务报表、分析师评级、估值、分红、股东持仓等能力。结论：Futu 新版 SDK 支持接入这类财报/基本面数据，但当前项目尚未使用。

### Futu 财报订阅能力判断

只读探针显示，当前 `SubType` 只包含 `QUOTE`、`TICKER`、`ORDER_BOOK`、`K_1M/K_30M/K_DAY`、`RT_DATA`、`BROKER` 等实时行情订阅类型；`OpenQuoteContext` 有 `subscribe/unsubscribe/query_subscription/set_handler`，但没有财报、公告、F10 或 earnings 的订阅类型。

Futu 官方 quote overview 也把财报/F10能力列在 Basic Data 的 `get_financials_*` 拉取接口下，而实时订阅模块只包含 quote、order book、K 线、ticker、RT data、broker queue 等行情回调。

结论：第一版不能设计成“订阅财报事件 push”。应设计成：

* 后台 watcher 低频拉取/刷新财报事件状态。
* 财报事件和完整上下文写入内存缓存。
* LLM 请求前只读缓存，不同步请求 Futu 财报接口。
* 缓存超过 24h 后自动失效，不再注入 Prompt。

## Proposed Changes

### 1. 新增共享类型

文件：`shared/types.ts`

新增类型：

```ts
export type EarningsCatalystContext = {
  ok: boolean
  ticker: string
  source: 'futu-financials' | 'longbridge-fallback' | 'unavailable'
  fetchedAt: string
  eventFreshness: 'FRESH_AFTER_HOURS' | 'ACTIVE_24H' | 'STALE' | 'UNKNOWN'
  hasRecentEarnings: boolean
  earningsDate?: string
  fiscalPeriod?: string
  headline?: string
  summary?: string
  keyMetrics: Array<{
    name: string
    actual?: string | number
    estimate?: string | number
    prior?: string | number
    surprisePct?: number
    yoyPct?: number
  }>
  priceReaction?: {
    afterHoursMovePct?: number
    postEarningsMovePct?: number
    latestPrice?: number
    previousClose?: number
    volumeSignal?: string
  }
  analystContext?: {
    ratingSummary?: string
    targetPriceChange?: string
    consensus?: string
  }
  sectorContext?: {
    relatedTickers: string[]
    summary?: string
  }
  warnings: string[]
}
```

设计原则：

* `ok=false` 时也返回结构，LLM 能看到数据缺失原因。

* 不把财报数据混进 `marketData`，避免实时价格与基本面事件语义混乱。

* 只传摘要和关键字段，不把完整财报 DataFrame 全量塞进 Prompt。

### 2. 新增 Futu 财报 bridge

新增文件：`api/futu_bridge/futu_earnings_context.py`

职责：

1. 入参：

   * `ticker`

   * `host`

   * `port`

   * `lookbackDays`，默认 `3`

   * `includeAnalyst`，默认 `true`
2. 使用 `OpenQuoteContext`：

   * `get_financials_earnings_price_move(code, period_count=4)`

   * `get_financials_earnings_price_history(code)`

   * `get_financials_statements(code, num=4)`

   * `get_research_analyst_consensus(code)`

   * `get_research_rating_summary(code, num=10)`
3. 归一化输出为 `EarningsCatalystContext` 可消费的 JSON。
4. 对字段缺失、权限不足、接口异常只写 `warnings`，不抛出导致整轮 LLM 中断。

注意：

* 需要兼容不同市场字段名不稳定的问题，统一通过 `safe_float`、`row_value`、`dataframe_records` 解析。

* `get_financials_statements` 的具体字段在不同市场可能不同，第一版只抽取能稳定解析的营收、EPS/净利润、毛利率、同比增速、发布日期等字段。

* 如果 Futu 返回的财报时间不是最近 `24h`，则 `eventFreshness=STALE`，LLM 不应当把它当成即时盘后催化。

### 3. 新增 TypeScript 服务封装

新增文件：`api/live/liveEarningsCatalystService.ts`

职责：

1. 提供后台 watcher 使用的刷新函数，内部调用 `runPythonBridge('futu_earnings_context.py', payload)`。
2. 提供两层缓存：

   * 轻量事件状态缓存：只记录最近财报日期、是否新鲜、上次检查时间、是否允许注入 Prompt。

   * 完整财报上下文缓存：只有事件门控通过时才加载完整字段。

3. 提供内存 TTL：

   * 普通时段财报状态：`6h`

   * 财报窗口当天：`10m`

   * 盘后/盘前，且检测到大幅跳动或预期今天发布财报：`2m`

   * 完整财报上下文：发布后 `24h` 失效。

   * 获取失败：`5m` negative cache，避免反复打接口。
4. 暴露：

```ts
export async function refreshEarningsCatalystContext(input: {
  ticker: string
  marketData: Extract<StrategyMarketData, { ok: true }>
  relatedTickers?: string[]
}): Promise<EarningsCatalystContext>

export async function refreshEarningsCatalystStatus(input: {
  ticker: string
}): Promise<EarningsCatalystStatus>

export function getCachedEarningsCatalystContext(ticker: string): EarningsCatalystContext | undefined

export function getCachedEarningsCatalystStatus(ticker: string): EarningsCatalystStatus | undefined

export function shouldInjectEarningsCatalyst(input: {
  ticker: string
  marketState?: string
  marketData: Extract<StrategyMarketData, { ok: true }>
  eventStatus?: EarningsCatalystStatus
  position?: Position
  now?: Date
}): EarningsCatalystGateDecision
```

5. 触发策略：

   * LLM 请求前只读 `getCachedEarningsCatalystStatus/getCachedEarningsCatalystContext`，不得同步调用 `refresh*`。

   * 后台 watcher 负责按时段和事件刷新缓存。

### 3.1 后台财报事件 watcher

新增文件：`api/live/liveEarningsCatalystWatcher.ts`

目标：把财报这类季度性、低频但关键的事件从 LLM 请求链路中移出，避免每次请求 LLM 前同步请求 Futu 财报接口。

启动时机：

* 随 `api/app.ts` 启动。
* 只对当前 LLM 票池 `LLM_SIMULATION_UNIVERSE` 和已有持仓中的美股标的工作。
* 不影响 Futu 实时行情订阅；它是独立低频任务。

刷新策略：

1. 启动预热：
   * 对票池标的逐个刷新轻量 `EarningsCatalystStatus`。
   * 并发限制 `2`，避免启动时打爆 OpenD。
2. 普通交易日：
   * 每 `6h` 刷新一次轻量状态。
   * 不刷新完整财报上下文。
3. 美股盘后/夜盘/下一个交易日盘前盘中：
   * 每 `10m` 扫描一次轻量状态。
   * 如果某 ticker 的 `nextEarningsDate` 是今天、`latestEarningsDate` 是今天、或 Futu 状态显示 `minutesSinceEarnings <= 24h`，刷新完整上下文。
4. 盘后异常价格反应：
   * watcher 从 `realtimeStore.snapshot(ticker)` 读取缓存行情。
   * 若盘后/盘前最新价相对参考价达到阈值，且该 ticker 在财报日历窗口内，刷新完整上下文。
5. 失效：
   * 财报发布超过 `24h` 后删除完整上下文缓存。
   * 只保留轻量状态，且 `shouldInjectEarningsCatalyst` 返回 `SKIP`。

LLM 请求链路规则：

* `api/live/liveTradingEngine.ts` 在请求 LLM 前只能读取 watcher 缓存。
* 如果缓存没有事件，直接 `SKIP`。
* 禁止在 `requestLiveTradingDecision` 前同步请求 Futu 财报接口。
* 这样财报接口慢、Futu 权限异常或 Longbridge fallback 慢，都不会拖慢实盘 LLM 主链路。

日志：

* `live.earnings_watcher.started`
* `live.earnings_watcher.status_refreshed`
* `live.earnings_watcher.context_refreshed`
* `live.earnings_watcher.context_expired`
* `live.earnings_watcher.refresh_failed`

### 3.2 财报注入事件门控

新增文件：`api/live/liveEarningsCatalystGate.ts`

目标：控制“什么时候喂给 LLM”，避免每轮、每个 ticker 都带财报上下文。

新增类型：

```ts
export type EarningsCatalystStatus = {
  ticker: string
  checkedAt: string
  source: 'futu-financials' | 'longbridge-fallback' | 'unavailable'
  latestEarningsDate?: string
  minutesSinceEarnings?: number
  nextEarningsDate?: string
  minutesUntilEarnings?: number
  hasRecentEarnings: boolean
  warnings: string[]
}

export type EarningsCatalystGateDecision = {
  inject: boolean
  reason: string
  mode: 'FULL_CONTEXT' | 'STATUS_ONLY' | 'SKIP'
  freshness: 'HOT_0_2H' | 'ACTIVE_2_24H' | 'STALE' | 'UNKNOWN'
}
```

门控规则：

1. 财报刚发布强触发：
   * `minutesSinceEarnings` 在 `0-120` 分钟内：`FULL_CONTEXT`
   * 这是最关键的盘后催化窗口，例如美光盘后刚发财报。
2. 盘后/盘前价格异动触发：
   * `marketState` 属于 `AFTER_HOURS_BEGIN / AFTER_HOURS_END / PRE_MARKET_BEGIN / PRE_MARKET_END`
   * 且最新价相对参考价跳动达到阈值：
     * 默认 `abs(movePct) >= 3%`
     * 半导体高波动票可用 `>= 2%`
   * 且最近 `24h` 有财报：`FULL_CONTEXT`
3. 持仓风险触发：
   * 当前有该标的持仓，且最近 `24h` 有财报：`FULL_CONTEXT`
   * 原因：即使不交易，也要让 LLM 理解持仓风险和是否需要减仓/止盈。
4. 下一个交易日盘中有效期：
   * 财报发布后 `2-24h`：只有盘后、夜盘、下一个交易日盘前/盘中允许 `FULL_CONTEXT` 或 `STATUS_ONLY`。
   * 如果已超过 `24h`，直接 `SKIP`。
5. 过期：
   * 财报发布超过 `24h`：`SKIP`
   * 避免旧财报反复影响 LLM。
6. 财报前预警：
   * `minutesUntilEarnings` 在 `0-360` 分钟内：`STATUS_ONLY`
   * 告诉 LLM “即将财报，谨慎开新仓”，但不传不存在的财报结果。

Prompt 注入策略：

* `FULL_CONTEXT`：注入完整 `eventContext.earningsCatalyst`。
* `STATUS_ONLY`：只注入 `latestEarningsDate`、`nextEarningsDate`、`gateReason` 等轻量字段，不传详细财务指标。
* `SKIP`：完全不传 `eventContext.earningsCatalyst`，只在日志记录 gate reason。

配置常量第一版硬编码在 `liveEarningsCatalystGate.ts`：

```ts
const HOT_EARNINGS_WINDOW_MINUTES = 120
const RECENT_EARNINGS_WINDOW_HOURS = 24
const EXPIRE_EARNINGS_WINDOW_HOURS = 24
const UPCOMING_EARNINGS_WARNING_MINUTES = 360
const AFTER_HOURS_MOVE_TRIGGER_PCT = 3
const SEMICONDUCTOR_MOVE_TRIGGER_PCT = 2
```

后续如果需要 UI 可配置，再放入 `LlmRuntimeConfig`。第一版不扩大配置面。

### 4. Longbridge 兜底适配

文件：

* `api/live/liveEarningsCatalystService.ts`

* 可复用 `api/longbridge/longbridgeCli.ts` 和 `api/longbridge/longbridgeAdapter.ts` 的 CLI 解析模式。

兜底逻辑：

1. 如果 Futu bridge 在门控通过后返回不可用、权限不足、字段为空，尝试 Longbridge：

   * `financial-report SYMBOL.US --latest`

   * `analyst-estimates SYMBOL.US`

   * `news SYMBOL.US`

   * `filing SYMBOL.US`
2. 当前本机 `longbridge` 命令不可用，因此实现时必须：

   * 复用项目已有 `resolveLongbridgeCliPath()`。

   * 不假设 `longbridge` 一定在 PATH。

   * 失败时返回 `source='unavailable'`，把错误写入 `warnings`。

### 5. 注入实盘单标的 LLM Prompt

文件：`api/live/liveTradingDecisionService.ts`

修改：

1. `DecisionInput` 增加：

```ts
earningsCatalyst?: EarningsCatalystContext
earningsCatalystGate?: EarningsCatalystGateDecision
```

1. `buildLiveDecisionPrompt(...)` 中按 gate mode 条件注入。

`FULL_CONTEXT` 时加入：

```ts
eventContext: {
  earningsCatalyst: input.earningsCatalyst,
  interpretationRules: [
    '若 eventFreshness 为 FRESH_AFTER_HOURS 且 priceReaction 显示盘后显著跳涨/跳跌，必须把它视为新信息，不得仅按短周期噪声处理。',
    '财报超预期不等于无脑追价，仍需结合盘口、流动性、费用、仓位和回撤风险。',
    '若财报数据不可用，必须在 reason 中说明催化信息缺失，不得编造财报结论。'
  ]
}
```

`STATUS_ONLY` 时只加入：

```ts
eventContext: {
  earningsCatalystStatus: {
    gateMode: 'STATUS_ONLY',
    gateReason: input.earningsCatalystGate.reason,
    latestEarningsDate,
    nextEarningsDate,
    instruction: '当前不提供完整财报指标；不得编造财报结论。'
  }
}
```

`SKIP` 时不加入 `eventContext`，减少 Prompt 噪声和 token。

1. `requiredJson` 增加可选字段：

```ts
eventAwareness: {
  earningsConsidered: boolean
  catalystDirection: 'BULLISH' | 'BEARISH' | 'MIXED' | 'NONE' | 'UNAVAILABLE'
  catalystSummary: string
}
```

1. `parseLiveTradingDecision(...)` 解析该字段，若模型缺失则填默认值，不阻断。

### 6. 实盘引擎加载事件上下文

文件：`api/live/liveTradingEngine.ts`

修改位置：当前 `loadTrendContext(...)` 之后、`requestLiveTradingDecision(...)` 之前。

流程：

```ts
const earningsCatalystStatus = getCachedEarningsCatalystStatus(ticker)

const earningsCatalystGate = shouldInjectEarningsCatalyst({
  ticker,
  marketState: marketData.marketState,
  marketData,
  eventStatus: earningsCatalystStatus,
  position,
})

const earningsCatalyst =
  earningsCatalystGate.mode === 'FULL_CONTEXT'
    ? getCachedEarningsCatalystContext(ticker)
    : undefined

const decision = await requestLiveTradingDecision({
  ...
  trendContext,
  earningsCatalyst,
  earningsCatalystGate,
})
```

日志：

* `live.earnings_context.gate_evaluated`

* `live.earnings_context.loaded`

* `live.earnings_context.unavailable`

* 字段包括 `ticker`、`mode`、`reason`、`source`、`eventFreshness`、`hasRecentEarnings`、`warnings`。

失败模式：

* 财报上下文获取失败不能跳过 ticker。

* 只降级为 `earningsCatalyst.ok=false`，继续使用实时行情和趋势做 LLM 决策。

* 门控为 `SKIP` 时不调用完整 bridge，不影响本轮 LLM。

### 7. 组合策略候选池同步保存催化摘要

文件：

* `shared/types.ts`

* `api/live/liveCandidatePoolService.ts`

* `api/live/livePortfolioReviewDecisionService.ts`

* `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`

目标：

* 单标的 BUY/SELL\_SHORT 进入候选池时，保留 `earningsCatalyst` 摘要。

* 组合裁决 Prompt 能看到哪些候选是“财报新信息驱动”，避免把盘后暴涨简单当成追高噪声。

字段建议：

```ts
earningsCatalyst?: Pick<EarningsCatalystContext,
  'source' | 'eventFreshness' | 'hasRecentEarnings' | 'headline' | 'summary' | 'priceReaction' | 'warnings'
>
```

组合裁决规则新增：

* 财报新信息可以提升候选优先级，但不得绕过风控。

* 若同板块多个半导体候选同时因同一财报催化上涨，应识别相关性拥挤，不重复过度推进。

* 对财报后跳涨候选，必须说明是否等待回落、缩小仓位、或只观察。

### 8. UI 透明展示

文件：`src/pages/LiveTradingView.tsx`

在历史策略信号、候选池、待确认订单中展示：

* `财报催化` Badge：

  * `新财报`

  * `仅预警`

  * `24h内`

  * `旧财报`

  * `无数据`

* 展开区域展示：

  * 数据源：Futu / Longbridge / unavailable

  * 财报摘要

  * 价格反应

  * 关键 metrics

  * warnings

第一版 UI 只读展示，不新增手动刷新按钮，避免扩大范围。

展示逻辑：

* 只有 `FULL_CONTEXT` 或候选/订单保存过财报摘要时展示完整财报展开区。

* `STATUS_ONLY` 只展示小 Badge 和 gate reason。

* `SKIP` 不展示财报模块。

### 9. Prompt 配置更新

文件：`trade_strategy/prompt_packs/llm_autonomous_stock_trader_v1.yaml`

新增硬约束：

* 盘后/盘前财报新信息必须作为 `eventContext` 单独评估。

* 不允许把财报后跳涨简单归类为“短周期噪声”。

* 数据不可用时不得编造财报结论。

* 财报大超预期仍需检查追高、流动性、费用、已有持仓和组合相关性。

### 10. 测试计划

新增或修改：

* `tests/liveTradingFlows.test.ts`

  * 模拟 `FRESH_AFTER_HOURS` 财报催化进入 LLM input。

  * 验证候选池持久化包含催化摘要。

  * 验证财报上下文失败时不跳过 ticker。

* 新增 `tests/liveEarningsCatalystService.test.ts`

  * Futu bridge 成功归一化。

  * Futu 失败 + Longbridge 失败返回 `ok=false`。

  * TTL cache 生效。

* 新增 `tests/liveEarningsCatalystGate.test.ts`

  * 财报后 `0-120` 分钟返回 `FULL_CONTEXT`。

  * 盘后/盘前异动且 `24h` 内财报返回 `FULL_CONTEXT`。

  * 财报前 `6` 小时内返回 `STATUS_ONLY`。

  * 财报超过 `24h` 返回 `SKIP`。

  * RTH 且无持仓、无异动、旧财报不注入完整上下文。

* `tests/tradeStrategyConfig.test.ts`

  * 验证 Prompt 包含“财报新信息不得简单视为噪声”的规则。

验证命令：

```bash
npm run check
npm run test -- tests/liveEarningsCatalystGate.test.ts tests/liveEarningsCatalystService.test.ts tests/liveTradingFlows.test.ts tests/tradeStrategyConfig.test.ts
```

如需验证真实 Futu：

```bash
python3 api/futu_bridge/futu_earnings_context.py
```

通过 stdin 输入：

```json
{"ticker":"MU","host":"127.0.0.1","port":11111,"lookbackDays":3,"includeAnalyst":true}
```

## Assumptions & Decisions

1. 数据源策略已确认：Futu 优先 + Longbridge 兜底。
2. 第一版只接入实盘 LLM 链路，不改模拟盘。
3. 财报上下文获取失败不能阻断实盘 LLM，只能降级并告警。
4. 第一版不做全量新闻抓取系统，只聚焦财报/财务/评级/价格反应。
5. 第一版不自动交易，仍保持“候选池/待确认订单/人工确认”的现有语义。
6. 美光 `MU` 只是本次问题触发案例，功能应适用于票池内所有美股标的。
7. Futu OpenAPI 字段和权限可能随账号/市场变化，bridge 必须容错。
8. 财报上下文不常驻注入 LLM。只有事件门控返回 `FULL_CONTEXT` 时才传完整财报数据；`STATUS_ONLY` 只传轻量提醒；`SKIP` 完全不传。
9. 第一版门控阈值先用代码常量，不做 UI 配置，减少误操作面。

## Verification Steps

1. 静态检查：

```bash
npm run check
```

1. 单元测试：

```bash
npm run test -- tests/liveEarningsCatalystGate.test.ts tests/liveEarningsCatalystService.test.ts tests/liveTradingFlows.test.ts tests/tradeStrategyConfig.test.ts
```

1. Futu bridge 冒烟：

```bash
printf '%s\n' '{"ticker":"MU","host":"127.0.0.1","port":11111,"lookbackDays":3,"includeAnalyst":true}' | python3 api/futu_bridge/futu_earnings_context.py
```

1. 实盘 dry-run 验证：

* 开启 Futu 订阅。

* 在美股盘后对 `MU` 跑一轮实盘 LLM。

* 日志应先出现 `live.earnings_context.gate_evaluated`。

* 只有 gate 为 `FULL_CONTEXT` 时，LLM Prompt 中才应出现完整 `eventContext.earningsCatalyst`。

* gate 为 `STATUS_ONLY` 时，LLM Prompt 只出现轻量 `earningsCatalystStatus`，不能出现完整财报 metrics。

* gate 为 `SKIP` 时，LLM Prompt 不出现财报上下文。

* 若 Futu 返回财报上下文，LLM 的 `reason` / `eventAwareness` 必须提及财报催化。

* 若 Futu 不可用，LLM 的 `reason` 必须说明财报上下文缺失，不能编造。

1. UI 验证：

* 候选池中 `MU` 或相关半导体候选展示 `财报催化` Badge。

* 展开详情能看到 source、summary、priceReaction、warnings。
