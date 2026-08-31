# 宏观新闻快照接入 LLM Prompt 与上下文结构说明

## 目标

本文档说明 Longbridge 新闻快照接入后，Futu 模拟盘、Futu 实盘、Longbridge 实盘以及候选池组合裁决的完整 Prompt 结构、上下文输入结构和优先级规则。

核心结论：

* 新增的是 `macroNewsContext`，作为额外风险上下文输入。

* 原有 `system` prompt、`hardConstraints`、账户、持仓、行情、趋势、费用、风险模型和 `requiredJson` 不被替换。

* 新闻规则只允许提高风险约束，不允许覆盖交易动作语义、账户/持仓/行情事实、后端硬风控或人工确认链路。

* 新闻搜索每轮只调用一次 Longbridge CLI，同一轮所有 ticker 共用同一份快照。

## 现有 Prompt 构造入口

当前项目中相关 LLM 入口如下：

| 场景                | Prompt 构造函数                         | 配置来源                                                                            |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Futu 模拟盘单票决策      | `buildDecisionPrompt`               | `trade_strategy/prompt_packs/*.yaml`                                            |
| Futu 实盘单票决策       | `buildLiveDecisionPrompt`           | `trade_strategy/prompt_packs/*.yaml`                                            |
| Longbridge 实盘单票决策 | `buildLongbridgeLiveDecisionPrompt` | `trade_strategy/prompt_packs/*.yaml` + Longbridge 平台化替换                         |
| 候选池组合裁决           | `buildPortfolioReviewPrompt`        | `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml` |

这些入口都使用相同消息形态：

```ts
[
  { role: 'system', content: string },
  { role: 'user', content: JSON.stringify(contextPayload) },
]
```

新闻快照接入后仍保持该形态，只是在 `contextPayload` 中新增 `macroNewsContext`。

## 新增共享类型

建议新增共享类型：

```ts
export type MacroNewsRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' | 'UNAVAILABLE'

export type MacroNewsArticle = {
  id: string
  title: string
  sourceName: string
  publishedAt: string
  excerpt: string
  url?: string
  matchedKeywords: string[]
}

export type MacroNewsSnapshot = {
  ok: boolean
  source: 'longbridge'
  generatedAt: string
  expiresAt: string
  querySetVersion: string
  riskLevel: MacroNewsRiskLevel
  summary: string
  marketRiskHints: {
    affectedAssets: string[]
    affectedSectors: string[]
    watchIndicators: string[]
    suggestedPolicy: 'NORMAL' | 'REDUCE_NEW_ORDERS' | 'BLOCK_LEVERAGED_ETF' | 'PAUSE_NEW_ENTRIES'
  }
  articles: MacroNewsArticle[]
  warnings: string[]
}
```

## `macroNewsContext` 标准结构

三类单票决策入口和组合裁决入口都应使用同一份基础结构：

```ts
type MacroNewsPromptContext = {
  source: 'Longbridge CLI shared snapshot'
  priority: 'below_hard_constraints_and_market_facts'
  snapshot: MacroNewsSnapshot
  rules: string[]
}
```

基础 `rules` 必须一致：

```json
[
  "该新闻快照是本轮所有 ticker 共享上下文，不是针对单个 ticker 的新闻搜索。",
  "不得在每个 ticker 决策中重新搜索新闻。",
  "macroNewsContext 的优先级低于 hardConstraints、平台订单语义、账户/持仓/行情事实和后端硬风控。",
  "新闻快照只能提高风险约束，不得覆盖原有交易定义，不得伪造缺失数据。",
  "不得仅凭新闻标题开仓；必须结合 marketData、trendContext、orderBook、账户风险和平台交易约束。",
  "新闻快照只用于识别宏观/地缘政治风险，不是单票利好或利空结论。",
  "HIGH 或 EXTREME 时，优先降低杠杆 ETF、高 beta 标的和盘前盘后低流动性新开仓，允许合理平仓/降风险。",
  "UNAVAILABLE 时不得编造新闻，不得假设没有风险事件，也不得因为新闻不可用而放松风控。"
]
```

## Prompt 优先级

LLM 决策时必须按以下优先级理解上下文：

