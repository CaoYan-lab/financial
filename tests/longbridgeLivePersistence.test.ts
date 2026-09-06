import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LiveCandidatePoolItem, LivePendingOrder, LiveSignalHistoryItem } from '../shared/types'

const dbPath = join('/tmp', `financial-longbridge-live-persistence-${process.pid}.sqlite3`)
process.env.LIVE_TRADING_HISTORY_DB_PATH = dbPath
process.env.LIVE_PERSIST_TEST = '1'

const { longbridgePersistence } = await import('../api/longbridge/longbridgePersistence')
const { livePersistence } = await import('../api/live/livePersistence')
const { loadLongbridgeCombinedOrderDetail } = await import('../api/longbridge/longbridgeLiveOrderService')

describe('Longbridge live SQLite persistence', () => {
  beforeEach(() => {
    longbridgePersistence.clearForTests()
    livePersistence.clearForTests()
  })

  it('历史策略信号写入 Longbridge 独立表，且不进入 Futu live_events', () => {
    const signal = testSignal('longbridge-signal-hold-1', 'HOLD')
    longbridgePersistence.appendSignal(signal)

    const longbridgePage = longbridgePersistence.paginateSignalLifecycle(1, 20)
    const futuPage = livePersistence.paginateSignalLifecycle(1, 20)

    expect(longbridgePage.total).toBe(1)
    expect(longbridgePage.items[0].id).toBe(signal.id)
    expect(futuPage.total).toBe(0)
    expect(sqlCount('longbridge_live_signals')).toBe(1)
    expect(sqlCount('live_events')).toBe(0)
  })

  it('待确认订单写入 Longbridge pending order 分表并支持 lifecycle 分页', () => {
    const order = testPendingOrder()
    longbridgePersistence.appendSignal(order.signal as LiveSignalHistoryItem)
    longbridgePersistence.appendPendingOrder(order)

    const page = longbridgePersistence.paginatePendingOrderLifecycle(1, 20, 'PENDING_CONFIRMATION')

    expect(page.total).toBe(1)
    expect(page.items[0].id).toBe(order.id)
    expect(page.items[0].status).toBe('PENDING_CONFIRMATION')
    expect(sqlCount('longbridge_live_pending_orders')).toBe(1)
  })

  it('候选池记录写入 Longbridge candidate pool 分表并按候选聚合读取', () => {
    const candidate = testCandidate()
    longbridgePersistence.appendCandidate(candidate)

    const page = longbridgePersistence.paginateCandidatePoolHistory(1, 20, 'ACTIVE')

    expect(page.total).toBe(1)
    expect(page.items[0].candidateId).toBe(candidate.candidateId)
    expect(page.items[0].status).toBe('ACTIVE')
    expect(sqlCount('longbridge_live_candidate_pool')).toBe(1)
  })

  it('组合详情可通过待确认订单号关联未生成券商订单的失败记录', async () => {
    const order = testPendingOrder()
    order.status = 'SUBMIT_FAILED'
    order.submittedOrder = {
      ok: false,
      orderId: 'blocked-by-longbridge-live-gate',
      ticker: order.intent.ticker,
      side: order.intent.side,
      quantity: String(order.intent.quantity),
      orderType: order.intent.orderType,
      orderSession: order.intent.orderSession,
      limitPrice: `$${order.intent.limitPrice.toFixed(2)}`,
      submittedAt: order.updatedAt,
      strategy: order.intent.strategy,
      signalId: order.intent.signalId,
      pendingOrderId: order.id,
      error: '测试提交失败',
    }
    longbridgePersistence.appendPendingOrder(order)

    const detail = await loadLongbridgeCombinedOrderDetail({
      orderId: order.submittedOrder.orderId,
      pendingOrderId: order.id,
    })

    expect(detail.ok).toBe(true)
    expect(detail.systemOrder?.id).toBe(order.id)
    expect(detail.brokerOrder).toBeUndefined()
    expect(detail.error).toBe('测试提交失败')
  })

  it('可通过券商订单号反查对应的系统待确认订单', () => {
    const order = testPendingOrder()
    order.status = 'SUBMITTED'
    order.submittedOrder = {
      ok: true,
      orderId: 'longbridge-broker-order-1',
      ticker: order.intent.ticker,
      side: order.intent.side,
      quantity: String(order.intent.quantity),
      orderType: order.intent.orderType,
      orderSession: order.intent.orderSession,
      limitPrice: `$${order.intent.limitPrice.toFixed(2)}`,
      submittedAt: order.updatedAt,
      strategy: order.intent.strategy,
      signalId: order.intent.signalId,
      pendingOrderId: order.id,
    }
    longbridgePersistence.appendPendingOrder(order)
    longbridgePersistence.appendSubmittedOrder(order.submittedOrder)

    expect(
      longbridgePersistence.findPendingOrderByBrokerOrderId(order.submittedOrder.orderId)?.id,
    ).toBe(order.id)
  })
})

