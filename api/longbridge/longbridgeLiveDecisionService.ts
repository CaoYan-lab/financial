import type { LiveAccountDashboardResponse, LlmDataWindowRecommendation, LlmTradingDecision, Position, SimulationUniverseItem, TrendContextSummary } from '../../shared/types.js'
import type { LongbridgeStrategyMarketData } from '../../shared/longbridgeTypes.js'
import type { ManagedOrder } from '../../shared/managedOrderTypes.js'
import { callArkResponses, parseJsonObject } from '../simulation/llmResponseUtils.js'
import { getActiveArkModel } from '../simulation/llmRuntimeConfigService.js'
import { LLM_SIMULATION_UNIVERSE } from '../simulation/simulationUniverse.js'
import { buildRiskModelDescription, getActivePromptPack } from '../trade_strategy/tradeStrategyConfigService.js'
import { durationMs, logger } from '../utils/logger.js'
import { fallbackLotSize, longbridgeOpeningLotSizeFailureReason } from './longbridgeLotSizeService.js'
import {
  longbridgeFinancingOpeningRestricted,
  longbridgeFinancingRiskLabel,
  parseMoney,
} from './longbridgeRiskService.js'

type DecisionInput = {
  symbol: string
  account: LiveAccountDashboardResponse
  marketData: Extract<LongbridgeStrategyMarketData, { ok: true }>
  dataWindow: LlmDataWindowRecommendation
  trendContext?: TrendContextSummary
  universe?: SimulationUniverseItem[]
  managedOpenOrders?: ManagedOrder[]
  blockOpeningWhenCashNegative?: boolean
}

export async function requestLongbridgeLiveTradingDecision(input: DecisionInput): Promise<LlmTradingDecision> {
  const startedAt = performance.now()
  const model = getActiveArkModel()
  logger.info({ event: 'longbridge.llm.decision.started', symbol: input.symbol, model }, 'Longbridge LLM decision started')
  const response = await callArkResponses(buildLongbridgeLiveDecisionPrompt(input))
  if (response.ok === false) return blockedDecision(input, `长桥实盘大模型交易决策调用失败：${response.error}`)
  const decision = parseLongbridgeTradingDecision(response.text, input)
  logger.info(
    {
      event: decision.ok ? 'longbridge.llm.decision.succeeded' : 'longbridge.llm.decision.failed',
      symbol: input.symbol,
      action: decision.action,
      approved: decision.approved,
      durationMs: durationMs(startedAt),
      error: decision.error,
    },
    decision.ok ? 'Longbridge LLM decision succeeded' : 'Longbridge LLM decision failed',
  )
  return decision
}

