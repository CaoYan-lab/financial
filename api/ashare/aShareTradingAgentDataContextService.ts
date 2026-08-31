import { getAshareUniverse } from './aShareUniverseService.js'
import type { AShareRealtimeSnapshot } from './aShareRealtimeStore.js'
import { buildAshareMarketDataContext, fetchAshareFutuStockContext, fetchAshareFutuStockNewsContext } from './aShareTradingAgentFutuDataSource.js'
import { getAshareMacroNewsContextForRun } from './aShareTradingAgentMacroContextService.js'
import type { AShareTradingAgentDataContext } from './aShareTradingAgentTypes.js'
import type { AShareUniverseItem } from './types.js'
import type { AccountSummary, Position } from '../../shared/types.js'
import { findAsharePositionQuantity, parsePositionQuantity } from './aShareRiskService.js'

export async function buildAshareTradingAgentDataContext(input: {
  instrument: AShareUniverseItem
  marketData: AShareRealtimeSnapshot
  session: string
  positions?: Position[]
  accountSummary?: AccountSummary
}): Promise<AShareTradingAgentDataContext> {
  const generatedAt = new Date().toISOString()
  const universe = getAshareUniverse().universe
  const marketDataContext = buildAshareMarketDataContext(input.marketData)
  const [futuStockContext, stockNewsContext, macroNewsContext] = await Promise.all([
    fetchAshareFutuStockContext(input.instrument),
    fetchAshareFutuStockNewsContext(input.instrument),
    getAshareMacroNewsContextForRun(),
  ])
  const warnings = [
    ...marketDataWarnings(marketDataContext),
    ...futuStockContext.warnings,
    ...stockNewsContext.warnings,
    ...macroNewsContext.snapshot.warnings,
  ]
  const targetLongQuantity = findAsharePositionQuantity(input.positions ?? [], input.instrument.ticker)
  const matchingPositions = targetPositions(input.positions ?? [], input.instrument.ticker)
  const limitPrice = numericPrice(input.marketData.quote?.price)
  const sizingContext = buildSizingContext(input.accountSummary, matchingPositions, targetLongQuantity, limitPrice)
  return {
    ticker: input.instrument.ticker,
    futuCode: input.instrument.futuCode,
    name: input.instrument.name,
    generatedAt,
    marketDataContext,
    futuStockContext,
    stockNewsContext,
    macroNewsContext,
    accountPositionContext: {
      source: 'futu-account',
      targetTicker: input.instrument.ticker,
      targetLongQuantity,
      matchingPositions,
      rule: 'SELL_TO_CLOSE 只能用于平掉已存在的多头持仓；targetLongQuantity=0 时必须 HOLD 或 BUY，不得卖出。',
    },
    sizingContext,
    aShareRulesContext: {
      session: input.session,
      allowedActions: ['HOLD', 'BUY', 'SELL_TO_CLOSE'],
      forbiddenActions: ['SELL_SHORT'],
      humanConfirmationRequired: true,
      orderSession: 'RTH',
      constraints: [
        'A 股只多头，禁止 SELL_SHORT。',
        '非 HOLD 决策必须先过 Node 层 A 股硬风控。',
        '真实提交订单前必须人工确认。',
        'Futu stock context 是研究/资金/异动/市场状态补充，不等同于新闻。',
        '新闻和宏观上下文只能提高风险约束，不能覆盖行情事实和硬风控。',
      ],
    },
    universeContext: {
      size: universe.length,
      tickers: universe.map((item) => item.ticker),
      current: input.instrument,
    },
    dataQualityContext: {
      status: inferDataQualityStatus(warnings),
      warnings,
    },
  }
}

