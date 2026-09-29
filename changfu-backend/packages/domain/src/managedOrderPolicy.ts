export type ManagedOrderCancellationReason =
  | 'SIGNAL_EXPIRED'
  | 'INTENT_EXPIRED'
  | 'FILL_TIMEOUT'
  | 'NO_FILL_PROGRESS'
  | 'PRICE_DRIFT'
  | 'MARKET_DATA_STALE'
  | 'SESSION_ENDED'
  | 'SECURITY_HALTED'
  | 'BROKER_NOT_MARKETABLE'
  | 'ACCOUNT_RISK_CHANGED'
  | 'LEASE_LOST'
  | 'CONNECTION_DISABLED'

export type ManagedOrderPolicyInput = {
  now: Date
  signalValidUntil: Date
  intentExpiresAt: Date
  submittedAt: Date
  orderType: 'MARKETABLE_LIMIT' | 'LIMIT'
  limitPrice: number
  latestReferencePrice: number | null
  marketDataFresh: boolean
  marketSessionOpen: boolean
  securityHalted: boolean
  brokerMarketable: boolean
  accountRiskValid: boolean
  leaseValid: boolean
  connectionActive: boolean
  filledQuantity: number
  lastFilledQuantity: number
  lastFillProgressAt: Date | null
}

export function managedOrderCancellationReason(
  input: ManagedOrderPolicyInput,
): ManagedOrderCancellationReason | null {
  const now = input.now.getTime()
  if (input.signalValidUntil.getTime() <= now) return 'SIGNAL_EXPIRED'
  if (input.intentExpiresAt.getTime() <= now) return 'INTENT_EXPIRED'
  if (!input.leaseValid) return 'LEASE_LOST'
  if (!input.connectionActive) return 'CONNECTION_DISABLED'
  if (!input.marketSessionOpen) return 'SESSION_ENDED'
  if (input.securityHalted) return 'SECURITY_HALTED'
  if (!input.brokerMarketable) return 'BROKER_NOT_MARKETABLE'
  if (!input.accountRiskValid) return 'ACCOUNT_RISK_CHANGED'
  if (!input.marketDataFresh || input.latestReferencePrice === null) {
    return 'MARKET_DATA_STALE'
  }

  const driftBps = Math.abs(input.latestReferencePrice - input.limitPrice)
    / input.limitPrice * 10_000
  if (!Number.isFinite(driftBps) || driftBps > 15) return 'PRICE_DRIFT'

  const timeoutMs = input.orderType === 'MARKETABLE_LIMIT' ? 90_000 : 600_000
  if (now - input.submittedAt.getTime() >= timeoutMs) return 'FILL_TIMEOUT'
  if (
    input.filledQuantity > 0
    && input.filledQuantity === input.lastFilledQuantity
    && input.lastFillProgressAt
    && now - input.lastFillProgressAt.getTime() >= timeoutMs
  ) {
    return 'NO_FILL_PROGRESS'
  }
  return null
}
