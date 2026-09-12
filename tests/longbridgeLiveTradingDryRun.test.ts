import { beforeEach, describe, expect, it } from 'vitest'
import { longbridgeLiveTradingEngine, longbridgeSignalLifecycle } from '../api/longbridge/longbridgeLiveTradingEngine'
import {
  buildLongbridgeSdkOrderPayload,
  formatLongbridgeSubmittedPrice,
  normalizeLongbridgeLimitPrice,
} from '../api/longbridge/longbridgeLiveOrderService'
import { buildLongbridgeLiveDecisionPrompt } from '../api/longbridge/longbridgeLiveDecisionService'
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

  it('美股限价提交前按最小报价单位归一化', () => {
    expect(normalizeLongbridgeLimitPrice('MU.US', 982.369, 'BUY')).toBe(982.36)
    expect(normalizeLongbridgeLimitPrice('MU.US', 982.361, 'SELL')).toBe(982.37)
    expect(normalizeLongbridgeLimitPrice('MULL', 21.911, 'BUY')).toBe(21.91)
    expect(normalizeLongbridgeLimitPrice('PENNY.US', 0.98765, 'BUY')).toBe(0.9876)
    expect(normalizeLongbridgeLimitPrice('PENNY.US', 0.98761, 'SELL')).toBe(0.9877)
  })

  it('港股价格不套用美股报价精度', () => {
    expect(normalizeLongbridgeLimitPrice('09660', 19.123, 'BUY')).toBe(19.123)
  })

  it('订单审计价格保留实际报单精度和币种', () => {
    expect(formatLongbridgeSubmittedPrice('PENNY.US', 0.9876)).toBe('$0.9876')
    expect(formatLongbridgeSubmittedPrice('09660', 19.123)).toBe('HK$19.123')
  })

  it('真实订单 adapter 会归一化美股限价', () => {
    const order = testPendingOrder()
    order.intent.ticker = 'MU'
    order.intent.limitPrice = 982.369

    const payload = buildLongbridgeSdkOrderPayload({
      pendingOrderId: order.id,
      confirmationId: 'longbridge-confirm-test',
      intent: order.intent,
    })

    expect(payload.limitPrice).toBe(982.36)
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

  it('港股开仓数量不满足真实每手股数时被后端硬风控拦截', () => {
    const reason = longbridgeOpeningRiskRejectionReason(
      lowBuyingPowerAccount(),
      {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: '09660',
        orderQuantity: 100,
        limitPrice: 15,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
      },
      15,
      testStrategy(),
      '9660.HK',
      600,
    )

    expect(reason).toContain('每手 600 股')
  })

  it('港股名义金额与港币购买力按同一币种比较', () => {
    const account = lowBuyingPowerAccount()
    account.summary = {
      ...account.summary,
      currency: 'HKD',
      tradingCurrency: 'HKD',
      totalAssets: 'HK$10,126.39',
      buyingPower: 'HK$10,126.39',
      totalAssetsInTradingCurrency: 'HK$10,126.39',
      buyingPowerInTradingCurrency: 'HK$10,126.39',
    }
    const reason = longbridgeOpeningRiskRejectionReason(
      account,
      {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: '07747',
        orderQuantity: 100,
        limitPrice: 82.54,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
      },
      82.54,
      testStrategy(),
      '7747.HK',
      100,
    )

    expect(reason).toBeUndefined()
  })

  it('负现金保护开启时拒绝新增多头和新增空头', () => {
    const account = lowBuyingPowerAccount()
    account.summary.availableFunds = '$-100.00'
    account.summary.availableFundsInTradingCurrency = '$-100.00'
    account.summary.buyingPower = '$2,000.00'
    account.summary.buyingPowerInTradingCurrency = '$2,000.00'
    const openingDecision = {
      ok: true,
      approved: true,
      action: 'BUY' as const,
      ticker: 'AAPL',
      orderQuantity: 1,
      limitPrice: 100,
      confidence: 'medium',
      reason: 'test',
      riskAssessment: 'test',
      dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
    }

    expect(longbridgeOpeningRiskRejectionReason(
      account,
      openingDecision,
      100,
      testStrategy(),
      'AAPL.US',
      1,
      { blockOpeningWhenCashNegative: true },
    )).toContain('负现金开仓保护已拦截')
    expect(longbridgeOpeningRiskRejectionReason(
      account,
      { ...openingDecision, action: 'SELL_SHORT' },
      100,
      testStrategy(),
      'AAPL.US',
      1,
      { blockOpeningWhenCashNegative: true },
    )).toContain('负现金开仓保护已拦截')
  })

  it('融资风险达到预警时即使购买力为正也拒绝新增开仓', () => {
    const account = lowBuyingPowerAccount()
    account.summary.totalAssets = '$10,000.00'
    account.summary.totalAssetsInTradingCurrency = '$10,000.00'
    account.summary.buyingPower = '$3,000.00'
    account.summary.buyingPowerInTradingCurrency = '$3,000.00'
    account.summary.financingRiskLevel = 2
    account.summary.financingRiskLabel = '预警'
    account.summary.financingOpeningRestricted = true
    account.summary.initialMargin = '$10,500.00'
    account.summary.maintenanceMargin = '$9,000.00'
    account.summary.marginCall = '$0.00'

    const reason = longbridgeOpeningRiskRejectionReason(
      account,
      {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: 'AAPL',
        orderQuantity: 1,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
      },
      100,
      testStrategy(),
      'AAPL.US',
      1,
    )

    expect(reason).toContain('融资风险开仓保护已拦截')
    expect(reason).toContain('账户风险等级为 预警')
  })

  it('融资风险预警时仍允许纯平仓', () => {
    const account = lowBuyingPowerAccount()
    account.summary.financingRiskLevel = 3
    account.summary.financingRiskLabel = '危险'
    account.summary.financingOpeningRestricted = true
    account.positions = [{
      ticker: 'AAPL',
      name: 'Apple',
      quantity: '2',
      marketValue: '$200.00',
      averageCost: '$90.00',
      currentPrice: '$100.00',
      todayPnL: '$0.00',
      unrealizedPnL: '$20.00',
      pnlRatio: '10%',
      positionRatio: '1%',
      currency: 'USD',
    }]

    expect(longbridgeOpeningRiskRejectionReason(
      account,
      {
        ok: true,
        approved: true,
        action: 'SELL_TO_CLOSE',
        ticker: 'AAPL',
        orderQuantity: 1,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
      },
      100,
      testStrategy(),
      'AAPL.US',
      1,
    )).toBeUndefined()
  })

  it('账户快照失败或融资风险等级未知时禁止新增开仓', () => {
    const account = lowBuyingPowerAccount()
    account.summary.totalAssets = '$10,000.00'
    account.summary.totalAssetsInTradingCurrency = '$10,000.00'
    account.summary.buyingPower = '$3,000.00'
    account.summary.buyingPowerInTradingCurrency = '$3,000.00'
    const decision = {
      action: 'BUY' as const,
      ticker: 'AAPL',
      orderQuantity: 1,
    }

    account.ok = false
    expect(longbridgeOpeningRiskRejectionReason(
      account,
      decision,
      100,
      testStrategy(),
      'AAPL.US',
      1,
    )).toContain('账户快照读取失败')

    account.ok = true
    account.summary.financingRiskLevel = undefined
    expect(longbridgeOpeningRiskRejectionReason(
      account,
      decision,
      100,
      testStrategy(),
      'AAPL.US',
      1,
    )).toContain('融资风险等级不可用')
  })

  it('拒绝超量平仓和超量回补，防止仓位反向翻转', () => {
    const account = lowBuyingPowerAccount()
    account.summary.totalAssets = '$10,000.00'
    account.summary.totalAssetsInTradingCurrency = '$10,000.00'
    account.summary.buyingPower = '$3,000.00'
    account.summary.buyingPowerInTradingCurrency = '$3,000.00'
    account.positions = [{
      ticker: 'AAPL',
      name: 'Apple',
      quantity: '2',
      marketValue: '$200.00',
      averageCost: '$90.00',
      currentPrice: '$100.00',
      todayPnL: '$0.00',
      unrealizedPnL: '$20.00',
      pnlRatio: '10%',
      positionRatio: '1%',
      currency: 'USD',
    }]

    expect(longbridgeOpeningRiskRejectionReason(
      account,
      { action: 'SELL_TO_CLOSE', ticker: 'AAPL', orderQuantity: 3 },
      100,
      testStrategy(),
      'AAPL.US',
      1,
    )).toContain('超过多头持仓')

    account.positions[0].quantity = '-2'
    expect(longbridgeOpeningRiskRejectionReason(
      account,
      { action: 'BUY', ticker: 'AAPL', orderQuantity: 3 },
      100,
      testStrategy(),
      'AAPL.US',
      1,
    )).toContain('超过空头持仓')
  })

  it('负现金保护开启时允许纯平仓', () => {
    const account = lowBuyingPowerAccount()
    account.summary.availableFunds = '$-100.00'
    account.summary.availableFundsInTradingCurrency = '$-100.00'
    account.summary.buyingPower = '$2,000.00'
    account.summary.buyingPowerInTradingCurrency = '$2,000.00'
    account.positions = [{
      ticker: 'AAPL',
      name: 'Apple',
      quantity: '2',
      marketValue: '$200.00',
      averageCost: '$90.00',
      currentPrice: '$100.00',
      todayPnL: '$0.00',
      unrealizedPnL: '$20.00',
      pnlRatio: '10%',
      positionRatio: '1%',
      currency: 'USD',
    }]
    const reason = longbridgeOpeningRiskRejectionReason(
      account,
      {
        ok: true,
        approved: true,
        action: 'SELL_TO_CLOSE',
        ticker: 'AAPL',
        orderQuantity: 1,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
      },
      100,
      testStrategy(),
      'AAPL.US',
      1,
      { blockOpeningWhenCashNegative: true },
    )

    expect(reason).toBeUndefined()
  })

  it('负现金保护开启时允许回补空头但拒绝买超为空头转多', () => {
    const account = lowBuyingPowerAccount()
    account.summary.availableFunds = '$-100.00'
    account.summary.availableFundsInTradingCurrency = '$-100.00'
    account.summary.buyingPower = '$2,000.00'
    account.summary.buyingPowerInTradingCurrency = '$2,000.00'
    account.positions = [{
      ticker: 'AAPL',
      name: 'Apple',
      quantity: '-2',
      marketValue: '$-200.00',
      averageCost: '$110.00',
      currentPrice: '$100.00',
      todayPnL: '$0.00',
      unrealizedPnL: '$20.00',
      pnlRatio: '9%',
      positionRatio: '-1%',
      currency: 'USD',
    }]
    const decision = {
      ok: true,
      approved: true,
      action: 'BUY' as const,
      ticker: 'AAPL',
      orderQuantity: 2,
      limitPrice: 100,
      confidence: 'medium',
      reason: 'test',
      riskAssessment: 'test',
      dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
    }

    expect(longbridgeOpeningRiskRejectionReason(
      account,
      decision,
      100,
      testStrategy(),
      'AAPL.US',
      1,
      { blockOpeningWhenCashNegative: true },
    )).toBeUndefined()
    expect(longbridgeOpeningRiskRejectionReason(
      account,
      { ...decision, orderQuantity: 3 },
      100,
      testStrategy(),
      'AAPL.US',
      1,
      { blockOpeningWhenCashNegative: true },
    )).toContain('禁止超量买入反向开多')
  })

  it('负现金保护关闭时保留原有购买力规则', () => {
    const account = lowBuyingPowerAccount()
    account.summary.availableFunds = '$-100.00'
    account.summary.availableFundsInTradingCurrency = '$-100.00'
    account.summary.buyingPower = '$2,000.00'
    account.summary.buyingPowerInTradingCurrency = '$2,000.00'
    const reason = longbridgeOpeningRiskRejectionReason(
      account,
      {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: 'AAPL',
        orderQuantity: 1,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 30, tickerPoints: 30, orderBookDepth: 5 },
      },
      100,
      testStrategy(),
      'AAPL.US',
      1,
      { blockOpeningWhenCashNegative: false },
    )

    expect(reason).toBeUndefined()
  })

  it('负现金保护开启时提示模型只允许平仓', () => {
    const account = lowBuyingPowerAccount()
    account.summary.availableFunds = '$-100.00'
    account.summary.availableFundsInTradingCurrency = '$-100.00'
    const prompt = buildLongbridgeLiveDecisionPrompt({
      symbol: 'AAPL.US',
      account,
      marketData: {
        ok: true,
        ticker: 'AAPL',
        symbol: 'AAPL.US',
        source: 'longbridge-sdk-cache',
        lastPrice: 100,
        bars: [],
        tickerPoints: [],
        asks: [],
        bids: [],
        lotSize: 1,
        marketState: 'RTH',
        updatedAt: '2026-09-11T15:00:00.000Z',
        warnings: [],
      },
      dataWindow: {
        kline1mBars: 30,
        tickerPoints: 30,
        orderBookDepth: 5,
        pollIntervalSeconds: 60,
        reason: 'test',
        source: 'fallback',
      },
      blockOpeningWhenCashNegative: true,
    })
    const payload = JSON.parse(prompt[1].content)

    expect(payload.account.blockOpeningWhenCashNegative).toBe(true)
    expect(payload.account.orderSizingConstraint).toContain('只允许 SELL_TO_CLOSE')
  })

  it('直推和组合策略使用各自的信号生命周期状态', () => {
    expect(longbridgeSignalLifecycle('legacy_direct', 'BUY')).toMatchObject({
      lifecycleStatus: 'PENDING_CONFIRMATION',
    })
    expect(longbridgeSignalLifecycle('candidate_pool', 'BUY')).toMatchObject({
      lifecycleStatus: 'CANDIDATE_POOL',
    })
    expect(longbridgeSignalLifecycle('legacy_direct', 'BUY', '测试风控拦截')).toEqual({
      lifecycleStatus: 'BLOCKED_BY_RISK',
      lifecycleReason: '测试风控拦截',
    })
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
      financingRiskLevel: 0,
      financingRiskLabel: '安全',
      financingOpeningRestricted: false,
      initialMargin: '$0.00',
      maintenanceMargin: '$0.00',
      marginCall: '$0.00',
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
