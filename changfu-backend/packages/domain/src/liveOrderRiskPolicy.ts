import type { OrderSpec } from './signedOrderIntent.js'

export type LiveOrderRiskCode =
  | 'ENVIRONMENT_NOT_REAL'
  | 'UNSUPPORTED_INSTRUMENT'
  | 'INVALID_QUANTITY'
  | 'QUOTE_STALE'
  | 'MARKET_CLOSED'
  | 'OPEN_ORDER_CONFLICT'
  | 'INSUFFICIENT_BUYING_POWER'
  | 'INSUFFICIENT_POSITION'
  | 'ZERO_POSITION_CROSS'
  | 'SHORT_ACCOUNT_REQUIRED'
  | 'SHORT_RISK_DISCLOSURE_REQUIRED'
  | 'SHORT_AVAILABILITY_UNKNOWN'
  | 'SHORT_QUANTITY_EXCEEDED'
  | 'MARGIN_CALL_ACTIVE'
  | 'HK_LOT_SIZE_INVALID'

export type LiveOrderRiskInput = {
  order: OrderSpec
  instrumentType: 'STOCK' | 'ETF' | 'OPTION' | 'UNKNOWN'
  quoteFresh: boolean
  marketOpen: boolean
  hasOpenOrderConflict: boolean
  availableBuyingPower: number
  longQuantity: number
  shortQuantity: number
  lotSize: number | null
  marginAccount: boolean
  marginCallActive: boolean
  shortRiskDisclosureAccepted: boolean
  shortable: boolean | null
  maxShortQuantity: number | null
}

export type LiveOrderRiskDecision =
  | { allowed: true }
  | { allowed: false; code: LiveOrderRiskCode }

function reject(code: LiveOrderRiskCode): LiveOrderRiskDecision {
  return { allowed: false, code }
}

export function evaluateLiveOrderRisk(input: LiveOrderRiskInput): LiveOrderRiskDecision {
  const { order } = input
  const quantity = Number(order.quantity)
  const limitPrice = Number(order.limitPrice)
  if (order.environment !== 'REAL') return reject('ENVIRONMENT_NOT_REAL')
  if (input.instrumentType !== 'STOCK' && input.instrumentType !== 'ETF') {
    return reject('UNSUPPORTED_INSTRUMENT')
  }
  if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(limitPrice) || limitPrice <= 0) {
    return reject('INVALID_QUANTITY')
  }
  if (!input.quoteFresh) return reject('QUOTE_STALE')
  if (!input.marketOpen) return reject('MARKET_CLOSED')
  if (input.hasOpenOrderConflict) return reject('OPEN_ORDER_CONFLICT')
  if (order.market === 'HK' && (!input.lotSize || quantity % input.lotSize !== 0)) {
    return reject('HK_LOT_SIZE_INVALID')
  }
  switch (order.positionEffect) {
    case 'OPEN_LONG':
    case 'ADD_LONG':
      if (input.marginCallActive) return reject('MARGIN_CALL_ACTIVE')
      if (input.shortQuantity > 0) return reject('ZERO_POSITION_CROSS')
      return quantity * limitPrice <= input.availableBuyingPower
        ? { allowed: true }
        : reject('INSUFFICIENT_BUYING_POWER')
    case 'REDUCE_LONG':
      if (input.shortQuantity > 0) return reject('ZERO_POSITION_CROSS')
      return quantity <= input.longQuantity
        ? { allowed: true }
        : reject('INSUFFICIENT_POSITION')
    case 'COVER_SHORT':
      if (input.longQuantity > 0) return reject('ZERO_POSITION_CROSS')
      return quantity <= input.shortQuantity
        ? { allowed: true }
        : reject('INSUFFICIENT_POSITION')
    case 'OPEN_SHORT':
    case 'ADD_SHORT':
      if (input.marginCallActive) return reject('MARGIN_CALL_ACTIVE')
      if (input.longQuantity > 0) return reject('ZERO_POSITION_CROSS')
      if (!input.marginAccount) return reject('SHORT_ACCOUNT_REQUIRED')
      if (!input.shortRiskDisclosureAccepted) return reject('SHORT_RISK_DISCLOSURE_REQUIRED')
      if (input.shortable !== true || input.maxShortQuantity === null) {
        return reject('SHORT_AVAILABILITY_UNKNOWN')
      }
      return quantity <= input.maxShortQuantity
        ? { allowed: true }
        : reject('SHORT_QUANTITY_EXCEEDED')
  }
}