1. `hardConstraints`、平台订单语义、真实/模拟订单门禁。
2. 账户、持仓、购买力、交易币种、费用、行情、K 线、摆盘、趋势等事实数据。
3. 后端硬风控、候选池规则、人工确认规则。
4. `macroNewsContext` 新闻风险上下文。
5. 模型自己的推理和表达。

因此，新闻快照可以让模型更保守，但不能让模型违反原有动作定义。例如：

* 不能把 `SELL_TO_CLOSE` 用于回补空头。

* 不能把期权持仓误判成可交易期权。

* 不能因为新闻不可用就假设市场没有风险。

* 不能用新闻标题替代行情、趋势、摆盘和账户约束。

## Futu 模拟盘完整 Prompt 结构

### System Prompt

来源：`getActivePromptPack('simulation').systemPrompts.simulation`。

默认配置来自 `trade_strategy/prompt_packs/llm_autonomous_stock_trader_v1.yaml`：

```text
你是 Futu SIMULATE 模拟盘美股/港股正股/ETF自主交易模型。你必须直接决定 HOLD、BUY、SELL_SHORT 或 SELL_TO_CLOSE。只能返回 JSON，不要 Markdown。允许在 SIMULATE 模拟盘中买卖用户票池内的正股和ETF，允许卖空正股/ETF，但不得建议期权或真实盘交易。杠杆 ETF/杠杆产品只适合短周期主动管理，必须考虑每日重置、波动拖累、滑点和流动性风险；港股杠杆产品按 HKD 交易和港股交易时段理解。必须考虑交易费用、滑点、摆盘、K 线、分时、账户权益、购买力和完整账户持仓。必须把交易费用作为净收益判断的一部分；如果持仓毛浮盈小于预计平仓费用或回合费用，不能把该持仓视为真实盈利。注意：positionQuantity 表示持仓数量，可正可负；orderQuantity 表示本次下单数量，必须是正整数或 HOLD 时为 0。BUY 可用于回补空头或开多，SELL_TO_CLOSE 仅用于平掉已有多头。严禁把空头回补描述为需要购买力支持；空头回补依据现有空头股数、行情、费用和风险，不依据开仓购买力。
```

### User Context Payload

目标结构：

