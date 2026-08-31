import type { LiveAccountDashboardResponse, LlmDataWindowRecommendation, LlmTradingDecision, Position, SimulationUniverseItem, TrendContextSummary } from '../../shared/types.js'
import { durationMs, logger } from '../utils/logger.js'
import { buildPositionFeeContext, feeModelDescription } from '../simulation/feeContextService.js'
import { callArkResponses, parseJsonObject } from '../simulation/llmResponseUtils.js'
import { getActiveArkModel } from '../simulation/llmRuntimeConfigService.js'
import type { StrategyMarketData } from '../simulation/realtimeDataAdapter.js'
import { getActivePromptPack } from '../trade_strategy/tradeStrategyConfigService.js'

type DecisionInput = {
  ticker: string
  universe: SimulationUniverseItem[]
  account: LiveAccountDashboardResponse
  marketData: Extract<StrategyMarketData, { ok: true }>
  allPositions: Position[]
  position?: Position
  dataWindow: LlmDataWindowRecommendation
  riskModel: string
  trendContext?: TrendContextSummary
}

export async function requestLiveTradingDecision(input: DecisionInput): Promise<LlmTradingDecision> {
  const startedAt = performance.now()
  const model = getActiveArkModel()
  logger.info({ event: 'live.llm.decision.started', ticker: input.ticker, model }, 'Live LLM decision started')
  const response = await callArkResponses(buildLiveDecisionPrompt(input))
  if (response.ok === false) {
    const decision = blockedDecision(input, `实盘大模型交易决策调用失败：${response.error}`)
    logger.error({ event: 'live.llm.decision.failed', ticker: input.ticker, model, durationMs: durationMs(startedAt), error: response.error }, 'Live LLM decision failed')
    return decision
  }
  const decision = parseLiveTradingDecision(response.text, input)
  logger.info(
    {
      event: decision.ok ? 'live.llm.decision.succeeded' : 'live.llm.decision.failed',
      ticker: input.ticker,
      model,
      action: decision.action,
      approved: decision.approved,
      orderQuantity: decision.orderQuantity,
      confidence: decision.confidence,
      durationMs: durationMs(startedAt),
      error: decision.error,
    },
    decision.ok ? 'Live LLM decision succeeded' : 'Live LLM decision failed',
  )
  return decision
}

