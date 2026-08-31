import type { LlmDataWindowRecommendation, LlmTradingDecision, Position, SimulationAccountDashboardResponse, SimulationUniverseItem, TrendContextSummary } from '../../shared/types.js'
import { durationMs, logger } from '../utils/logger.js'
import { buildPositionFeeContext } from './feeContextService.js'
import type { StrategyMarketData } from './realtimeDataAdapter.js'
import { callArkResponses, parseJsonObject } from './llmResponseUtils.js'
import { getActiveArkModel } from './llmRuntimeConfigService.js'
import { getActivePromptPack } from '../trade_strategy/tradeStrategyConfigService.js'

type DecisionInput = {
  ticker: string
  universe: SimulationUniverseItem[]
  account: SimulationAccountDashboardResponse
  marketData: Extract<StrategyMarketData, { ok: true }>
  allPositions: Position[]
  position?: Position
  dataWindow: LlmDataWindowRecommendation
  trendContext?: TrendContextSummary
  feeModel: string
  riskModel: string
}

export async function requestTradingDecision(input: DecisionInput): Promise<LlmTradingDecision> {
  const startedAt = performance.now()
  const model = getActiveArkModel()
  logger.info({ event: 'llm.decision.started', ticker: input.ticker, model }, 'LLM decision started')
  const response = await callArkResponses(buildDecisionPrompt(input))
  if (response.ok === false) {
    const decision = blockedDecision(input, `大模型交易决策调用失败：${response.error}`)
    logger.error({ event: 'llm.decision.failed', ticker: input.ticker, model, durationMs: durationMs(startedAt), error: response.error }, 'LLM decision failed')
    return decision
  }
  const decision = parseTradingDecision(response.text, input)
  logger.info(
    {
      event: decision.ok ? 'llm.decision.succeeded' : 'llm.decision.failed',
      ticker: input.ticker,
      model,
      action: decision.action,
      approved: decision.approved,
      orderQuantity: decision.orderQuantity,
      confidence: decision.confidence,
      durationMs: durationMs(startedAt),
      error: decision.error,
    },
    decision.ok ? 'LLM decision succeeded' : 'LLM decision failed',
  )
  return decision
}