```jsonc
{
  "task": "为单个标的生成本轮模拟盘交易决策",
  "hardConstraints": [
    "...common constraints",
    "...simulation constraints"
  ],
  "universe": ["用户票池内的正股/ETF配置"],
  "targetTicker": "AAPL",
  "targetInstrument": {
    "ticker": "AAPL",
    "name": "Apple",
    "market": "US",
    "tradingCurrency": "USD"
  },
  "account": {
    "accountId": "Futu simulate account id",
    "totalAssets": "...",
    "cash": "...",
    "buyingPower": "...",
    "dailyPnL": "...",
    "totalPnL": "...",
    "positions": [
      {
        "ticker": "AAPL",
        "contractTicker": "AAPL",
        "underlyingTicker": "AAPL",
        "name": "...",
        "assetType": "STOCK | ETF | OPTION",
        "optionType": "CALL | PUT | undefined",
        "strike": 0,
        "expirationDate": "YYYY-MM-DD",
        "contractSummary": "...",
        "positionQuantity": "10",
        "numericPositionQuantity": 10,
        "positionSide": "LONG | SHORT | FLAT",
        "exposureSide": "LONG | SHORT | FLAT",
        "optionPositionType": "...",
        "underlyingDirectionalExposure": "...",
        "interpretation": "...",
        "marketValue": "...",
        "currentPrice": "...",
        "todayPnL": "...",
        "unrealizedPnL": "...",
        "estimatedFeeContext": "...",
        "currency": "USD"
      }
    ]
  },
  "portfolioContext": {
    "allPositions": ["同 account.positions 摘要"],
    "targetExposure": {
      "ticker": "AAPL",
      "hasPosition": true,
      "assetType": "STOCK",
      "numericPositionQuantity": 10,
      "exposureSide": "LONG",
      "instruction": "Do not assume no position if allPositions contains this ticker..."
    },
    "shortCoverContext": {
      "applies": false,
      "maxCoverQuantity": 0,
      "buyingPowerRule": "Only applies to opening BUY or SELL_SHORT, not to short-cover BUY."
    },
    "derivativePositionRule": "OPTION 持仓只作为账户风险上下文...",
    "positionQuantityConvention": "positionQuantity > 0 means long shares...",
    "orderQuantityConvention": "orderQuantity is the positive integer share count...",
    "feeContextRules": {
      "source": "费用为后端估算值，Futu SIMULATE 不支持真实 order_fee_query。",
      "netPnLRule": "判断是否平仓/回补时必须优先看 estimatedFeeContext.estimatedNetUnrealizedPnL。",
      "grossProfitButNetLossRule": "若 estimatedFeeContext.grossProfitButNetLoss 为 true..."
    },
    "actionSemantics": {
      "BUY": "买入；如果 targetExposure.exposureSide 为 SHORT，BUY 表示买入平仓/回补空头...",
      "SELL_SHORT": "卖空开仓或增加空头，仅限 SIMULATE 票池内正股/ETF。",
      "SELL_TO_CLOSE": "平掉已有多头，不用于回补空头。",
      "HOLD": "不交易。"
    },
    "forbiddenShortCoverLanguage": [
      "不要说购买力允许回补",
      "不要说购买力足以覆盖回补",
      "不要说购买力不足所以不能回补",
      "不要把回补数量解释为由 buyingPower 决定"
    ]
  },
  "currentPosition": {
    "ticker": "AAPL",
    "assetType": "STOCK",
    "positionQuantity": "10",
    "numericPositionQuantity": 10,
    "exposureSide": "LONG",
    "marketValue": "...",
    "currentPrice": "...",
    "todayPnL": "...",
    "unrealizedPnL": "...",
    "estimatedFeeContext": "..."
  },
  "feeModel": "模拟盘费用模型说明",
  "riskModel": "当前策略风险模型说明",
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "priority": "below_hard_constraints_and_market_facts",
    "snapshot": {
      "ok": true,
      "source": "longbridge",
      "generatedAt": "ISO time",
      "expiresAt": "ISO time",
      "querySetVersion": "macro_geo_v1",
      "riskLevel": "LOW | MEDIUM | HIGH | EXTREME | UNAVAILABLE",
      "summary": "本轮宏观/地缘政治新闻风险摘要",
      "marketRiskHints": {
        "affectedAssets": ["QQQ", "TQQQ", "NVDA", "USO", "GLD", "VIX"],
        "affectedSectors": ["Semiconductor", "Energy", "Defense"],
        "watchIndicators": ["VIX", "QQQ", "SPY", "USO", "GLD"],
        "suggestedPolicy": "NORMAL | REDUCE_NEW_ORDERS | BLOCK_LEVERAGED_ETF | PAUSE_NEW_ENTRIES"
      },
      "articles": [
        {
          "id": "longbridge-news-id",
          "title": "新闻标题",
          "sourceName": "Longbridge",
          "publishedAt": "ISO time",
          "excerpt": "短摘要",
          "url": "optional",
          "matchedKeywords": ["Iran", "Israel", "market"]
        }
      ],
      "warnings": []
    },
    "rules": ["共享基础规则", "Futu 模拟盘订单仍必须遵守模拟盘后端风控、费用模型和订单语义。"]
  },
  "marketData": {
    "ticker": "AAPL",
    "marketState": "REGULAR | PRE | AFTER | CLOSED | UNKNOWN",
    "lastPrice": 0,
    "bestAsk": 0,
    "bestBid": 0,
    "executionWindow": {
      "recentKlineBars": ["最近 N 根 1m K 线"],
      "recentTickerPoints": ["最近 N 个分时点"],
      "asks": ["前 N 档卖盘"],
      "bids": ["前 N 档买盘"],
      "updatedAt": "ISO time"
    },
    "trendContext": "多时间窗口趋势摘要",
    "updatedAt": "ISO time"
  },
  "requiredJson": {
    "approved": true,
    "action": "HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE",
    "ticker": "AAPL",
    "orderQuantity": 0,
    "limitPrice": 0,
    "confidence": "low | medium | high",
    "reason": "中文交易理由；若 BUY 回补或 SELL_TO_CLOSE 平仓，必须说明预估费用是否被净收益覆盖，或说明为何即使扣费后亏损也需要止损/降风险。",
    "riskAssessment": "中文风险说明；必须考虑 estimatedNetUnrealizedPnL 与 grossProfitButNetLoss。",
    "trendAlignment": "WITH_TREND | AGAINST_TREND | REVERSAL_ATTEMPT | NO_TREND | UNAVAILABLE",
    "tradeHorizon": "SCALP | INTRADAY | SWING_1_TO_7_DAYS",
    "whyNotNoise": "中文说明：为什么这不是仅由短周期噪声触发。",
    "dataWindowUsed": {
      "kline1mBars": 0,
      "tickerPoints": 0,
      "orderBookDepth": 0
    }
  }
}
```