export function buildLiveDecisionPrompt(input: DecisionInput): Array<{ role: string; content: string }> {
  const ticker = input.ticker.toUpperCase()
  const targetInstrument = input.universe.find((item) => item.ticker.toUpperCase() === ticker)
  const targetExposure = summarizeTargetExposure(input.ticker, input.position)
  const promptPack = getActivePromptPack('live')
  const contextRules = promptPack.contextRules ?? {}
  return [
    {
      role: 'system',
      content: promptPack.systemPrompts.live ?? '你是 Futu REAL 实盘美股正股/ETF半自动交易研究员。只能返回 JSON，不要 Markdown。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: promptPack.tasks?.live ?? '为单个标的生成本轮 Futu REAL 实盘候选交易决策',
        hardConstraints: [...(promptPack.hardConstraints?.common ?? []), ...(promptPack.hardConstraints?.live ?? [])],
        universe: input.universe,
        targetTicker: ticker,
        targetInstrument,
        account: {
          accountId: input.account.selectedAccountId,
          displayCurrency: input.account.summary.currency,
          tradingCurrency: input.account.summary.tradingCurrency ?? 'USD',
          displayTotalAssets: input.account.summary.totalAssets,
          displayCash: input.account.summary.cash,
          displayBuyingPower: input.account.summary.buyingPower,
          totalAssets: input.account.summary.totalAssetsInTradingCurrency ?? input.account.summary.totalAssets,
          cash: input.account.summary.cashInTradingCurrency ?? input.account.summary.cash,
          availableFunds: input.account.summary.availableFundsInTradingCurrency ?? input.account.summary.availableFunds,
          buyingPower: input.account.summary.buyingPowerInTradingCurrency ?? input.account.summary.buyingPower,
          tradingCurrencyContext: {
            rule: '交易币种必须跟随 targetInstrument.tradingCurrency。US 标的使用 USD 字段计算名义金额、权益占比和购买力，不得用 displayCurrency/HKD 字段计算 USD 股票仓位比例；HK 标的使用 HKD 口径的 displayCurrency/displayBuyingPower/displayCash，并按港股交易时段理解。availableFundsUsd 是可用/可提现现金；buyingPowerUsd 是 Futu 最大购买力换算到 USD 后的值，判断能否买入应优先看 buyingPowerUsd（US 标的）；HK 标的应看 HKD 购买力。',
            totalAssetsUsd: input.account.summary.totalAssetsInTradingCurrency ?? input.account.summary.totalAssets,
            cashUsd: input.account.summary.cashInTradingCurrency ?? input.account.summary.cash,
            availableFundsUsd: input.account.summary.availableFundsInTradingCurrency ?? input.account.summary.availableFunds,
            buyingPowerUsd: input.account.summary.buyingPowerInTradingCurrency ?? input.account.summary.buyingPower,
          },
          positions: summarizePositions(input.allPositions, input.universe),
        },
        portfolioContext: {
          targetExposure,
          derivativePositionRule: 'OPTION 持仓只作为账户风险上下文；不得把 OPTION 的负数量解释为正股空头。SHORT_PUT 是卖空 PUT，通常代表对标的的看多/接货义务，不是 SELL_SHORT 正股。',
          concentrationRule: '单票集中度不是固定硬上限，不得因为超过某个固定百分比就自动禁止加仓或强制 SELL_TO_CLOSE。已有多头是否加仓，必须结合趋势质量、波动率、流动性、已有浮盈、账户可用资金、增量风险回报和组合相关性动态判断。SELL_TO_CLOSE 必须基于趋势转弱、止损/止盈、回撤控制、流动性恶化或其他明确风险降低理由。',
          positionQuantityConvention: contextRules.positionQuantityConvention ?? 'positionQuantity > 0 means long shares; positionQuantity < 0 means short shares; positionQuantity = 0 or null means flat.',
          orderQuantityConvention: contextRules.orderQuantityConvention ?? 'orderQuantity is the positive integer share count for this new order only; never use a negative orderQuantity.',
          feeContextRules: {
            ...contextRules.feeContextRules,
            source: '提交前费用为后端估算值；真实费用只能在 REAL 订单产生 orderId 后通过 order_fee_query 回填。',
            model: feeModelDescription(),
            netPnLRule: '判断是否平仓/回补时必须优先看 estimatedFeeContext.estimatedNetUnrealizedPnL。',
          },
          actionSemantics: {
            ...contextRules.actionSemantics,
            BUY: '买入；如果 targetExposure.exposureSide 为 SHORT，BUY 表示买入平仓/回补空头，orderQuantity 上限为 abs(positionQuantity)。',
            SELL_SHORT: '实盘卖空开仓或增加空头，可用于票池内正股/ETF；高风险，必须小仓位且说明保证金、强平、ETF每日重置和波动拖累风险。',
            SELL_TO_CLOSE: '平掉已有多头，不用于回补空头。',
            HOLD: '不交易。',
          },
        },
        currentPosition: input.position
          ? {
              ticker: input.position.ticker,
              assetType: input.position.assetType,
              positionQuantity: input.position.quantity,
              numericPositionQuantity: parsePositionQuantity(input.position),
              exposureSide: exposureSide(input.position),
              marketValue: input.position.marketValue,
              currentPrice: input.position.currentPrice,
              todayPnL: input.position.todayPnL,
              unrealizedPnL: input.position.unrealizedPnL,
              estimatedFeeContext: buildPositionFeeContext(input.position, input.marketData.lastPrice),
            }
          : null,
        riskModel: input.riskModel,
        marketData: {
          ticker: input.marketData.ticker,
          marketState: input.marketData.marketState,
          lastPrice: input.marketData.lastPrice,
          bestAsk: input.marketData.bestAsk,
          bestBid: input.marketData.bestBid,
          recentKlineBars: input.marketData.bars.slice(-input.dataWindow.kline1mBars),
          recentTickerPoints: input.marketData.tickerPoints.slice(-input.dataWindow.tickerPoints),
          asks: input.marketData.asks.slice(0, input.dataWindow.orderBookDepth),
          bids: input.marketData.bids.slice(0, input.dataWindow.orderBookDepth),
          trendContext: input.trendContext,
          updatedAt: input.marketData.updatedAt,
        },
        requiredJson: {
          ...promptPack.requiredJson,
          approved: true,
          action: 'HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE',
          ticker,
          orderQuantity: 0,
          limitPrice: input.marketData.lastPrice,
          confidence: 'low | medium | high',
          reason: '中文交易理由；必须说明该建议仅进入待确认队列，不会自动提交。',
          riskAssessment: '中文风险说明；若 SELL_SHORT，必须包含卖空/保证金/回补风险。',
          trendAlignment: 'WITH_TREND | AGAINST_TREND | REVERSAL_ATTEMPT | NO_TREND | UNAVAILABLE',
          tradeHorizon: 'SCALP | INTRADAY | SWING_1_TO_7_DAYS',
          whyNotNoise: '中文说明：为什么这不是仅由短周期噪声触发。若是 HOLD，说明为什么短周期信号不足。',
          dataWindowUsed: {
            kline1mBars: input.dataWindow.kline1mBars,
            tickerPoints: input.dataWindow.tickerPoints,
            orderBookDepth: input.dataWindow.orderBookDepth,
          },
        },
      }),
    },
  ]
}