export function buildLongbridgeLiveDecisionPrompt(input: DecisionInput): Array<{ role: string; content: string }> {
  const promptPack = getActivePromptPack('live')
  const universe = input.universe ?? LLM_SIMULATION_UNIVERSE
  const ticker = input.marketData.ticker.toUpperCase()
  const targetInstrument = universe.find((item) => item.ticker.toUpperCase() === ticker)
  const currentPosition = input.account.positions.find((position) => position.ticker.toUpperCase() === ticker || position.underlyingTicker?.toUpperCase() === ticker)
  const targetExposure = summarizeTargetExposure(ticker, currentPosition)
  const contextRules = promptPack.contextRules ?? {}
  const buyingPower = input.account.summary.buyingPowerInTradingCurrency ?? input.account.summary.buyingPower
  const buyingPowerNumeric = parseMoney(buyingPower)
  const availableFunds = input.account.summary.availableFundsInTradingCurrency ?? input.account.summary.availableFunds
  const availableFundsNumeric = parseMoney(availableFunds)
  const lotSize = input.marketData.lotSize ?? fallbackLotSize(input.marketData.symbol)
  const isHongKong = input.marketData.symbol.toUpperCase().endsWith('.HK')
  const tradingCurrency = input.account.summary.tradingCurrency ?? (isHongKong ? 'HKD' : 'USD')
  const financingOpeningRestricted = longbridgeFinancingOpeningRestricted(input.account.summary)
  const financingRiskLabel = input.account.summary.financingRiskLabel
    ?? longbridgeFinancingRiskLabel(input.account.summary.financingRiskLevel)
  const system = platformize(promptPack.systemPrompts.live ?? '你是长桥证券 REAL 实盘美股/港股正股与 ETF 半自动交易研究员。只能返回 JSON，不要 Markdown。')
  const task = platformize(promptPack.tasks?.live ?? '为单个标的生成本轮 Longbridge REAL 实盘候选交易决策')
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: JSON.stringify({
        task,
        platformRuntime: {
          platform: 'Longbridge',
          mode: 'REAL_DRY_RUN',
          dataSource: 'Longbridge SDK cache / Skill / CLI / MCP',
          orderPolicy: '本轮只允许生成信号、候选和待确认订单；禁止直接提交真实订单。',
        },
        hardConstraints: [...(promptPack.hardConstraints?.common ?? []), ...(promptPack.hardConstraints?.live ?? [])].map(platformize),
        universe,
        targetTicker: ticker,
        targetSymbol: input.symbol.toUpperCase(),
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
          availableFunds,
          buyingPower,
          availableFundsNumeric,
          buyingPowerNumeric,
          maxOpeningNotional: buyingPowerNumeric,
          financingRisk: {
            level: input.account.summary.financingRiskLevel ?? null,
            label: financingRiskLabel,
            openingRestricted: financingOpeningRestricted,
            initialMargin: input.account.summary.initialMargin ?? '不可用',
            maintenanceMargin: input.account.summary.maintenanceMargin ?? '不可用',
            marginCall: input.account.summary.marginCall ?? '不可用',
            maximumFinancing: input.account.summary.maximumFinancing ?? '不可用',
            remainingFinancing: input.account.summary.remainingFinancing ?? '不可用',
            rule: financingOpeningRestricted
              ? '长桥账户已进入融资预警、危险或保证金不足状态；即使 buyingPower 大于 0 也禁止新增仓位，必须 HOLD 或仅减仓/平仓。'
              : '融资风险等级是购买力之前的开仓门禁；风险等级达到预警或危险时，即使 buyingPower 大于 0 也禁止新增仓位。',
          },
          blockOpeningWhenCashNegative:
            input.blockOpeningWhenCashNegative !== false,
          orderSizingConstraint:
            financingOpeningRestricted
              ? `长桥融资风险等级为${financingRiskLabel}，账户已禁止新增开仓；不得使用剩余购买力继续融资，必须 HOLD 或仅减仓/平仓。`
              : input.blockOpeningWhenCashNegative !== false
              && availableFundsNumeric !== undefined
              && availableFundsNumeric < 0
              ? `负现金开仓保护已开启，当前可用现金为 ${formatMoney(availableFundsNumeric, tradingCurrency)}；禁止 BUY 新增长仓和 SELL_SHORT 新增空仓，只允许 SELL_TO_CLOSE 或 BUY 回补现有空头。`
              : buyingPowerNumeric !== undefined
                ? `开仓 BUY / SELL_SHORT 的 orderQuantity * limitPrice 不得超过最大购买力 ${formatMoney(buyingPowerNumeric, tradingCurrency)}；若最小交易单位也超过最大购买力，必须 HOLD。`
                : '最大购买力不可解析；开仓 BUY / SELL_SHORT 必须 HOLD。',
          tradingUnit: {
            lotSize,
            rule: isHongKong
              ? `港股开仓 BUY / SELL_SHORT 的 orderQuantity 必须是每手 ${lotSize} 股的正整数倍；禁止返回零股、碎股或不足一手的数量。若账户无法承担至少 ${lotSize} 股，必须 HOLD。`
              : '美股 orderQuantity 按正整数股计算，不套用港股整手约束。',
          },
          tradingCurrencyContext: {
            rule: '交易币种必须跟随 targetInstrument.tradingCurrency。US 标的使用 USD 字段计算名义金额、权益占比和购买力；HK 标的使用对应交易币种口径，并按长桥返回的市场时段理解。availableFunds 是可用资金；buyingPower 是长桥最大购买力，判断能否买入应优先看 buyingPower。',
            totalAssetsUsd: input.account.summary.totalAssetsInTradingCurrency ?? input.account.summary.totalAssets,
            cashUsd: input.account.summary.cashInTradingCurrency ?? input.account.summary.cash,
            availableFundsUsd: availableFunds,
            buyingPowerUsd: buyingPower,
          },
          positions: summarizePositions(input.account.positions, universe),
          source: 'longbridge-cli',
        },
        portfolioContext: {
          targetExposure,
          derivativePositionRule: 'OPTION 持仓只作为账户风险上下文；不得把 OPTION 的负数量解释为正股空头。',
          concentrationRule: '单票集中度不是固定硬上限，不得因为超过某个固定百分比就自动禁止加仓或强制 SELL_TO_CLOSE。已有持仓是否加仓，必须结合趋势质量、波动率、流动性、已有浮盈、账户可用资金、增量风险回报和组合相关性动态判断。',
          positionQuantityConvention: contextRules.positionQuantityConvention ?? 'positionQuantity > 0 means long shares; positionQuantity < 0 means short shares; positionQuantity = 0 or null means flat.',
          orderQuantityConvention: `${contextRules.orderQuantityConvention ?? 'orderQuantity is the positive integer share count for this new order only; never use a negative orderQuantity.'} ${isHongKong ? `当前港股每手 ${lotSize} 股，开仓数量必须是 ${lotSize} 的正整数倍。` : '当前为美股，不套用港股整手约束。'}`,
          actionSemantics: {
            ...contextRules.actionSemantics,
            BUY: '买入；如果 targetExposure.exposureSide 为 SHORT，BUY 表示买入平仓/回补空头，orderQuantity 上限为 abs(positionQuantity)。',
            SELL_SHORT: '长桥实盘 dry-run 卖空开仓或增加空头；高风险，必须小仓位且说明保证金、强平、ETF每日重置和波动拖累风险。',
            SELL_TO_CLOSE: '平掉已有多头，不用于回补空头。',
            HOLD: '不交易。',
          },
          managedOpenOrdersForTicker: (input.managedOpenOrders ?? []).map((order) => ({
            platform: order.platform,
            orderId: order.orderId,
            ticker: order.ticker,
            side: order.side,
            orderType: order.orderType,
            status: order.status,
            submittedQuantity: order.submittedQuantity,
            executedQuantity: order.executedQuantity,
            remainingQuantity: order.remainingQuantity,
            submittedPrice: order.submittedPrice,
            submittedAt: order.submittedAt,
          })),
          managedOrderRule: '如存在尚未终态的系统挂单，本轮不得生成重复或反向订单，必须 HOLD，等待挂单监管器处理。',
        },
        currentPosition: currentPosition
          ? {
              ticker: currentPosition.ticker,
              assetType: currentPosition.assetType,
              positionQuantity: currentPosition.quantity,
              numericPositionQuantity: parsePositionQuantity(currentPosition),
              exposureSide: exposureSide(currentPosition),
              marketValue: currentPosition.marketValue,
              currentPrice: currentPosition.currentPrice,
              todayPnL: currentPosition.todayPnL,
              unrealizedPnL: currentPosition.unrealizedPnL,
              currency: currentPosition.currency,
            }
          : null,
        riskModel: buildRiskModelDescription('live'),
        marketData: {
          source: input.marketData.source,
          symbol: input.marketData.symbol,
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
          warnings: input.marketData.warnings,
        },
        requiredJson: {
          ...promptPack.requiredJson,
          approved: true,
          action: 'HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE',
          ticker,
          orderQuantity: 0,
          limitPrice: input.marketData.lastPrice,
          confidence: 'low | medium | high',
          reason: '中文交易理由；必须说明该建议仅进入长桥待确认队列，不会自动提交。',
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

function formatMoney(value: number, currency = 'USD') {
  const prefix = currency === 'HKD' ? 'HK$' : '$'
  return Number.isFinite(value) ? `${prefix}${value.toFixed(2)}` : 'unavailable'
}

export function parseLongbridgeTradingDecision(text: string, input: DecisionInput): LlmTradingDecision {
  const parsed = parseJsonObject(text)
  if (!parsed) return blockedDecision(input, '大模型未返回可解析 JSON。', text)
  const action = String(parsed.action ?? 'HOLD').toUpperCase()
  const ticker = String(parsed.ticker ?? input.marketData.ticker).toUpperCase()
  const orderQuantity = Number(parsed.orderQuantity ?? parsed.quantity ?? 0)
  const normalizedOrderQuantity = Number.isFinite(orderQuantity) ? Math.max(0, Math.floor(orderQuantity)) : 0
  const limitPrice = Number(parsed.limitPrice ?? input.marketData.lastPrice)
  const approved = parsed.approved === true
  if (!['HOLD', 'BUY', 'SELL_SHORT', 'SELL_TO_CLOSE'].includes(action)) return blockedDecision(input, `非法交易动作：${action}`, text)
  if (ticker !== input.marketData.ticker.toUpperCase()) return blockedDecision(input, `模型返回 ticker ${ticker} 与目标 ${input.marketData.ticker} 不一致。`, text)
  const lotSizeFailure = longbridgeOpeningLotSizeFailureReason({
    symbol: input.marketData.symbol,
    action: action as LlmTradingDecision['action'],
    quantity: normalizedOrderQuantity,
    lotSize: input.marketData.lotSize,
  })
  if (approved && action !== 'HOLD' && lotSizeFailure) {
    return blockedDecision(input, `长桥实盘决策被拦截：${lotSizeFailure}`, text)
  }
  return {
    ok: true,
    approved,
    action: action as LlmTradingDecision['action'],
    ticker,
    orderQuantity: normalizedOrderQuantity,
    limitPrice: Number.isFinite(limitPrice) ? limitPrice : input.marketData.lastPrice,
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

function blockedDecision(input: DecisionInput, error: string, rawText?: string): LlmTradingDecision {
  return {
    ok: false,
    approved: false,
    action: 'HOLD',
    ticker: input.marketData.ticker.toUpperCase(),
    orderQuantity: 0,
    limitPrice: input.marketData.ok ? input.marketData.lastPrice : 0,
    confidence: 'low',
    reason: error,
    riskAssessment: '长桥实盘 dry-run 已阻断，不会生成订单。',
    dataWindowUsed: input.dataWindow,
    rawText,
    error,
  }
}

function parseDataWindowUsed(value: unknown, fallback: LlmDataWindowRecommendation) {
  if (!value || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  return {
    kline1mBars: clampInt(record.kline1mBars, fallback.kline1mBars),
    tickerPoints: clampInt(record.tickerPoints, fallback.tickerPoints),
    orderBookDepth: clampInt(record.orderBookDepth, fallback.orderBookDepth),
  }
}

function clampInt(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback
}

function parseTrendAlignment(value: unknown): LlmTradingDecision['trendAlignment'] {
  return value === 'WITH_TREND' || value === 'AGAINST_TREND' || value === 'REVERSAL_ATTEMPT' || value === 'NO_TREND' || value === 'UNAVAILABLE' ? value : 'UNAVAILABLE'
}

function parseTradeHorizon(value: unknown): LlmTradingDecision['tradeHorizon'] {
  return value === 'SCALP' || value === 'INTRADAY' || value === 'SWING_1_TO_7_DAYS' ? value : 'INTRADAY'
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
      positionSide: position.positionSide ?? exposureSide(position),
      exposureSide: position.assetType === 'OPTION' ? exposureSide(position) : exposureSide(position),
      marketValue: position.marketValue,
      currentPrice: position.currentPrice,
      unrealizedPnL: position.unrealizedPnL,
      todayPnL: position.todayPnL,
      currency: position.currency,
      interpretation: position.assetType === 'OPTION' ? 'Option position; do not interpret quantity sign as direct stock exposure.' : 'Direct STOCK/ETF position; quantity sign maps to direct long/short exposure.',
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

function parsePositionQuantity(position?: Position): number {
  if (!position) return 0
  const numeric = Number(position.quantity.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(numeric) ? numeric : 0
}

function platformize(text: string): string {
  return text
    .replace(/Futu REAL/g, 'Longbridge REAL')
    .replace(/Futu OpenD/g, 'Longbridge CLI')
    .replace(/Futu/g, 'Longbridge')
    .replace(/富途/g, '长桥')
}