## Futu 实盘完整 Prompt 结构

### System Prompt

来源：`getActivePromptPack('live').systemPrompts.live`。

默认配置来自 `trade_strategy/prompt_packs/llm_autonomous_stock_trader_v1.yaml`，也可能被 UI 切换到 `llm_autonomous_stock_trader_live_safe_v1.yaml`：

```text
你是 Futu REAL 实盘美股/港股正股/ETF半自动交易研究员。你只生成策略信号和候选订单意图，真实订单必须进入待确认队列并由用户二次确认后才可能提交。你必须直接决定 HOLD、BUY、SELL_SHORT 或 SELL_TO_CLOSE。只能返回 JSON，不要 Markdown。允许在用户票池内评估正股和ETF，但不得建议期权。杠杆 ETF/杠杆产品只适合短周期主动管理，必须考虑每日重置、波动拖累、滑点和流动性风险；港股杠杆产品按 HKD 交易和港股交易时段理解。必须考虑真实账户权益、真实持仓、购买力、费用、滑点、摆盘、K 线、分时和完整账户持仓。必须把交易费用作为净收益判断的一部分；如果持仓毛浮盈小于预计平仓费用或回合费用，不能把该持仓视为真实盈利。注意：positionQuantity 表示持仓数量，可正可负；orderQuantity 表示本次下单数量，必须是正整数或 HOLD 时为 0。BUY 可用于回补空头或开多，SELL_TO_CLOSE 仅用于平掉已有多头。严禁把空头回补描述为需要购买力支持；空头回补依据现有空头股数、行情、费用和风险，不依据开仓购买力。
```

### User Context Payload

Futu 实盘在模拟盘基础上有这些差异：

* `account` 使用真实账户字段，并区分展示币种和交易币种。

* `feeModel` 不作为顶层字段传入，费用规则写在 `portfolioContext.feeContextRules`。

* `marketData` 直接包含 `recentKlineBars`、`recentTickerPoints`、`asks`、`bids`，没有 `executionWindow` 包装。

* 非 HOLD 只代表进入候选/待确认链路，不代表自动提交真实订单。

* 新闻上下文字段名统一使用 `macroNewsContext`。如果讨论中写作 `macro_news context`，在实现和 Prompt JSON 中仍对应这个 camelCase 字段。

### Futu 实盘新闻上下文显式插入点

Futu 实盘必须在单票决策 user JSON 的顶层注入 `macroNewsContext`，位置建议放在 `riskModel` 后、`marketData` 前：

```jsonc
{
  "currentPosition": "...",
  "riskModel": "当前策略风险模型说明",
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "priority": "below_hard_constraints_and_market_facts",
    "snapshot": "MacroNewsSnapshot",
    "liveTradingRule": "新闻只作为风险上下文；真实订单仍必须经过后端硬风控和人工确认。",
    "rules": [
      "共享基础规则",
      "Futu 实盘真实订单仍必须经过后端硬风控、待确认队列和人工二次确认。",
      "新闻快照不得替代 Futu 实盘账户、持仓、行情、订单、费用和交易时段数据源。"
    ]
  },
  "marketData": "..."
}
```

该字段不是放在 `portfolioContext`、`marketData` 或 `riskModel` 内部，而是和它们同级的顶层上下文字段。

目标结构：

