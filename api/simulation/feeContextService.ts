import type { EstimatedPositionFeeContext, Position } from '../../shared/types.js'

const MIN_ORDER_FEE = 1
const PER_SHARE_FEE = 0.005
const REGULATORY_RESERVE_RATE = 0.0001
const MAX_FEE_RATIO = 0.003

export function estimateSingleOrderFee(quantity: number, price: number): number {
  const absQuantity = Math.abs(quantity)
  if (!Number.isFinite(absQuantity) || absQuantity <= 0 || !Number.isFinite(price) || price <= 0) return 0
  const commission = Math.max(MIN_ORDER_FEE, absQuantity * PER_SHARE_FEE)
  const regulatoryReserve = absQuantity * price * REGULATORY_RESERVE_RATE
  return roundMoney(commission + regulatoryReserve)
}

export function estimateRoundTripFee(quantity: number, entryPrice: number, exitPrice = entryPrice): number {
  return roundMoney(estimateSingleOrderFee(quantity, entryPrice) + estimateSingleOrderFee(quantity, exitPrice))
}

export function buildPositionFeeContext(position: Position, marketPrice?: number): EstimatedPositionFeeContext {
  const positionQuantity = parseMoneyNumber(position.quantity) ?? 0
  const absPositionQuantity = Math.abs(positionQuantity)
  const averageCost = parseMoneyNumber(position.averageCost)
  const currentPrice = Number.isFinite(marketPrice) && marketPrice !== undefined ? marketPrice : parseMoneyNumber(position.currentPrice)
  const grossUnrealizedPnL = parseMoneyNumber(position.unrealizedPnL)
  const estimatedEntryFee = averageCost !== undefined && absPositionQuantity > 0 ? estimateSingleOrderFee(absPositionQuantity, averageCost) : null
  const estimatedExitFee = currentPrice !== undefined && absPositionQuantity > 0 ? estimateSingleOrderFee(absPositionQuantity, currentPrice) : null
  const estimatedRoundTripFee = estimatedEntryFee !== null && estimatedExitFee !== null ? roundMoney(estimatedEntryFee + estimatedExitFee) : null
  const estimatedNetUnrealizedPnL =
    grossUnrealizedPnL !== undefined && estimatedRoundTripFee !== null ? roundMoney(grossUnrealizedPnL - estimatedRoundTripFee) : null
  const estimatedExitFeeRatioToGrossPnL =
    grossUnrealizedPnL !== undefined && grossUnrealizedPnL > 0 && estimatedExitFee !== null ? roundRatio(estimatedExitFee / grossUnrealizedPnL) : null

  return {
    source: 'estimated',
    currency: position.currency || 'USD',
    positionQuantity,
    absPositionQuantity,
    averageCost: averageCost ?? null,
    currentPrice: currentPrice ?? null,
    grossUnrealizedPnL: grossUnrealizedPnL ?? null,
    estimatedEntryFee,
    estimatedExitFee,
    estimatedRoundTripFee,
    estimatedNetUnrealizedPnL,
    estimatedExitFeeRatioToGrossPnL,
    grossProfitButNetLoss: Boolean(grossUnrealizedPnL !== undefined && grossUnrealizedPnL > 0 && estimatedNetUnrealizedPnL !== null && estimatedNetUnrealizedPnL < 0),
    note: 'Estimated because Futu SIMULATE does not support order_fee_query; use estimatedNetUnrealizedPnL rather than gross unrealizedPnL when judging whether closing is profitable.',
  }
}

export function parseMoneyNumber(value: string | undefined): number | undefined {
  if (!value || value === 'unavailable') return undefined
  const numeric = Number(value.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(numeric) ? numeric : undefined
}

export function feeModelDescription(): string {
  return `Estimated US stock fee model: each order fee = max(${formatMoney(MIN_ORDER_FEE)}, abs(qty) * ${formatMoney(PER_SHARE_FEE)}) + 1bp notional regulatory/slippage reserve; round trip must be <= ${(MAX_FEE_RATIO * 100).toFixed(2)}% notional. Position fee context is estimated because Futu SIMULATE does not support order_fee_query.`
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`
}
