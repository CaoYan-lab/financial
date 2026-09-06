import { beforeEach, describe, expect, it } from 'vitest'
import { longbridgeLiveTradingEngine } from '../api/longbridge/longbridgeLiveTradingEngine'
import { buildLongbridgeSdkOrderPayload } from '../api/longbridge/longbridgeLiveOrderService'
import { longbridgeOrderQueueService } from '../api/longbridge/longbridgeOrderQueueService'
import { longbridgeOpeningRiskRejectionReason } from '../api/longbridge/longbridgeRiskService'
import { updateTradeStrategyRuntimeConfig } from '../api/trade_strategy/tradeStrategyConfigService'
import type { LiveAccountDashboardResponse, LivePendingOrder, TradeStrategyConfig } from '../shared/types'

const runDryRun = process.env.RUN_LONGBRIDGE_DRY_RUN === '1' && process.env.RUN_LONGBRIDGE_INTEGRATION === '1' && process.env.RUN_LONGBRIDGE_LLM_INTEGRATION === '1' ? describe : describe.skip

describe('Longbridge order gate', () => {
  beforeEach(() => {
    longbridgeLiveTradingEngine.resetForTests()
    delete process.env.LONGBRIDGE_LIVE_TRADING_ENABLED
  })

  it('门禁关闭时确认接口不提交真实订单', async () => {
    const order = testPendingOrder()
    longbridgeOrderQueueService.createPendingOrder(order)

    const result = await longbridgeOrderQueueService.confirmPendingOrder(order.id)

    expect(result.ok).toBe(false)
    expect(result.blockedByGate).toBe(true)
    expect(result.error).toContain('LONGBRIDGE_LIVE_TRADING_ENABLED')
    expect(longbridgeOrderQueueService.findPendingOrder(order.id)?.status).toBe('PENDING_CONFIRMATION')
  })

  it('真实订单 adapter 生成 SDK 订单参数', () => {
    const order = testPendingOrder()
    const payload = buildLongbridgeSdkOrderPayload({
      pendingOrderId: order.id,
      confirmationId: 'longbridge-confirm-test',
      intent: order.intent,
    })

    expect(payload).toMatchObject({
      symbol: 'AAPL.US',
      side: 'BUY',
      quantity: 1,
      orderType: 'LO',
      limitPrice: 100,
      orderSession: 'RTH',
    })
    expect(payload.remark.length).toBeLessThanOrEqual(64)
  })

  it('待确认订单费用使用提交前估算而不是 unavailable', () => {
    const order = testPendingOrder()
    longbridgeOrderQueueService.createPendingOrder(order)

    const found = longbridgeOrderQueueService.findPendingOrder(order.id)

    expect(found?.intent.feeContext.source).toBe('estimated_pre_trade')
    expect(found?.intent.feeContext.feeAmount).toBeGreaterThan(0)
    expect(found?.intent.feeContext.currency).toBe('USD')
  })

  it('支持人工在确认弹窗中拒绝长桥待确认订单', () => {
    const order = testPendingOrder()
    longbridgeOrderQueueService.createPendingOrder(order)

    const rejected = longbridgeOrderQueueService.rejectPendingOrder(order.id)

    expect(rejected.ok).toBe(true)
    expect(rejected.order?.status).toBe('REJECTED_BY_USER')
    expect(rejected.order?.riskWarnings[0]).toContain('拒绝')
  })

  it('支持批量过期当前页长桥待确认订单', () => {
    const first = testPendingOrder('longbridge-test-pending-1')
    const second = testPendingOrder('longbridge-test-pending-2')
    longbridgeOrderQueueService.createPendingOrder(first)
    longbridgeOrderQueueService.createPendingOrder(second)

    const expired = longbridgeOrderQueueService.expirePendingOrders({ ids: [first.id] })

    expect(expired).toHaveLength(1)
    expect(expired[0].status).toBe('EXPIRED')
    expect(longbridgeOrderQueueService.findPendingOrder(first.id)?.status).toBe('EXPIRED')
    expect(longbridgeOrderQueueService.findPendingOrder(second.id)?.status).toBe('PENDING_CONFIRMATION')
  })

  it('开仓名义金额超过最大购买力时被长桥后端硬风控拦截', () => {
    const reason = longbridgeOpeningRiskRejectionReason(
      lowBuyingPowerAccount(),
      {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: 'TSLA',
        orderQuantity: 10,
        limitPrice: 407.77,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
      },
      407.77,
      testStrategy(),
    )

    expect(reason).toContain('最大购买力保护线')
    expect(reason).toContain('当前最大购买力 $2.30')
  })
})

