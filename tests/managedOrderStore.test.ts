import { beforeEach, describe, expect, it } from 'vitest'
import type { ManagedOrder } from '../shared/managedOrderTypes'
import {
  beginManagedOrderCancel,
  getManagedOrder,
  listManagedOrderEvents,
  registerManagedOrder,
  resetManagedOrderStoreForTests,
} from '../api/cloud/state/managedOrderStore'

describe('managed order store ownership and idempotency', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.CLOUD_MODE
    resetManagedOrderStoreForTests()
  })

  it('rejects orders that were not registered by the system', async () => {
    const result = await beginManagedOrderCancel({
      platform: 'futu',
      orderId: 'manual-order',
      requestId: 'request-1',
      source: 'manual',
      reason: '测试',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不属于本系统')
  })

  it('treats the same cancel request as idempotent', async () => {
    await registerManagedOrder(order())
    const first = await beginManagedOrderCancel({
      platform: 'futu',
      orderId: 'order-1',
      requestId: 'request-1',
      source: 'manual',
      reason: '测试',
    })
    const second = await beginManagedOrderCancel({
      platform: 'futu',
      orderId: 'order-1',
      requestId: 'request-1',
      source: 'manual',
      reason: '测试',
    })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: true, alreadyHandled: true })
    expect((await getManagedOrder('futu', 'order-1'))?.status).toBe('CANCEL_REQUESTED')
  })

  it('does not duplicate registration events when startup backfill repeats', async () => {
    await registerManagedOrder(order())
    await registerManagedOrder(order())

    const events = await listManagedOrderEvents('futu', 'order-1')
    expect(events.filter((event) => event.eventType === 'registered')).toHaveLength(1)
  })
})

function order(): ManagedOrder {
  const now = new Date().toISOString()
  return {
    platform: 'futu',
    orderId: 'order-1',
    pendingOrderId: 'pending-1',
    signalId: 'signal-1',
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