```jsonc
{
  "task": "为单个标的生成本轮 Futu REAL 实盘候选交易决策",
  "hardConstraints": [
    "...common constraints",
    "...live constraints"
  ],
  "universe": ["用户票池内的正股/ETF配置"],
  "targetTicker": "AAPL",
  "targetInstrument": {
    "ticker": "AAPL",
    "name": "Apple",
    "market": "US",
    "tradingCurrency": "USD"
  },
  "account": {
    "accountId": "Futu real account id",
    "displayCurrency": "HKD | USD",
    "tradingCurrency": "USD",
    "displayTotalAssets": "...",
    "displayCash": "...",
    "displayBuyingPower": "...",
    "totalAssets": "...trading currency value",
    "cash": "...trading currency value",
    "availableFunds": "...trading currency value",
    "buyingPower": "...trading currency value",
    "tradingCurrencyContext": {
      "rule": "交易币种必须跟随 targetInstrument.tradingCurrency...",
      "totalAssetsUsd": "...",
      "cashUsd": "...",
      "availableFundsUsd": "...",
      "buyingPowerUsd": "..."
    },
    "positions": ["完整账户持仓摘要"]
  },
  "portfolioContext": {
    "targetExposure": "...",
    "derivativePositionRule": "OPTION 持仓只作为账户风险上下文...",
    "concentrationRule": "单票集中度不是固定硬上限...",
    "positionQuantityConvention": "...",
    "orderQuantityConvention": "...",
    "feeContextRules": {
      "source": "提交前费用为后端估算值；真实费用只能在 REAL 订单产生 orderId 后通过 order_fee_query 回填。",
      "model": "当前费用模型描述",
      "netPnLRule": "判断是否平仓/回补时必须优先看 estimatedFeeContext.estimatedNetUnrealizedPnL。"
    },
    "actionSemantics": {
      "BUY": "买入；如果 targetExposure.exposureSide 为 SHORT，BUY 表示买入平仓/回补空头...",
      "SELL_SHORT": "实盘卖空开仓或增加空头...",
      "SELL_TO_CLOSE": "平掉已有多头，不用于回补空头。",
      "HOLD": "不交易。"
    }
  },
  "currentPosition": "目标正股/ETF当前直接持仓或 null",
  "riskModel": "当前策略风险模型说明",
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "priority": "below_hard_constraints_and_market_facts",
    "snapshot": "MacroNewsSnapshot",
    "liveTradingRule": "新闻只作为风险上下文；真实订单仍必须经过后端硬风控和人工确认。",
    "rules": [
      "共享基础规则",
      "Futu 实盘真实订单仍必须经过后端硬风控、待确认队列和人工二次确认。",
      "新闻快照不得替代 Futu 实盘账户、持仓、行情、订单、费用和交易时段数据源。"
    ]
  },
  "marketData": {
    "ticker": "AAPL",
    "marketState": "REGULAR | PRE | AFTER | CLOSED | UNKNOWN",
    "lastPrice": 0,
    "bestAsk": 0,
    "bestBid": 0,
    "recentKlineBars": ["最近 N 根 1m K 线"],
    "recentTickerPoints": ["最近 N 个分时点"],
    "asks": ["前 N 档卖盘"],
    "bids": ["前 N 档买盘"],
    "trendContext": "多时间窗口趋势摘要",
    "updatedAt": "ISO time"
  },
  "requiredJson": {
    "approved": true,
    "action": "HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE",
    "ticker": "AAPL",
    "orderQuantity": 0,
    "limitPrice": 0,
    "confidence": "low | medium | high",
    "reason": "中文交易理由；必须说明该建议仅进入待确认队列，不会自动提交。",
    "riskAssessment": "中文风险说明；若 SELL_SHORT，必须包含卖空/保证金/回补风险。",
    "trendAlignment": "WITH_TREND | AGAINST_TREND | REVERSAL_ATTEMPT | NO_TREND | UNAVAILABLE",
    "tradeHorizon": "SCALP | INTRADAY | SWING_1_TO_7_DAYS",
    "whyNotNoise": "中文说明：为什么这不是仅由短周期噪声触发。",
    "dataWindowUsed": {
      "kline1mBars": 0,
      "tickerPoints": 0,
      "orderBookDepth": 0
    }
  }
}
```

## Longbridge 实盘完整 Prompt 结构

### System Prompt

Longbridge 实盘复用 `getActivePromptPack('live')`，再通过 `platformize` 把 Futu 文案替换为 Longbridge 文案。

目标语义：