runDryRun('Longbridge live trading dry-run integration', () => {
  beforeEach(() => {
    longbridgeLiveTradingEngine.resetForTests()
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
    delete process.env.LONGBRIDGE_LIVE_TRADING_ENABLED
  })

  it('组合策略开启时执行真实行情与真实 LLM dry-run，且不提交订单', async () => {
    const result = await longbridgeLiveTradingEngine.runOnceDryRun('AAPL.US')

    expect(result.marketData?.ok).toBe(true)
    expect(result.signal).toBeTruthy()
    expect(result.decision).toBeTruthy()
    expect(result.candidatePool.enabled).toBe(true)
    expect(result.pendingOrders.every((order) => order.intent.ticker === 'AAPL')).toBe(true)
    expect(process.env.LONGBRIDGE_LIVE_TRADING_ENABLED).not.toBe('true')
  }, 180_000)
})

function testPendingOrder(id = 'longbridge-test-pending-1'): LivePendingOrder {
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
      orderType: 'LIMIT',
      orderSession: 'RTH',
      limitPrice: 100,
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      signalId: 'longbridge-test-signal-1',
      reason: 'test gate',
      estimatedNotional: '$100.00',
      feeContext: {
        source: 'unavailable',
        currency: 'USD',
        feeAmount: null,
        feeDetails: [],
      },
    },
    signal: {
      id: 'longbridge-test-signal-1',
      ticker: 'AAPL',
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      side: 'BUY',
      confidence: 'medium',
      reason: 'test gate',
      price: '$100.00',
      quantity: '1',
      limitPrice: '$100.00',
      riskAssessment: 'test',
      generatedAt: now,
      dataWindow: '{}',
      source: 'longbridge-cli',
    },
    llmDecision: {
      ok: true,
      approved: true,
      action: 'BUY',
      ticker: 'AAPL',
      orderQuantity: 1,
      limitPrice: 100,
      confidence: 'medium',
      reason: 'test gate',
      riskAssessment: 'test',
      dataWindowUsed: {
        kline1mBars: 30,
        tickerPoints: 30,
        orderBookDepth: 5,
      },
    },
    riskWarnings: [],
    decisionMode: 'candidate_pool',
  }
}

function lowBuyingPowerAccount(): LiveAccountDashboardResponse {
  return {
    ok: true,
    selectedAccountId: 'longbridge-real',
    summary: {
      accountId: 'longbridge-real',
      currency: 'USD',
      totalAssets: '$2.30',
      cash: '$2.30',
      availableFunds: '$2.30',
      buyingPower: '$2.30',
      tradingCurrency: 'USD',
      totalAssetsInTradingCurrency: '$2.30',
      cashInTradingCurrency: '$2.30',
      availableFundsInTradingCurrency: '$2.30',
      buyingPowerInTradingCurrency: '$2.30',
      dailyPnL: '$0.00',
      totalPnL: '$0.00',
    },
    positions: [],
    risk: { concentrationRisk: 'test', largestPosition: 'none', cashRatio: '100%', top30Overlap: 'test', warnings: [] },
    trading: { environment: 'REAL', liveTradingEnabled: false, requiresConfirmation: true, warning: 'dry-run' },
    missingCapabilities: [],
    warnings: [],
  }
}

function testStrategy(): TradeStrategyConfig {
  return {
    id: 'test_strategy',
    version: 1,
    label: 'test',
    summary: 'test',
    enabledFor: ['live'],
    riskControls: {
      buyingPowerProtection: { mode: 'hard_block', maxPctBuyingPower: 0.95 },
      feeDrag: { mode: 'off', maxRoundTripFeePctNotional: 0.02 },
    },
  }
}
