import type { OrderIntentState } from './contracts.js'
import type { OrderSpec } from './signedOrderIntent.js'

export type LatestSignalAction =
  | 'HOLD'
  | 'BUY'
  | 'BUY_TO_COVER'
  | 'SELL_TO_CLOSE'
  | 'SELL_SHORT'

export type ManagedOrderConflictInput = {
  state: OrderIntentState
  order: OrderSpec
  latestAction: LatestSignalAction
  proposedOrder?: OrderSpec | null
  hasExternalOpenOrder?: boolean
}

export type ManagedOrderConflictDecision =
  | { action: 'ALLOW_NEW' }
  | { action: 'CONTINUE_EXISTING' }
  | { action: 'SUPERSEDE_PENDING'; reason: 'LATEST_SIGNAL_CHANGED' }
  | {
      action: 'REQUEST_CANCEL'
      reason: 'LATEST_SIGNAL_HOLD' | 'LATEST_SIGNAL_CONFLICT' | 'ORDER_PARAMETERS_CHANGED'
    }
  | { action: 'BLOCK_RECONCILE'; reason: 'SUBMISSION_UNKNOWN' | 'CANCEL_IN_PROGRESS' }
  | { action: 'BLOCK_EXTERNAL_ORDER'; reason: 'EXTERNAL_OPEN_ORDER' }

const terminalStates = new Set<OrderIntentState>([
  'SUPERSEDED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
  'EXPIRED',
])

const pendingStates = new Set<OrderIntentState>(['PENDING_CONFIRMATION', 'CLAIMED'])
const cancelStates = new Set<OrderIntentState>([
  'CANCEL_REQUESTED',
  'CANCEL_PENDING',
  'CANCEL_UNCERTAIN',
])

export function normalizeTradingSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase()
  const suffix = value.match(/^(.+)\.(US|HK)$/)
  if (suffix) return `${suffix[2]}.${suffix[1]}`
  return value
}

function actionForOrder(order: OrderSpec): LatestSignalAction {
  switch (order.positionEffect) {
    case 'OPEN_LONG':
    case 'ADD_LONG':
      return 'BUY'
    case 'COVER_SHORT':
      return 'BUY_TO_COVER'
    case 'REDUCE_LONG':
      return 'SELL_TO_CLOSE'
    case 'OPEN_SHORT':
    case 'ADD_SHORT':
      return 'SELL_SHORT'
  }
}

function sameParameters(left: OrderSpec, right: OrderSpec): boolean {
  return left.broker === right.broker
    && left.environment === right.environment
    && left.market === right.market
    && normalizeTradingSymbol(left.symbol) === normalizeTradingSymbol(right.symbol)
    && left.side === right.side
    && left.positionEffect === right.positionEffect
    && left.orderType === right.orderType
    && left.tradingSession === right.tradingSession
    && left.timeInForce === right.timeInForce
    && left.quantity === right.quantity
    && left.limitPrice === right.limitPrice
    && left.currency === right.currency
    && left.maxSlippageBps === right.maxSlippageBps
}

export function decideSameSymbolConflict(
  input: ManagedOrderConflictInput,
): ManagedOrderConflictDecision {
  if (input.hasExternalOpenOrder) {
    return { action: 'BLOCK_EXTERNAL_ORDER', reason: 'EXTERNAL_OPEN_ORDER' }
  }
  if (terminalStates.has(input.state)) return { action: 'ALLOW_NEW' }
  if (input.state === 'SUBMITTING' || input.state === 'UNKNOWN') {
    return { action: 'BLOCK_RECONCILE', reason: 'SUBMISSION_UNKNOWN' }
  }
  if (cancelStates.has(input.state)) {
    return { action: 'BLOCK_RECONCILE', reason: 'CANCEL_IN_PROGRESS' }
  }

  const latestMatches = actionForOrder(input.order) === input.latestAction
  if (pendingStates.has(input.state)) {
    if (
      latestMatches
      && input.proposedOrder
      && sameParameters(input.order, input.proposedOrder)
    ) {
      return { action: 'CONTINUE_EXISTING' }
    }
    return { action: 'SUPERSEDE_PENDING', reason: 'LATEST_SIGNAL_CHANGED' }
  }

  if (input.latestAction === 'HOLD') {
    return { action: 'REQUEST_CANCEL', reason: 'LATEST_SIGNAL_HOLD' }
  }
  if (!latestMatches) {
    return { action: 'REQUEST_CANCEL', reason: 'LATEST_SIGNAL_CONFLICT' }
  }
  if (!input.proposedOrder || !sameParameters(input.order, input.proposedOrder)) {
    return { action: 'REQUEST_CANCEL', reason: 'ORDER_PARAMETERS_CHANGED' }
  }
  return { action: 'CONTINUE_EXISTING' }
}