export function buildDecisionPrompt(input: DecisionInput): Array<{ role: string; content: string }> {
  const ticker = input.ticker.toUpperCase()
  const targetInstrument = input.universe.find((item) => item.ticker.toUpperCase() === ticker)
  const targetExposure = summarizeTargetExposure(input.ticker, input.position)
  const promptPack = getActivePromptPack('simulation')
  const contextRules = promptPack.contextRules ?? {}
  return [
    {
      role: 'system',
      content: promptPack.systemPrompts.simulation ?? '你是 Futu SIMULATE 模拟盘美股正股/ETF自主交易模型。只能返回 JSON，不要 Markdown。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: promptPack.tasks?.simulation ?? '为单个标的生成本轮模拟盘交易决策',
        hardConstraints: [...(promptPack.hardConstraints?.common ?? []), ...(promptPack.hardConstraints?.simulation ?? [])],
        universe: input.universe,
        targetTicker: ticker,
        targetInstrument,
        account: {
          accountId: input.account.selectedAccountId,
          totalAssets: input.account.summary.totalAssets,
          cash: input.account.summary.cash,
          buyingPower: input.account.summary.buyingPower,
          dailyPnL: input.account.summary.dailyPnL,
          totalPnL: input.account.summary.totalPnL,
          positions: summarizePositions(input.allPositions, input.universe),
        },
        portfolioContext: {
          allPositions: summarizePositions(input.allPositions, input.universe),
          targetExposure,
          shortCoverContext: buildShortCoverContext(targetExposure),
          derivativePositionRule: 'OPTION 持仓只作为账户风险上下文；不得把 OPTION 的负数量解释为正股空头。SHORT_PUT 是卖空 PUT，通常代表对标的的看多/接货义务，不是 SELL_SHORT 正股。',
          positionQuantityConvention: contextRules.positionQuantityConvention ?? 'positionQuantity > 0 means long shares; positionQuantity < 0 means short shares; positionQuantity = 0 or null means flat.',
          orderQuantityConvention: contextRules.orderQuantityConvention ?? 'orderQuantity is the positive integer share count for this new order only; never use a negative orderQuantity.',
          feeContextRules: {
            ...contextRules.feeContextRules,
            source: '费用为后端估算值，Futu SIMULATE 不支持真实 order_fee_query。',
            netPnLRule: '判断是否平仓/回补时必须优先看 estimatedFeeContext.estimatedNetUnrealizedPnL，而不是只看 unrealizedPnL。',
            grossProfitButNetLossRule:
              '若 estimatedFeeContext.grossProfitButNetLoss 为 true，说明毛浮盈为正但扣除开平仓估算费用后为亏损；除非用于止损、降低风险或避免更大回撤，不应仅因毛浮盈为正而平仓。',
          },
          actionSemantics: {
            ...contextRules.actionSemantics,
            BUY: '买入；如果 targetExposure.exposureSide 为 SHORT，BUY 表示买入平仓/回补空头、降低风险，不是开多。空头回补的 orderQuantity 上限是 abs(targetExposure.numericPositionQuantity)，即使 buyingPower 为 0 也不应仅因此拒绝回补；如果无空头，可用于开多。',
            SELL_SHORT: '卖空开仓或增加空头，仅限 SIMULATE 票池内正股/ETF。',
            SELL_TO_CLOSE: '平掉已有多头，不用于回补空头。',
            HOLD: '不交易。',
          },
          forbiddenShortCoverLanguage: contextRules.forbiddenShortCoverLanguage ?? [
            '不要说购买力允许回补',
            '不要说购买力足以覆盖回补',
            '不要说购买力不足所以不能回补',
            '不要把回补数量解释为由 buyingPower 决定',
          ],
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
        feeModel: input.feeModel,
        riskModel: input.riskModel,
        marketData: {
          ticker: input.marketData.ticker,
          marketState: input.marketData.marketState,
          lastPrice: input.marketData.lastPrice,
          bestAsk: input.marketData.bestAsk,
          bestBid: input.marketData.bestBid,
          executionWindow: {
            recentKlineBars: input.marketData.bars.slice(-input.dataWindow.kline1mBars),
            recentTickerPoints: input.marketData.tickerPoints.slice(-input.dataWindow.tickerPoints),
            asks: input.marketData.asks.slice(0, input.dataWindow.orderBookDepth),
            bids: input.marketData.bids.slice(0, input.dataWindow.orderBookDepth),
            updatedAt: input.marketData.updatedAt,
          },
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
          reason: '中文交易理由；若 BUY 回补或 SELL_TO_CLOSE 平仓，必须说明预估费用是否被净收益覆盖，或说明为何即使扣费后亏损也需要止损/降风险。',
          riskAssessment: '中文风险说明；必须考虑 estimatedNetUnrealizedPnL 与 grossProfitButNetLoss。',
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
      name: position.name,
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
      todayPnL: position.todayPnL,
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
    instruction: 'Do not assume no position if allPositions contains this ticker; targetExposure only represents direct STOCK/ETF exposure. Related option positions are listed in allPositions and must not be treated as direct stock shorts.',
  }
}

function buildShortCoverContext(targetExposure: ReturnType<typeof summarizeTargetExposure>) {
  if (targetExposure.exposureSide !== 'SHORT') {
    return {
      applies: false,
      maxCoverQuantity: 0,
      buyingPowerRule: 'Only applies to opening BUY or SELL_SHORT, not to short-cover BUY.',
    }
  }
  return {
    applies: true,
    maxCoverQuantity: Math.abs(targetExposure.numericPositionQuantity),
    buyingPowerRule: 'Do not use buyingPower to decide whether short-cover BUY is allowed; use maxCoverQuantity, market signal, risk reduction, fees, and order book liquidity.',
    wordingRule: 'In reason and riskAssessment, never say buyingPower allows, covers, or prevents short covering.',
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

export function parseTradingDecision(text: string, input: DecisionInput): LlmTradingDecision {
  const parsed = parseJsonObject(text)
  if (!parsed) return blockedDecision(input, '大模型未返回可解析 JSON。', text)

  const action = String(parsed.action ?? 'HOLD').toUpperCase()
  const ticker = String(parsed.ticker ?? input.ticker).toUpperCase()
  const orderQuantity = Number(parsed.orderQuantity ?? parsed.quantity ?? 0)
  const limitPrice = Number(parsed.limitPrice ?? 0)
  const approved = parsed.approved === true
  if (!['HOLD', 'BUY', 'SELL_SHORT', 'SELL_TO_CLOSE'].includes(action)) return blockedDecision(input, `非法交易动作：${action}`, text)
  if (ticker !== input.ticker.toUpperCase()) return blockedDecision(input, `模型返回 ticker ${ticker} 与目标 ${input.ticker} 不一致。`, text)

  return normalizeShortExposureDecision(
    {
      ok: true,
      approved,
      action: action as LlmTradingDecision['action'],
      ticker,
      orderQuantity: Number.isFinite(orderQuantity) ? orderQuantity : 0,
      limitPrice: Number.isFinite(limitPrice) ? limitPrice : 0,
      confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'low',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '大模型未提供理由。',
      riskAssessment: typeof parsed.riskAssessment === 'string' ? parsed.riskAssessment : '大模型未提供风险说明。',
      trendAlignment: parseTrendAlignment(parsed.trendAlignment),
      tradeHorizon: parseTradeHorizon(parsed.tradeHorizon),
      whyNotNoise: typeof parsed.whyNotNoise === 'string' ? parsed.whyNotNoise : '模型未说明短周期噪声过滤依据。',
      dataWindowUsed: parseDataWindowUsed(parsed.dataWindowUsed, input.dataWindow),
      rawText: text,
    },
    input,
  )
}

function normalizeShortExposureDecision(decision: LlmTradingDecision, input: DecisionInput): LlmTradingDecision {
  const targetQuantity = parsePositionQuantity(input.position)
  if (targetQuantity >= 0) return decision
  const maxCoverQuantity = Math.abs(targetQuantity)
  const orderQuantity = decision.action === 'BUY' ? Math.min(decision.orderQuantity, maxCoverQuantity) : decision.orderQuantity
  return {
    ...decision,
    orderQuantity,
    reason: sanitizeShortCoverBuyingPowerText(decision.reason, decision.action),
    riskAssessment: sanitizeShortCoverBuyingPowerText(decision.riskAssessment, decision.action),
  }
}

function sanitizeShortCoverBuyingPowerText(value: string, action: LlmTradingDecision['action']): string {
  const sentences = value
    .split(/(?<=[。！？；;])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !isMisleadingShortCoverBuyingPowerSentence(sentence))
  const normalized = sentences.join('')
  const suffix =
    action === 'BUY'
      ? '本次 BUY 为买入平仓，依据现有空头股数、行情反弹风险、费用和流动性控制数量，不按开仓资金约束判断。'
      : '是否回补应依据现有空头股数、行情反弹风险、费用和流动性判断，不按开仓资金约束决定。'
  return normalized ? `${normalized}${suffix}` : suffix
}

function isMisleadingShortCoverBuyingPowerSentence(sentence: string): boolean {
  return sentence.includes('购买力') || sentence.includes('buyingPower')
}

function parseDataWindowUsed(value: unknown, fallback: LlmDataWindowRecommendation): LlmTradingDecision['dataWindowUsed'] {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
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
    riskAssessment: '大模型交易决策不可用，本轮不交易。',
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