function buildSizingContext(accountSummary: AccountSummary | undefined, matchingPositions: Position[], targetLongQuantity: number, limitPrice: number | null): AShareTradingAgentDataContext['sizingContext'] {
  const lotSize = Number(process.env.ASHARE_LOT_SIZE ?? 100)
  const maxSingleOrderNotional = Number(process.env.ASHARE_MAX_SINGLE_ORDER_NOTIONAL ?? 50_000)
  const maxPositionRatio = Number(process.env.ASHARE_MAX_POSITION_RATIO ?? 0.2)
  const estimatedFeeRate = Number(process.env.ASHARE_ESTIMATED_FEE_RATE ?? 0.001)
  const availableFunds = parseMoney(accountSummary?.availableFundsInTradingCurrency) ?? parseMoney(accountSummary?.availableFunds)
  const buyingPower = parseMoney(accountSummary?.buyingPowerInTradingCurrency) ?? parseMoney(accountSummary?.buyingPower)
  return {
    source: 'node-adapter',
    currency: 'CNY',
    lotSize: Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 100,
    lastPrice: limitPrice,
    limitPrice,
    availableFunds: availableFunds ?? null,
    buyingPower: buyingPower ?? null,
    targetLongQuantity,
    targetMarketValue: sumMoney(matchingPositions.map((position) => position.marketValue)),
    targetAverageCost: weightedAverageCost(matchingPositions),
    maxSingleOrderNotional: Number.isFinite(maxSingleOrderNotional) && maxSingleOrderNotional > 0 ? maxSingleOrderNotional : 50_000,
    maxPositionRatio: Number.isFinite(maxPositionRatio) && maxPositionRatio > 0 ? maxPositionRatio : 0.2,
    estimatedFeeRate: Number.isFinite(estimatedFeeRate) && estimatedFeeRate >= 0 ? estimatedFeeRate : 0.001,
    minBuyNotional: limitPrice && limitPrice > 0 ? limitPrice * (Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 100) : null,
    accountSummary,
    rules: [
      'BUY 数量必须是 lotSize 的整数倍。',
      'BUY 必须满足 limitPrice * orderQuantity + estimatedFee <= availableFunds/buyingPower。',
      'SELL_TO_CLOSE 数量不得超过 targetLongQuantity。',
      'Trading Agent 只给建议规模；Node 后端会做确定性归一化和硬校验。',
    ],
  }
}

function parseMoney(value?: string): number | undefined {
  if (!value || value === 'unavailable') return undefined
  const parsed = Number(value.replace(/[¥￥$,%\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function numericPrice(value?: string): number | null {
  const parsed = parseMoney(value)
  return parsed !== undefined ? parsed : null
}

function sumMoney(values: string[]): number | null {
  const parsed = values.map(parseMoney).filter((value): value is number => value !== undefined)
  if (!parsed.length) return null
  return parsed.reduce((sum, value) => sum + value, 0)
}

function weightedAverageCost(positions: Position[]): number | null {
  let totalQuantity = 0
  let totalCost = 0
  for (const position of positions) {
    const quantity = parsePositionQuantity(position.quantity)
    const averageCost = parseMoney(position.averageCost)
    if (quantity <= 0 || averageCost === undefined) continue
    totalQuantity += quantity
    totalCost += quantity * averageCost
  }
  return totalQuantity > 0 ? totalCost / totalQuantity : null
}

function targetPositions(positions: Position[], ticker: string): Position[] {
  const normalizedTicker = normalizeTicker(ticker)
  return positions.filter((position) => [position.ticker, position.underlyingTicker, position.code].map(normalizeTicker).includes(normalizedTicker))
}

function normalizeTicker(value?: string): string {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (/^(SH|SZ)\.\d{6}$/.test(normalized)) return normalized
  if (/^\d{6}\.(SH|SZ)$/.test(normalized)) {
    const [code, exchange] = normalized.split('.')
    return `${exchange}.${code}`
  }
  if (/^\d{6}$/.test(normalized)) return normalized.startsWith('6') ? `SH.${normalized}` : `SZ.${normalized}`
  return normalized
}

function marketDataWarnings(context: ReturnType<typeof buildAshareMarketDataContext>): string[] {
  const warnings: string[] = []
  if (!context.quote) warnings.push('marketDataContext.quote unavailable.')
  if (context.recentKlineBars.length < 120) warnings.push(`marketDataContext.recentKlineBars partial: ${context.recentKlineBars.length}/120.`)
  if (context.recentTickerPoints.length < 1) warnings.push('marketDataContext.recentTickerPoints unavailable.')
  if (!context.asks.length && !context.bids.length) warnings.push('marketDataContext.orderBook unavailable.')
  return warnings
}

function inferDataQualityStatus(warnings: string[]): AShareTradingAgentDataContext['dataQualityContext']['status'] {
  if (warnings.some((warning) => warning.includes('quote unavailable') || warning.includes('recentTickerPoints unavailable'))) return 'BLOCKING'
  return warnings.length ? 'PARTIAL' : 'OK'
}
