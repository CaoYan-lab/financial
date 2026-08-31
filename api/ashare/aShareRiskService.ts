import type { AccountSummary, Position } from '../../shared/types.js'

export type AShareDecisionAction = 'HOLD' | 'BUY' | 'SELL_TO_CLOSE' | 'SELL_SHORT'

export type AShareRiskDecision = {
  ok: boolean
  blockedReason?: string
}

export function validateAshareDecision(action: AShareDecisionAction, session: string, input: {
  ticker?: string
  orderQuantity?: number
  limitPrice?: number
  positions?: Position[]
  accountSummary?: AccountSummary
  lotSize?: number
} = {}): AShareRiskDecision {
  if (action === 'SELL_SHORT') {
    return { ok: false, blockedReason: 'A 股第一版禁止 SELL_SHORT。' }
  }
  if (action !== 'HOLD' && session !== 'RTH') {
    return { ok: false, blockedReason: 'A 股只允许连续竞价时段生成可交易订单。' }
  }
  if (action === 'BUY') {
    const lotSize = normalizeLotSize(input.lotSize)
    const orderQuantity = Math.floor(Number(input.orderQuantity ?? 0))
    const limitPrice = Number(input.limitPrice ?? 0)
    if (!orderQuantity || orderQuantity <= 0) {
      return { ok: false, blockedReason: 'A 股买入被拦截：委托数量必须大于 0。' }
    }
    if (orderQuantity % lotSize !== 0) {
      return { ok: false, blockedReason: `A 股买入被拦截：委托数量 ${orderQuantity} 股不是一手 ${lotSize} 股的整数倍。` }
    }
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      return { ok: false, blockedReason: 'A 股买入被拦截：缺少有效限价，无法计算买入成本。' }
    }
    const estimatedFeeRate = Number(process.env.ASHARE_ESTIMATED_FEE_RATE ?? 0.001)
    const estimatedCost = orderQuantity * limitPrice * (1 + (Number.isFinite(estimatedFeeRate) && estimatedFeeRate > 0 ? estimatedFeeRate : 0))
    const availableFunds = parseAccountFunds(input.accountSummary)
    if (availableFunds === undefined) {
      return { ok: false, blockedReason: 'A 股买入被拦截：无法识别账户可用资金，不能生成真实买入订单。' }
    }
    if (estimatedCost > availableFunds) {
      return { ok: false, blockedReason: `A 股买入被拦截：预计成本 ${estimatedCost.toFixed(2)} CNY 超过可用资金 ${availableFunds.toFixed(2)} CNY。` }
    }
  }
  if (action === 'SELL_TO_CLOSE') {
    const positionQuantity = findAsharePositionQuantity(input.positions ?? [], input.ticker)
    if (positionQuantity <= 0) {
      return { ok: false, blockedReason: `A 股平仓卖出被拦截：账户当前没有 ${input.ticker ?? '该标的'} 多头持仓。` }
    }
    if (input.orderQuantity && input.orderQuantity > positionQuantity) {
      return { ok: false, blockedReason: `A 股平仓卖出被拦截：委托数量 ${input.orderQuantity} 股超过当前可识别持仓 ${positionQuantity} 股。` }
    }
  }
  return { ok: true }
}

export function normalizeAshareOrderQuantity(action: AShareDecisionAction, quantity: number, positionQuantity = 0, lotSize = 100): number {
  const normalizedLotSize = normalizeLotSize(lotSize)
  const parsed = Math.floor(Number(quantity))
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  if (action === 'BUY') return Math.floor(parsed / normalizedLotSize) * normalizedLotSize
  if (action === 'SELL_TO_CLOSE') return Math.min(parsed, Math.max(0, Math.floor(positionQuantity)))
  return 0
}

export function findAsharePositionQuantity(positions: Position[], ticker?: string): number {
  const normalizedTicker = normalizeAshareTicker(ticker)
  if (!normalizedTicker) return 0
  let total = 0
  for (const position of positions) {
    if (position.assetType !== 'STOCK' && position.assetType !== 'ETF') continue
    const positionTickers = [position.ticker, position.underlyingTicker, position.code].map(normalizeAshareTicker).filter(Boolean)
    if (!positionTickers.includes(normalizedTicker)) continue
    const quantity = parsePositionQuantity(position.quantity)
    if (quantity > 0) total += quantity
  }
  return total
}

export function parsePositionQuantity(value?: string): number {
  if (!value || value === 'unavailable') return 0
  const parsed = Number(value.replace(/[¥￥$,%\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function parseAccountFunds(summary?: AccountSummary): number | undefined {
  return parseMoney(summary?.availableFundsInTradingCurrency)
    ?? parseMoney(summary?.availableFunds)
    ?? parseMoney(summary?.buyingPowerInTradingCurrency)
    ?? parseMoney(summary?.buyingPower)
}

function parseMoney(value?: string): number | undefined {
  if (!value || value === 'unavailable') return undefined
  const parsed = Number(value.replace(/[¥￥$,%\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeLotSize(value?: number): number {
  const parsed = Math.floor(Number(value ?? 100))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100
}

function normalizeAshareTicker(value?: string): string {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!normalized) return ''
  if (/^(SH|SZ)\.\d{6}$/.test(normalized)) return normalized
  if (/^\d{6}\.(SH|SZ)$/.test(normalized)) {
    const [code, exchange] = normalized.split('.')
    return `${exchange}.${code}`
  }
  if (/^\d{6}$/.test(normalized)) {
    if (normalized.startsWith('6')) return `SH.${normalized}`
    return `SZ.${normalized}`
  }
  return normalized
}
