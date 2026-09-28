import type { OrderIntentEvent, OrderIntentState } from './contracts.js'

const transitions: Readonly<Record<OrderIntentState, Partial<Record<OrderIntentEvent, OrderIntentState>>>> = {
  PENDING_CONFIRMATION: {
    CLAIM: 'CLAIMED',
    REJECT: 'REJECTED',
    EXPIRE: 'EXPIRED',
  },
  CLAIMED: {
    BEGIN_SUBMIT: 'SUBMITTING',
    REJECT: 'REJECTED',
    EXPIRE: 'EXPIRED',
  },
  SUBMITTING: {
    ACKNOWLEDGE: 'SUBMITTED',
    FAIL: 'FAILED',
  },
  SUBMITTED: {
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    REQUEST_CANCEL: 'CANCEL_REQUESTED',
    FAIL: 'FAILED',
  },
  PARTIALLY_FILLED: {
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    REQUEST_CANCEL: 'CANCEL_REQUESTED',
    FAIL: 'FAILED',
  },
  CANCEL_REQUESTED: {
    PARTIAL_FILL: 'PARTIALLY_FILLED',
    FILL: 'FILLED',
    CANCEL: 'CANCELLED',
    FAIL: 'FAILED',
  },
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