export function parseLiveTradingDecision(text: string, input: DecisionInput): LlmTradingDecision {
  const parsed = parseJsonObject(text)
  if (!parsed) return blockedDecision(input, '大模型未返回可解析 JSON。', text)

  const action = String(parsed.action ?? 'HOLD').toUpperCase()
  const ticker = String(parsed.ticker ?? input.ticker).toUpperCase()
  const orderQuantity = Number(parsed.orderQuantity ?? parsed.quantity ?? 0)
  const limitPrice = Number(parsed.limitPrice ?? 0)
  const approved = parsed.approved === true
  if (!['HOLD', 'BUY', 'SELL_SHORT', 'SELL_TO_CLOSE'].includes(action)) return blockedDecision(input, `非法交易动作：${action}`, text)
  if (ticker !== input.ticker.toUpperCase()) return blockedDecision(input, `模型返回 ticker ${ticker} 与目标 ${input.ticker} 不一致。`, text)

  return {
    ok: true,
    approved,
    action: action as LlmTradingDecision['action'],
    ticker,
    orderQuantity: Number.isFinite(orderQuantity) ? Math.max(0, Math.floor(orderQuantity)) : 0,
    limitPrice: Number.isFinite(limitPrice) ? limitPrice : 0,
    confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'low',
    reason: typeof parsed.reason === 'string' ? parsed.reason : '大模型未提供理由。',
    riskAssessment: typeof parsed.riskAssessment === 'string' ? parsed.riskAssessment : '大模型未提供风险说明。',
    trendAlignment: parseTrendAlignment(parsed.trendAlignment),
    tradeHorizon: parseTradeHorizon(parsed.tradeHorizon),
    whyNotNoise: typeof parsed.whyNotNoise === 'string' ? parsed.whyNotNoise : '模型未说明短周期噪声过滤依据。',
    dataWindowUsed: parseDataWindowUsed(parsed.dataWindowUsed, input.dataWindow),
    rawText: text,
  }
}

function summarizePositions(positions: Position[], universe: SimulationUniverseItem[]) {
  const universeTickers = new Set(universe.map((item) => item.ticker.toUpperCase()))
  return positions
    .filter((position) => {
      const ticker = (position.underlyingTicker || position.ticker).toUpperCase()
      return position.assetType === 'STOCK' || position.assetType === 'ETF' || universeTickers.has(ticker)
    })
    .map((position) => ({
      ticker: position.assetType === 'OPTION' ? position.ticker.toUpperCase() : (position.underlyingTicker || position.ticker).toUpperCase(),
      contractTicker: position.ticker.toUpperCase(),
      underlyingTicker: (position.underlyingTicker || position.ticker).toUpperCase(),
      assetType: position.assetType,
      optionType: position.optionType,
      strike: position.strike,
      expirationDate: position.expirationDate,
      contractSummary: position.contractSummary,
      positionQuantity: position.quantity,
      numericPositionQuantity: parsePositionQuantity(position),
      positionSide: position.positionSide ?? positionSide(position),
      exposureSide: position.assetType === 'OPTION' ? optionExposureSide(position) : exposureSide(position),
      optionPositionType: optionPositionType(position),
      underlyingDirectionalExposure: underlyingDirectionalExposure(position),
      interpretation: positionInterpretation(position),
      marketValue: position.marketValue,
      currentPrice: position.currentPrice,
      unrealizedPnL: position.unrealizedPnL,
      estimatedFeeContext: buildPositionFeeContext(position),
      currency: position.currency,
    }))
}

function summarizeTargetExposure(ticker: string, position?: Position) {
  return {
    ticker: ticker.toUpperCase(),
    hasPosition: Boolean(position),
    assetType: position?.assetType ?? 'STOCK',
    numericPositionQuantity: parsePositionQuantity(position),
    exposureSide: exposureSide(position),
    instruction: 'Do not assume no position if account.positions contains this ticker; targetExposure only represents direct STOCK/ETF exposure. Related option positions are listed in account.positions and must not be treated as direct stock shorts.',
  }
}

