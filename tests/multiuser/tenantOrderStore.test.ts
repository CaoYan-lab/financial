import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LivePendingOrder } from '../../shared/types.js'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
}))

import {
  expireTenantPendingOrders,
  getTenantPendingOrder,
  rejectTenantPendingOrder,
} from '../../api/cloud/multiuser/longbridge/tenantOrderStore.js'

function pendingOrder(id = 'pending-1'): LivePendingOrder {
  const now = new Date().toISOString()
  return {
    id,
    status: 'PENDING_CONFIRMATION',
    createdAt: now,
    updatedAt: now,
    intent: {
      ticker: 'AAPL',
      side: 'BUY',
      quantity: 1,
      orderType: 'MARKETABLE_LIMIT',
      orderSession: 'RTH',
      limitPrice: 100,
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      signalId: 'signal-1',
      reason: '测试',
      feeContext: {
        source: 'estimated',
        currency: 'USD',
        feeAmount: 1,
        feeDetails: [],
      },
    },
    signal: {
      id: 'signal-1',
      ticker: 'AAPL',
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      side: 'BUY',
      confidence: 'high',
      reason: '测试',
      price: '$100.00',
      quantity: '1',
      limitPrice: '$100.00',
      riskAssessment: '测试',
      generatedAt: now,
      dataWindow: '测试',
      source: 'futu-callback',
    },
    llmDecision: {
      ok: true,
      approved: true,
      action: 'BUY',
      ticker: 'AAPL',
      orderQuantity: 1,
      limitPrice: 100,
      confidence: 'high',
      reason: '测试',
      riskAssessment: '测试',
      dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
    },
    riskWarnings: [],
  }
}

describe('Longbridge 租户待确认订单存储', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('订单查询始终同时携带 user_id、binding_id 和 order id', async () => {
    mocks.queryOne.mockResolvedValue({ payload: pendingOrder() })

    await expect(getTenantPendingOrder('user-a', 'binding-a', 'pending-1')).resolves.toMatchObject({
      id: 'pending-1',
    })

    const [sql, params] = mocks.queryOne.mock.calls[0]
    expect(sql).toContain('user_id = $1 AND binding_id = $2')
    expect(sql).toContain("payload->>'id' = $3")
    expect(params).toEqual(['user-a', 'binding-a', 'pending-1'])
  })

  it('只能拒绝当前租户处于待确认状态的订单', async () => {
    mocks.queryOne.mockResolvedValue({ payload: pendingOrder() })

    const result = await rejectTenantPendingOrder('user-a', 'binding-a', 'pending-1')

    expect(result?.status).toBe('REJECTED_BY_USER')
    const [, params] = mocks.query.mock.calls[0]
    expect(params[0]).toBe('user-a')
    expect(params[1]).toBe('binding-a')
    expect(JSON.parse(params[3] as string)).toMatchObject({
      id: 'pending-1',
      status: 'REJECTED_BY_USER',
    })
  })

  it('批量过期只处理筛选命中的当前租户订单', async () => {
    mocks.query.mockResolvedValueOnce([
      { payload: pendingOrder('pending-a') },
      { payload: { ...pendingOrder('pending-b'), intent: { ...pendingOrder().intent, ticker: 'TSLA' } } },
    ])

    const result = await expireTenantPendingOrders(
      'user-a',
      'binding-a',
      { ticker: 'AAPL' },
    )

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('pending-a')
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })
})
