import { describe, expect, it } from 'vitest'
import type { BrokerExecutionSettings, ManagedOrder } from '../shared/managedOrderTypes'
import { hardRuleCancelDecision, hasManagedOrderConflict } from '../api/live/managedOrderPolicy'

const settings: BrokerExecutionSettings = {
  autoSubmitEnabled: false,
  autoCancelEnabled: false,
  blockOpeningWhenCashNegative: false,
  marketableLimitTimeoutSeconds: 90,
  limitTimeoutSeconds: 600,
  brokerSyncIntervalSeconds: 15,
  modelReviewIntervalSeconds: 60,
  modelAutoCancelConfidence: 'high',
}

describe('managed order policy', () => {
  it('cancels stale marketable limit orders after 90 seconds', () => {
    const order = managedOrder({ orderType: 'MARKETABLE_LIMIT', submittedAt: '2026-01-01T00:00:00.000Z' })
    expect(hardRuleCancelDecision(order, settings, Date.parse('2026-01-01T00:01:31.000Z'))?.action).toBe('CANCEL')
  })

  it('keeps normal limit orders before ten minutes', () => {
    const order = managedOrder({ orderType: 'LIMIT', submittedAt: '2026-01-01T00:00:00.000Z' })
    expect(hardRuleCancelDecision(order, settings, Date.parse('2026-01-01T00:09:59.000Z'))).toBeUndefined()
  })

  it('does not timeout market orders or terminal orders', () => {
    expect(hardRuleCancelDecision(managedOrder({ orderType: 'MARKET' }), settings, Date.now() + 86_400_000)).toBeUndefined()
    expect(hardRuleCancelDecision(managedOrder({ status: 'FILLED', canCancel: false }), settings, Date.now() + 86_400_000)).toBeUndefined()
  })

  it('blocks a new order when the ticker already has a managed open order', () => {
    expect(hasManagedOrderConflict([managedOrder()], 'aapl')?.orderId).toBe('order-1')
  })
})

function managedOrder(patch: Partial<ManagedOrder> = {}): ManagedOrder {
  return {
    platform: 'futu',
    orderId: 'order-1',
    pendingOrderId: 'pending-1',
    signalId: 'signal-1',
    ticker: 'AAPL',
    side: 'BUY',
    orderType: 'MARKETABLE_LIMIT',
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    submittedQuantity: 1,
    executedQuantity: 0,
    remainingQuantity: 1,
    submittedPrice: 100,
    executedPrice: null,
    latestPrice: 100,
    priceDriftPct: 0,
    brokerStatus: 'SUBMITTED',
    status: 'TRACKING',
    canCancel: true,
    submittedAt: new Date(Date.now() - 120_000).toISOString(),
    ownershipVerified: true,
    hardRuleReasons: [],
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  }
}