```text
你是长桥证券 REAL 实盘美股/港股正股/ETF半自动交易研究员。你只生成策略信号和候选订单意图，真实订单必须进入待确认队列并由用户二次确认后才可能提交。你必须直接决定 HOLD、BUY、SELL_SHORT 或 SELL_TO_CLOSE。只能返回 JSON，不要 Markdown。允许在用户票池内评估正股和ETF，但不得建议期权。必须考虑长桥真实账户权益、真实持仓、购买力、费用、滑点、摆盘、K 线、分时和完整账户持仓。
```

### User Context Payload

Longbridge 实盘结构与 Futu 实盘同构，但数据源是 Longbridge：

```jsonc
{
  "task": "为单个标的生成本轮 Longbridge REAL 实盘候选交易决策",
  "platformRuntime": {
    "platform": "Longbridge",
    "mode": "REAL_DRY_RUN",
    "dataSource": "Longbridge SDK cache / Skill / CLI / MCP",
    "orderPolicy": "本轮只允许生成信号、候选和待确认订单；禁止直接提交真实订单。"
  },
  "hardConstraints": [
    "...common constraints",
    "...live constraints after platformize"
  ],
  "universe": ["用户票池内的正股/ETF配置"],
  "targetTicker": "AAPL",
  "targetSymbol": "AAPL.US",
  "targetInstrument": "票池内对应标的配置",
  "account": {
    "accountId": "Longbridge account id",
    "displayCurrency": "USD",
    "tradingCurrency": "USD",
    "displayTotalAssets": "...",
    "displayCash": "...",
    "displayBuyingPower": "...",
    "totalAssets": "...",
    "cash": "...",
    "availableFunds": "...",
    "buyingPower": "...",
    "availableFundsNumeric": 0,
    "buyingPowerNumeric": 0,
    "maxOpeningNotional": 0,
    "orderSizingConstraint": "开仓 BUY / SELL_SHORT 的 orderQuantity * limitPrice 不得超过最大购买力...",
    "tradingCurrencyContext": {
      "rule": "交易币种必须跟随 targetInstrument.tradingCurrency...",
      "totalAssetsUsd": "...",
      "cashUsd": "...",
      "availableFundsUsd": "...",
      "buyingPowerUsd": "..."
    },
    "positions": ["Longbridge 持仓摘要"],
    "source": "longbridge-cli"
  },
  "portfolioContext": {
    "targetExposure": "...",
    "derivativePositionRule": "OPTION 持仓只作为账户风险上下文...",
    "concentrationRule": "单票集中度不是固定硬上限...",
    "positionQuantityConvention": "...",
    "orderQuantityConvention": "...",
    "actionSemantics": {
      "BUY": "买入；如果 targetExposure.exposureSide 为 SHORT，BUY 表示买入平仓/回补空头...",
      "SELL_SHORT": "长桥实盘 dry-run 卖空开仓或增加空头...",
      "SELL_TO_CLOSE": "平掉已有多头，不用于回补空头。",
      "HOLD": "不交易。"
    }
  },
  "currentPosition": "目标正股/ETF当前直接持仓或 null",
  "riskModel": "当前 live 策略风险模型说明",
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "priority": "below_hard_constraints_and_market_facts",
    "snapshot": "MacroNewsSnapshot",
    "longbridgeLiveRule": "新闻只作为 Longbridge 实盘风险上下文；不得替代 Longbridge 行情、账户、持仓、订单或后端硬风控。",
    "rules": [
      "共享基础规则",
      "Longbridge 实盘真实订单仍必须经过 Longbridge 后端风控、待确认队列和真实提交门禁。",
      "新闻快照不得替代 Longbridge 实盘账户、持仓、行情、订单、费用和交易时段数据源。"
    ]
  },
  "marketData": {
    "source": "longbridge",
    "symbol": "AAPL.US",
    "ticker": "AAPL",
    "marketState": "REGULAR | PRE | AFTER | CLOSED | UNKNOWN",
    "lastPrice": 0,
    "bestAsk": 0,
    "bestBid": 0,
    "recentKlineBars": ["最近 N 根 K 线"],
    "recentTickerPoints": ["最近 N 个分时点"],
    "asks": ["前 N 档卖盘"],
    "bids": ["前 N 档买盘"],
    "trendContext": "多时间窗口趋势摘要",
    "updatedAt": "ISO time",
    "warnings": []
  },
  "requiredJson": {
    "approved": true,
    "action": "HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE",
    "ticker": "AAPL",
    "orderQuantity": 0,
    "limitPrice": 0,
    "confidence": "low | medium | high",
    "reason": "中文交易理由；必须说明该建议仅进入长桥待确认队列，不会自动提交。",
    "riskAssessment": "中文风险说明；若 SELL_SHORT，必须包含卖空/保证金/回补风险。",
    "trendAlignment": "WITH_TREND | AGAINST_TREND | REVERSAL_ATTEMPT | NO_TREND | UNAVAILABLE",
    "tradeHorizon": "SCALP | INTRADAY | SWING_1_TO_7_DAYS",
    "whyNotNoise": "中文说明：为什么这不是仅由短周期噪声触发。",
    "dataWindowUsed": {
      "kline1mBars": 0,
      "tickerPoints": 0,
      "orderBookDepth": 0
    }
  }
}
```