function sqlCount(table: string) {
  const script = `import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
try:
    row = conn.execute("select count(*) from ${table}").fetchone()
    print(row[0])
except sqlite3.OperationalError:
    print(0)
`
  const result = spawnSync('python3', ['-c', script, dbPath], { encoding: 'utf8' })
  return Number(result.stdout.trim() || 0)
}

function testSignal(id: string, side: LiveSignalHistoryItem['side']): LiveSignalHistoryItem {
  return {
    id,
    ticker: 'AAPL',
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    side,
    confidence: 'medium',
    reason: 'test longbridge signal',
    price: '$100.00',
    quantity: side === 'HOLD' ? '-' : '1',
    limitPrice: side === 'HOLD' ? '-' : '$100.00',
    riskAssessment: 'test',
    generatedAt: new Date().toISOString(),
    dataWindow: '{}',
    source: 'longbridge-cli',
  }
}

function testPendingOrder(): LivePendingOrder {
  const now = new Date().toISOString()
  const signal = testSignal('longbridge-signal-buy-1', 'BUY')
  return {
    id: 'longbridge-pending-1',
    status: 'PENDING_CONFIRMATION',
    createdAt: now,
    updatedAt: now,
    intent: {
      ticker: 'AAPL',
      side: 'BUY',
      quantity: 1,
      orderType: 'LIMIT',
      orderSession: 'RTH',
      limitPrice: 100,
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      signalId: signal.id,
      reason: 'test pending',
      estimatedNotional: '$100.00',
      feeContext: {
        source: 'unavailable',
        currency: 'USD',
        feeAmount: null,
        feeDetails: [],
      },
    },
    signal,
    llmDecision: {
      ok: true,
      approved: true,
      action: 'BUY',
      ticker: 'AAPL',
      orderQuantity: 1,
      limitPrice: 100,
      confidence: 'medium',
      reason: 'test pending',
      riskAssessment: 'test',
      dataWindowUsed: {
        kline1mBars: 30,
        tickerPoints: 30,
        orderBookDepth: 5,
      },
    },
    riskWarnings: [],
    decisionMode: 'legacy_direct',
  }
}

function testCandidate(): LiveCandidatePoolItem & { signal: LiveSignalHistoryItem; decision: unknown; marketData: unknown } {
  const now = new Date().toISOString()
  return {
    candidateId: 'longbridge-candidate-1',
    ticker: 'AAPL',
    action: 'BUY',
    groupKey: 'AAPL:BUY',
    riskTags: ['test'],
    firstSeenAt: now,
    lastSeenAt: now,
    expiresAt: now,
    signalCount: 1,
    priceDriftPct: 0,
    proposedQuantity: 1,
    proposedNotional: 100,
    confidence: 'medium',
    status: 'ACTIVE',
    signal: testSignal('longbridge-signal-candidate-1', 'BUY'),
    decision: { action: 'BUY' },
    marketData: { source: 'longbridge-cli' },
  }
}