function exposureSide(position?: Position): 'LONG' | 'SHORT' | 'FLAT' {
  const quantity = parsePositionQuantity(position)
  if (quantity > 0) return 'LONG'
  if (quantity < 0) return 'SHORT'
  return 'FLAT'
}

function positionSide(position?: Position): 'LONG' | 'SHORT' | 'FLAT' {
  return exposureSide(position)
}

function optionPositionType(position: Position): string | undefined {
  if (position.assetType !== 'OPTION') return undefined
  const side = positionSide(position)
  if ((position.optionType === 'CALL' || position.optionType === 'PUT') && side !== 'FLAT') return `${side}_${position.optionType}`
  return position.optionPositionType
}

function underlyingDirectionalExposure(position: Position): string | undefined {
  if (position.assetType !== 'OPTION') return positionSide(position)
  const type = optionPositionType(position)
  if (type === 'LONG_CALL' || type === 'SHORT_PUT') return 'BULLISH'
  if (type === 'SHORT_CALL' || type === 'LONG_PUT') return 'BEARISH'
  return position.underlyingDirectionalExposure ?? 'NEUTRAL'
}

function optionExposureSide(position: Position): 'LONG' | 'SHORT' | 'FLAT' {
  return positionSide(position)
}

function positionInterpretation(position: Position): string {
  if (position.assetType !== 'OPTION') return 'Direct STOCK/ETF position; quantity sign maps to direct long/short exposure.'
  const type = optionPositionType(position)
  if (type === 'SHORT_PUT') return 'Short PUT: bullish/short-volatility option exposure with potential assignment obligation; not a direct short stock position.'
  if (type === 'LONG_PUT') return 'Long PUT: bearish option exposure; not a direct short stock position.'
  if (type === 'SHORT_CALL') return 'Short CALL: bearish/capped-upside option obligation; not a direct short stock position.'
  if (type === 'LONG_CALL') return 'Long CALL: bullish option exposure; not a direct long stock position.'
  return 'Option position; do not interpret quantity sign as direct stock exposure.'
}

function parsePositionQuantity(position?: Position): number {
  if (!position) return 0
  const numeric = Number(position.quantity.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(numeric) ? numeric : 0
}

function parseDataWindowUsed(value: unknown, fallback: LlmDataWindowRecommendation): LlmTradingDecision['dataWindowUsed'] {
  if (!value || typeof value !== 'object') {
    return {
      kline1mBars: fallback.kline1mBars,
      tickerPoints: fallback.tickerPoints,
      orderBookDepth: fallback.orderBookDepth,
    }
  }
  const record = value as Record<string, unknown>
  return {
    kline1mBars: Number(record.kline1mBars) || fallback.kline1mBars,
    tickerPoints: Number(record.tickerPoints) || fallback.tickerPoints,
    orderBookDepth: Number(record.orderBookDepth) || fallback.orderBookDepth,
  }
}

function parseTrendAlignment(value: unknown): NonNullable<LlmTradingDecision['trendAlignment']> {
  if (value === 'WITH_TREND' || value === 'AGAINST_TREND' || value === 'REVERSAL_ATTEMPT' || value === 'NO_TREND' || value === 'UNAVAILABLE') return value
  return 'UNAVAILABLE'
}

function parseTradeHorizon(value: unknown): NonNullable<LlmTradingDecision['tradeHorizon']> {
  if (value === 'SCALP' || value === 'INTRADAY' || value === 'SWING_1_TO_7_DAYS') return value
  return 'INTRADAY'
}

function blockedDecision(input: DecisionInput, error: string, rawText?: string): LlmTradingDecision {
  return {
    ok: false,
    approved: false,
    action: 'HOLD',
    ticker: input.ticker.toUpperCase(),
    orderQuantity: 0,
    limitPrice: input.marketData.lastPrice,
    confidence: 'low',
    reason: error,
    riskAssessment: '实盘决策未通过，保持观望。',
    trendAlignment: input.trendContext?.window.available ? 'NO_TREND' : 'UNAVAILABLE',
    tradeHorizon: 'INTRADAY',
    whyNotNoise: error,
    dataWindowUsed: {
      kline1mBars: input.dataWindow.kline1mBars,
      tickerPoints: input.dataWindow.tickerPoints,
      orderBookDepth: input.dataWindow.orderBookDepth,
    },
    rawText,
    error,
  }
}