## 候选池组合裁决完整 Prompt 结构

### System Prompt

来源：`trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`。

当前 Futu 文案：

```text
你是 Futu REAL 实盘组合裁决员。你只从候选池中选择是否推进候选到人工确认订单队列。你的任务不是重新分析单个标的是否可以买，而是在多个跨时间候选之间比较优先级、相关性、价格偏离和组合风险。只能返回 JSON，不要 Markdown。所有 promotedCandidates 只代表进入后端硬风控和人工确认，不代表自动下单。
```

Longbridge 如果复用同一组合裁决服务，需要在调用侧或 prompt 构造侧做平台化说明，避免文案仍写 Futu。

### User Context Payload

目标结构：

```jsonc
{
  "task": "从实盘交易候选池中决定哪些候选应推进到人工确认订单队列。",
  "portfolioDecisionId": "portfolio-review-<timestamp>",
  "promptVersion": "live_portfolio_candidate_review_v1",
  "reviewPreset": {
    "id": "deepseek_balanced_v1",
    "label": "DeepSeek 平衡版 v1",
    "version": 1,
    "description": "...",
    "singleSignalScanIntervalMinutes": 2,
    "portfolioReviewIntervalMinutes": 5,
    "candidateTtlMinutes": 15,
    "leveragedEtfCooldownMinutes": 8,
    "minSignalConfirmations": 2,
    "maxPromotedOrdersPerReview": 1,
    "maxActiveCandidates": 12
  },
  "candidatePool": [
    {
      "candidateId": "candidate-AAPL-BUY-...",
      "ticker": "AAPL",
      "action": "BUY | SELL_SHORT | SELL_TO_CLOSE",
      "groupKey": "AAPL_DIRECT",
      "riskTags": [],
      "firstSeenAt": "ISO time",
      "lastSeenAt": "ISO time",
      "signalCount": 2,
      "firstSignalPrice": 0,
      "latestSignalPrice": 0,
      "latestMarketPrice": 0,
      "priceDriftPct": 0,
      "proposedQuantity": 0,
      "proposedNotional": 0,
      "confidence": "low | medium | high",
      "recentReasons": ["最近单票 LLM 理由"]
    }
  ],
  "portfolioState": {
    "account": {
      "accountId": "account id",
      "totalAssets": "...",
      "buyingPower": "...",
      "tradingCurrency": "USD"
    },
    "positions": [
      {
        "ticker": "AAPL",
        "assetType": "STOCK | ETF | OPTION",
        "quantity": "10",
        "marketValue": "...",
        "unrealizedPnL": "..."
      }
    ],
    "pendingOrders": [
      {
        "id": "pending-order-id",
        "ticker": "AAPL",
        "side": "BUY",
        "createdAt": "ISO time"
      }
    ]
  },
  "macroNewsContext": {
    "source": "Longbridge CLI shared snapshot",
    "priority": "below_hard_constraints_and_market_facts",
    "snapshot": "MacroNewsSnapshot",
    "rules": [
      "共享基础规则",
      "新闻快照是全局风险，不是单票利好/利空。",
      "不得只因新闻存在就压制所有候选。",
      "如果压制候选，必须说明风险如何影响该候选的价格、流动性、波动或组合暴露。"
    ]
  },
  "constraints": {
    "maxPromotedOrdersPerReview": 1,
    "minSignalConfirmations": 2,
    "leveragedEtfCooldownMinutes": 8,
    "sameGroupMutualExclusion": false,
    "humanConfirmationRequired": true
  },
  "decisionRules": [
    "不要把每个 BUY 都推进到订单队列；候选之间必须比较优先级。",
    "同组候选、同标的同方向候选、已有 pendingOrders 只能作为组合风险说明，不能作为硬性不推进理由。",
    "禁止仅因为 pendingOrders 中已有同标的同方向订单就把候选放入 suppressedCandidates。",
    "如果要 suppress 已有 pendingOrders 对应的同标的候选，必须同时给出独立于 pendingOrders 的真实弱化理由。",
    "如果新候选在数量、价格、信号质量、组合权重或风险收益上明显优于已有待确认订单，应放入 promotedCandidates。",
    "所有 promotedCandidates 只是进入后端硬风控和人工确认，不代表自动下单。"
  ],
  "requiredJson": {
    "ok": true,
    "promptVersion": "live_portfolio_candidate_review_v1",
    "promotedCandidates": [
      {
        "candidateId": "string",
        "rank": 1,
        "ticker": "string",
        "action": "BUY | SELL_SHORT | SELL_TO_CLOSE",
        "orderQuantity": 0,
        "limitPrice": 0,
        "reason": "中文原因",
        "riskAssessment": "中文风险说明",
        "whyPromoteNow": "为什么现在推进",
        "whyNotOthers": "为什么其他候选暂不推进"
      }
    ],
    "watchedCandidates": [],
    "suppressedCandidates": [],
    "expiredCandidates": [],
    "portfolioRationale": "中文组合裁决总结"
  }
}
```

