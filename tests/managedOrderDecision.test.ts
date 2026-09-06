import { describe, expect, it } from 'vitest'
import type { ManagedOrder } from '../shared/managedOrderTypes'
import { parseManagedOrderDecisions } from '../api/live/managedOrderDecisionService'

describe('managed order model decisions', () => {
  it('accepts only known orders and legal actions', () => {
    const result = parseManagedOrderDecisions(JSON.stringify({
      decisions: [
        { platform: 'futu', orderId: 'known', action: 'CANCEL', confidence: 'high', reason: '信号反转' },
        { platform: 'futu', orderId: 'unknown', action: 'CANCEL', confidence: 'high' },
        { platform: 'futu', orderId: 'known', action: 'REPLACE', confidence: 'high' },
      ],
    }), [order()])
    expect(result.size).toBe(1)
    expect(result.get('futu:known')).toMatchObject({ action: 'CANCEL', confidence: 'high' })
  })

  it('returns no executable decision for invalid JSON', () => {
    expect(parseManagedOrderDecisions('not-json', [order()]).size).toBe(0)
  })
})

function order(): ManagedOrder {
  const now = new Date().toISOString()
  return {
    platform: 'futu',
    orderId: 'known',
    pendingOrderId: 'pending',
    signalId: 'signal',
    ticker: 'AAPL',
    side: 'BUY',
    orderType: 'LIMIT',
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
    submittedAt: now,
    ownershipVerified: true,
    hardRuleReasons: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}
