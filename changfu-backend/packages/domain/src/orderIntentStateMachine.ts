import type { OrderIntentEvent, OrderIntentState } from './contracts.js'

const transitions: Readonly<Record<OrderIntentState, Partial<Record<OrderIntentEvent, OrderIntentState>>>> = {
  PENDING_CONFIRMATION: {
    CLAIM: 'CLAIMED',
    REJECT: 'REJECTED',
    EXPIRE: 'EXPIRED',
    SUPERSEDE: 'SUPERSEDED',
  },
  CLAIMED: {
    BEGIN_SUBMIT: 'SUBMITTING',
    REJECT: 'REJECTED',
    EXPIRE: 'EXPIRED',
    SUPERSEDE: 'SUPERSEDED',
  },
  SUBMITTING: {
    ACKNOWLEDGE: 'SUBMITTED',
    FAIL: 'FAILED',
    MARK_UNKNOWN: 'UNKNOWN',
  },
  SUBMITTED: {
    TRACK: 'TRACKING',
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    REQUEST_CANCEL: 'CANCEL_REQUESTED',
    FAIL: 'FAILED',
    MARK_UNKNOWN: 'UNKNOWN',
  },
  TRACKING: {
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    REQUEST_CANCEL: 'CANCEL_REQUESTED',
    FAIL: 'FAILED',
    MARK_UNKNOWN: 'UNKNOWN',
  },
  PARTIALLY_FILLED: {
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    REQUEST_CANCEL: 'CANCEL_REQUESTED',
    FAIL: 'FAILED',
    MARK_UNKNOWN: 'UNKNOWN',
  },
  CANCEL_REQUESTED: {
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    CANCEL_PENDING: 'CANCEL_PENDING',
    CANCEL: 'CANCELLED',
    FAIL: 'FAILED',
    MARK_UNKNOWN: 'CANCEL_UNCERTAIN',
  },
  CANCEL_PENDING: {
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    CANCEL: 'CANCELLED',
    CANCEL_UNCERTAIN: 'CANCEL_UNCERTAIN',
  },
  CANCEL_UNCERTAIN: {
    FILL: 'FILLED',
    CANCEL: 'CANCELLED',
  },
  UNKNOWN: {
    ACKNOWLEDGE: 'SUBMITTED',
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    REQUEST_CANCEL: 'CANCEL_REQUESTED',
    CANCEL: 'CANCELLED',
    FAIL: 'FAILED',
  },
  SUPERSEDED: {},
  FILLED: {},
  CANCELLED: {},
  REJECTED: {},
  FAILED: {},
  EXPIRED: {},
}

export class InvalidOrderTransitionError extends Error {
  constructor(
    readonly currentState: OrderIntentState,
    readonly event: OrderIntentEvent,
  ) {
    super(`订单意图不能从 ${currentState} 处理 ${event}`)
    this.name = 'InvalidOrderTransitionError'
  }
}

export function transitionOrderIntent(
  currentState: OrderIntentState,
  event: OrderIntentEvent,
): OrderIntentState {
  const next = transitions[currentState][event]
  if (!next) throw new InvalidOrderTransitionError(currentState, event)
  return next
}

export function isTerminalOrderIntentState(state: OrderIntentState): boolean {
  return transitions[state] && Object.keys(transitions[state]).length === 0
}