## 新闻快照对原 Prompt 的影响

### 会变化的部分

* `DecisionInput` 或 `ReviewInput` 新增 `macroNewsSnapshot?: MacroNewsSnapshot`。

* `user` JSON 新增顶层 `macroNewsContext`。

* LLM 的 `reason` 和 `riskAssessment` 可能更多提到宏观风险。

* 在 `HIGH` / `EXTREME` 下，模型更可能对高 beta、杠杆 ETF、盘前盘后低流动性开仓给出 HOLD 或降风险建议。

### 不应变化的部分

* `system` prompt 不需要为新闻单独重写。

* `task`、`hardConstraints`、`universe`、`account`、`portfolioContext`、`currentPosition`、`marketData`、`requiredJson` 保持原结构。

* BUY、SELL\_SHORT、SELL\_TO\_CLOSE、HOLD 的动作语义不变。

* Futu 账户、订单、行情、持仓仍来自 Futu。

* Longbridge 账户、订单、行情、持仓仍来自 Longbridge。

* 新闻失败不阻断交易评估，只传入 `riskLevel: 'UNAVAILABLE'`。

## 实现注意事项

1. `macroNewsContext` 建议放在 `riskModel` 后、`marketData` 前，便于模型理解它是风险上下文，不是行情事实。
2. 单票 prompt 只喂摘要和少量新闻，不喂完整新闻正文，避免 prompt 过长。
3. `articles` 建议最多 5-8 条，字段只保留标题、来源、时间、摘要、关键词。
4. 日志只记录快照 ID、`generatedAt`、`riskLevel`、文章数量和是否缓存命中，不重复打印完整新闻。
5. 组合裁决也必须使用同一份快照，避免单票 LLM 看到了宏观风险而组合层忽略。
6. 如果 Longbridge 组合裁决复用 Futu 的 `livePortfolioReviewDecisionService`，需要补平台字段或平台化 system prompt，避免 Longbridge 页面里出现 Futu 文案。

## 验收要点

* Futu 模拟盘一轮评估内，所有 ticker 的 `macroNewsContext.snapshot.generatedAt` 相同。

* Futu 实盘一轮评估内，所有 ticker 的 `macroNewsContext.snapshot.generatedAt` 相同。

* Longbridge 实盘一轮评估内，所有 ticker 的 `macroNewsContext.snapshot.generatedAt` 相同。

* 同一轮内 Longbridge CLI 新闻搜索最多调用一次。

* `macroNewsContext.rules` 不删除、不覆盖原有 `hardConstraints`。

* `UNAVAILABLE` 时 prompt 明确禁止编造新闻，也不能因为新闻不可用而放松风控。

* 单票决策和组合裁决都能看到同一份新闻风险等级和策略建议。

