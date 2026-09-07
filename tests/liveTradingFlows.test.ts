import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveAccountDashboardResponse, LiveOrderIntent, MarketSessionStatus } from '../shared/types'

process.env.SIMULATION_HISTORY_DB_PATH = `/tmp/financial-live-flow-test-${process.pid}.sqlite3`
process.env.LIVE_TRADING_HISTORY_DB_PATH = `/tmp/financial-live-flow-test-${process.pid}.live.sqlite3`
process.env.LIVE_PERSIST_TEST = '1'

vi.mock('../api/live/liveAccountService.js', () => ({
  loadLiveAccountDashboard: vi.fn(async () => account()),
  parseMoney: (value: string | undefined) => {
    if (!value) return undefined
    const parsed = Number(value.replace(/[$,%]/g, '').replaceAll(',', ''))
    return Number.isFinite(parsed) ? parsed : undefined
  },
}))

vi.mock('../api/simulation/marketSessionService.js', () => ({
  attachMarketSessions: (items: unknown[]) => items,
  latestMarketSessions: () => ({}),
  loadMarketSessions: vi.fn(async (tickers: string[]) =>
    Object.fromEntries(tickers.map((ticker) => [ticker.toUpperCase(), marketSession()])),
  ),
}))

vi.mock('../api/simulation/realtimeDataAdapter.js', () => ({
  loadStrategyMarketData: vi.fn((ticker: string) => {
    if (ticker.toUpperCase() !== 'AMD') return { ok: false, ticker, reason: 'test only AMD has market data' }
    return {
      ok: true,
      ticker: 'AMD',
      lastPrice: 100,
      bars: Array.from({ length: 120 }, (_, index) => ({ time: `2026-06-19 10:${String(index % 60).padStart(2, '0')}:00`, open: 100, high: 101, low: 99, close: 100 })),
      tickerPoints: Array.from({ length: 240 }, (_, index) => ({ time: `2026-06-19 10:${String(index % 60).padStart(2, '0')}:00`, price: 100 })),
      asks: [{ price: '$100.01', size: '100', depth: 1 }],
      bids: [{ price: '$99.99', size: '100', depth: 1 }],
      bestAsk: 100.01,
      bestBid: 99.99,
      marketState: 'PRE_MARKET_BEGIN',
      updatedAt: '2026-06-19T10:00:00.000Z',
    }
  }),
}))

vi.mock('../api/simulation/trendContextService.js', () => ({
  loadTrendContext: vi.fn(async () => ({
    window: { available: true, lookbackTradingDays: 7, barInterval: '30m' },
    trendDirection: 'UP',
    trendStrength: 'MEDIUM',
    pricePositionInRange: 'MID',
    summary: 'test trend',
  })),
}))

vi.mock('../api/live/liveTradingDecisionService.js', () => ({
  requestLiveTradingDecision: vi.fn(async () => ({
    ok: true,
    approved: true,
    action: 'BUY',
    ticker: 'AMD',
    orderQuantity: 100,
    limitPrice: 100,
    confidence: 'medium',
    reason: 'test BUY signal',
    riskAssessment: 'test risk',
    dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
    rawText: '{}',
  })),
}))

vi.mock('../api/live/futuLiveOrderService.js', () => ({
  loadFutuLiveOrders: vi.fn(async () => ({ ok: true, orders: [], page: 1, pageSize: 12, total: 0, totalPages: 1, warnings: [] })),
  submitLiveOrder: vi.fn(async (_accountId: string, pendingOrderId: string, confirmationId: string, intent: LiveOrderIntent) => ({
    ok: true,
    orderId: `futu-order-${pendingOrderId}`,
    ticker: intent.ticker,
    side: intent.side,
    quantity: String(intent.quantity),
    orderType: intent.orderType,
    orderSession: intent.orderSession,
    limitPrice: `$${intent.limitPrice.toFixed(2)}`,
    submittedAt: new Date().toISOString(),
    strategy: intent.strategy,
    signalId: intent.signalId,
    pendingOrderId,
    confirmationId,
    feeContext: intent.feeContext,
  })),
}))

vi.mock('../api/live/livePortfolioReviewDecisionService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/live/livePortfolioReviewDecisionService')>()
  return {
    ...actual,
    requestLivePortfolioReviewDecision: vi.fn(async (input) => {
      const candidate = input.candidates[0]
      return {
        ok: true,
        portfolioDecisionId: 'portfolio-review-test',
        promptVersion: 'live_portfolio_candidate_review_v1',
        promotedCandidates: candidate ? [{ candidateId: candidate.candidateId, rank: 1, reason: 'test promote candidate' }] : [],
        watchedCandidates: [],
        suppressedCandidates: [],
        expiredCandidates: [],
        portfolioRationale: 'test portfolio rationale',
        rawText: '{}',
      }
    }),
  }
})

const { liveTradingEngine } = await import('../api/live/liveTradingEngine')
const { liveOrderQueueService } = await import('../api/live/liveOrderQueueService')
const { liveCandidatePoolService } = await import('../api/live/liveCandidatePoolService')
const { livePersistence } = await import('../api/live/livePersistence')
const { requestLivePortfolioReviewDecision } = await import('../api/live/livePortfolioReviewDecisionService')
const { submitLiveOrder } = await import('../api/live/futuLiveOrderService')
const { updateFutuLiveSettings } = await import('../api/live/liveSettings')
const { resetManagedOrderStoreForTests } = await import('../api/cloud/state/managedOrderStore')
const { resetTradeStrategyConfigCacheForTests, updateTradeStrategyRuntimeConfig } = await import('../api/trade_strategy/tradeStrategyConfigService')

describe('live trading execution modes', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    liveOrderQueueService.resetForTests()
    liveCandidatePoolService.resetForTests()
    livePersistence.clearForTests()
    resetManagedOrderStoreForTests()
    resetTradeStrategyConfigCacheForTests()
    await updateFutuLiveSettings({ autoSubmitEnabled: false })
    delete process.env.LIVE_TRADING_ENABLED
    delete process.env.FUTU_LIVE_TRD_ENV
  })

  it('老逻辑直推：非 HOLD 信号通过硬风控后直接进入待确认队列，不写入候选池', async () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'legacy_direct' })

    const dashboard = await liveTradingEngine.runOnce()
    const pendingOrders = liveOrderQueueService.activePendingOrders()

    expect(dashboard.candidatePool.enabled).toBe(false)
    expect(dashboard.candidatePool.candidates).toHaveLength(0)
    expect(pendingOrders).toHaveLength(1)
    expect(pendingOrders[0].intent.ticker).toBe('AMD')
    expect(pendingOrders[0].intent.side).toBe('BUY')
    expect(pendingOrders[0].decisionMode).toBe('legacy_direct')
    expect(pendingOrders[0].candidateId).toBeUndefined()
  })

  it('老逻辑直推：同标的同方向仍保留 15 分钟待确认订单去重', async () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'legacy_direct' })

    await liveTradingEngine.runOnce()
    await liveTradingEngine.runOnce()
    const pendingOrders = liveOrderQueueService.activePendingOrders()

    expect(pendingOrders).toHaveLength(1)
    expect(pendingOrders[0].decisionMode).toBe('legacy_direct')
    expect(liveOrderQueueService.skippedTickers().some((item) => item.reason.includes('15 分钟去重窗口'))).toBe(true)
  })

  it('待确认订单：批量过期只关闭待确认订单，并释放后续同向新单生成', async () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'legacy_direct' })

    await liveTradingEngine.runOnce()
    const expired = liveOrderQueueService.expirePendingOrders({ ticker: 'AMD', side: 'BUY' })

    expect(expired).toHaveLength(1)
    expect(expired[0].status).toBe('EXPIRED')
    expect(liveOrderQueueService.activePendingOrders()).toHaveLength(0)

    await liveTradingEngine.runOnce()
    const pendingOrders = liveOrderQueueService.activePendingOrders()
    expect(pendingOrders).toHaveLength(1)
    expect(pendingOrders[0].status).toBe('PENDING_CONFIRMATION')
  })

  it('Futu 自动下单开启且真实门禁开启时，生成待确认订单后自动提交', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true'
    process.env.FUTU_LIVE_TRD_ENV = 'REAL'
    await updateFutuLiveSettings({ autoSubmitEnabled: true })
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'legacy_direct' })

    const dashboard = await liveTradingEngine.runOnce()

    expect(vi.mocked(submitLiveOrder)).toHaveBeenCalledTimes(1)
    expect(liveOrderQueueService.activePendingOrders()).toHaveLength(0)
    expect(liveOrderQueueService.latestSubmittedOrders()).toHaveLength(1)
    expect(dashboard.engine.pendingOrderCount).toBe(0)
  })

  it('组合策略：非 HOLD 信号先进入候选池，组合裁决推进后才进入待确认队列', async () => {
    updateTradeStrategyRuntimeConfig('live', {
      executionMode: 'candidate_pool',
      portfolioTimingPresetId: 'deepseek_aggressive_v1',
    })

    const dashboard = await liveTradingEngine.runOnce()
    const pendingOrders = liveOrderQueueService.activePendingOrders()

    expect(dashboard.candidatePool.enabled).toBe(true)
    expect(dashboard.candidatePool.presetId).toBe('deepseek_aggressive_v1')
    expect(dashboard.candidatePool.candidates).toHaveLength(1)
    expect(dashboard.candidatePool.candidates[0].status).toBe('PROMOTED')
    expect(pendingOrders).toHaveLength(1)
    expect(pendingOrders[0].decisionMode).toBe('candidate_pool')
    expect(pendingOrders[0].candidateId).toBe(dashboard.candidatePool.candidates[0].candidateId)
    expect(pendingOrders[0].portfolioDecisionId).toBe('portfolio-review-test')
    expect(pendingOrders[0].portfolioDecisionReason).toBe('test promote candidate')
    expect(pendingOrders[0].riskWarnings[0]).toContain('组合策略候选池来源')
  })

  it('组合策略：大模型连续裁决推进同标的同方向候选时允许生成多笔待确认订单', async () => {
    updateTradeStrategyRuntimeConfig('live', {
      executionMode: 'candidate_pool',
      portfolioTimingPresetId: 'deepseek_aggressive_v1',
    })

    await liveTradingEngine.runOnce()
    await liveTradingEngine.runOnce()
    const pendingOrders = liveOrderQueueService.activePendingOrders()

    expect(pendingOrders).toHaveLength(2)
    expect(pendingOrders.every((order) => order.decisionMode === 'candidate_pool')).toBe(true)
    expect(new Set(pendingOrders.map((order) => order.candidateId))).toHaveLength(1)
    expect(vi.mocked(requestLivePortfolioReviewDecision).mock.calls.at(-1)?.[0].pendingOrders).toHaveLength(1)
    expect(vi.mocked(requestLivePortfolioReviewDecision).mock.calls.at(-1)?.[0].constraints.sameGroupMutualExclusion).toBe(false)
    expect(liveOrderQueueService.skippedTickers().some((item) => item.reason.includes('15 分钟去重窗口'))).toBe(false)
  })

  it('组合策略：组合裁决暂缓的候选仍保留在候选池面板中', async () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
    liveCandidatePoolService.upsert({
      signal: {
        id: 'signal-suppressed-buy',
        ticker: 'AMD',
        side: 'BUY',
        strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
        price: 100,
        generatedAt: '2026-06-19T10:00:00.000Z',
        reason: 'test suppressed candidate',
        source: 'live',
      },
      decision: {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: 'AMD',
        orderQuantity: 100,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test suppressed candidate',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
        rawText: '{}',
      },
      marketData: {
        ok: true,
        ticker: 'AMD',
        lastPrice: 100,
        bars: [],
        tickerPoints: [],
        asks: [],
        bids: [],
        bestAsk: 100.01,
        bestBid: 99.99,
        marketState: 'PRE_MARKET_BEGIN',
        updatedAt: '2026-06-19T10:00:00.000Z',
      },
    })

    liveCandidatePoolService.applyReview({
      ok: true,
      portfolioDecisionId: 'portfolio-review-suppressed-test',
      promptVersion: 'live_portfolio_candidate_review_v1',
      promotedCandidates: [],
      watchedCandidates: [],
      suppressedCandidates: [{ candidateId: liveCandidatePoolService.visibleCandidates()[0].candidateId, reason: 'test suppress' }],
      expiredCandidates: [],
      portfolioRationale: 'test',
      rawText: '{}',
    })

    const snapshot = liveCandidatePoolService.snapshot('candidate_pool')
    expect(snapshot.candidates).toHaveLength(1)
    expect(snapshot.candidates[0].status).toBe('SUPPRESSED')
    expect(liveCandidatePoolService.reviewCandidates()).toHaveLength(0)
  })

  it('组合策略：港股 07709 归入海力士高波动组，不归入 TSM 组', () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
    liveCandidatePoolService.upsert({
      signal: {
        id: 'signal-07709-buy',
        ticker: '07709',
        side: 'BUY',
        strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
        price: 1610,
        generatedAt: '2026-06-19T10:00:00.000Z',
        reason: 'test 07709 candidate',
        source: 'live',
      },
      decision: {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: '07709',
        orderQuantity: 10,
        limitPrice: 1610,
        confidence: 'medium',
        reason: 'test 07709 candidate',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
        rawText: '{}',
      },
      marketData: {
        ok: true,
        ticker: '07709',
        lastPrice: 1610,
        bars: [],
        tickerPoints: [],
        asks: [],
        bids: [],
        bestAsk: 1611,
        bestBid: 1609,
        marketState: 'PRE_MARKET_BEGIN',
        updatedAt: '2026-06-19T10:00:00.000Z',
      },
    })

    const [candidate] = liveCandidatePoolService.snapshot('candidate_pool').candidates
    expect(candidate.groupKey).toBe('SK_HYNIX_LONG_BETA')
    expect(candidate.riskTags).toContain('LEVERAGED_2X_ETF')
  })

  it('组合策略：NVDA 正股归入 direct，NVDL 杠杆 ETF 才归入英伟达高波动组', () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
    for (const ticker of ['NVDA', 'NVDL']) {
      liveCandidatePoolService.upsert({
        signal: {
          id: `signal-${ticker}-buy`,
          ticker,
          side: 'BUY',
          strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
          price: 100,
          generatedAt: '2026-06-19T10:00:00.000Z',
          reason: `test ${ticker} candidate`,
          source: 'live',
        },
        decision: {
          ok: true,
          approved: true,
          action: 'BUY',
          ticker,
          orderQuantity: 10,
          limitPrice: 100,
          confidence: 'medium',
          reason: `test ${ticker} candidate`,
          riskAssessment: 'test',
          dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
          rawText: '{}',
        },
        marketData: {
          ok: true,
          ticker,
          lastPrice: 100,
          bars: [],
          tickerPoints: [],
          asks: [],
          bids: [],
          bestAsk: 101,
          bestBid: 99,
          marketState: 'PRE_MARKET_BEGIN',
          updatedAt: '2026-06-19T10:00:00.000Z',
        },
      })
    }

    const candidates = liveCandidatePoolService.snapshot('candidate_pool').candidates
    expect(candidates.find((candidate) => candidate.ticker === 'NVDA')?.groupKey).toBe('NVDA_DIRECT')
    expect(candidates.find((candidate) => candidate.ticker === 'NVDA')?.riskTags).not.toContain('HIGH_BETA_TECH')
    expect(candidates.find((candidate) => candidate.ticker === 'NVDL')?.groupKey).toBe('NVDA_LONG_BETA')
    expect(candidates.find((candidate) => candidate.ticker === 'NVDL')?.riskTags).toContain('HIGH_BETA_TECH')
  })

  it('组合策略：候选池候选持久化后可在服务重启式恢复中保留', async () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
    const candidate = liveCandidatePoolService.upsert({
      signal: {
        id: 'signal-persisted-buy',
        ticker: 'AMD',
        side: 'BUY',
        strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
        price: 100,
        generatedAt: '2026-06-19T10:00:00.000Z',
        reason: 'test persisted candidate',
        source: 'live',
      },
      decision: {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: 'AMD',
        orderQuantity: 100,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test persisted candidate',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
        rawText: '{}',
      },
      marketData: {
        ok: true,
        ticker: 'AMD',
        lastPrice: 100,
        bars: [],
        tickerPoints: [],
        asks: [],
        bids: [],
        bestAsk: 100.01,
        bestBid: 99.99,
        marketState: 'PRE_MARKET_BEGIN',
        updatedAt: '2026-06-19T10:00:00.000Z',
      },
    })

    liveCandidatePoolService.resetForTests({ hydrateFromPersistence: true })
    const snapshot = liveCandidatePoolService.snapshot('candidate_pool')
    expect(snapshot.candidates).toHaveLength(1)
    expect(snapshot.candidates[0].candidateId).toBe(candidate.candidateId)
    expect(snapshot.candidates[0].ticker).toBe('AMD')
    expect(snapshot.candidates[0].status).toBe('ACTIVE')
    expect(liveCandidatePoolService.findBySignalId('signal-persisted-buy')?.candidateId).toBe(candidate.candidateId)
  })

  it('组合策略切回老逻辑后，候选池已有候选立即禁用且切回组合策略后不再恢复参与', async () => {
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
    liveCandidatePoolService.upsert({
      signal: {
        id: 'signal-disabled-by-mode-switch',
        ticker: 'AMD',
        side: 'BUY',
        strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
        price: 100,
        generatedAt: '2026-06-19T10:00:00.000Z',
        reason: 'test mode switch candidate',
        source: 'live',
      },
      decision: {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: 'AMD',
        orderQuantity: 100,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test mode switch candidate',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
        rawText: '{}',
      },
      marketData: {
        ok: true,
        ticker: 'AMD',
        lastPrice: 100,
        bars: [],
        tickerPoints: [],
        asks: [],
        bids: [],
        bestAsk: 100.01,
        bestBid: 99.99,
        marketState: 'PRE_MARKET_BEGIN',
        updatedAt: '2026-06-19T10:00:00.000Z',
      },
    })

    expect(liveCandidatePoolService.snapshot('candidate_pool').candidates).toHaveLength(1)
    updateTradeStrategyRuntimeConfig('live', { executionMode: 'legacy_direct' })
    liveCandidatePoolService.disableForModeSwitch()
    expect(liveCandidatePoolService.snapshot('legacy_direct').candidates).toHaveLength(0)

    updateTradeStrategyRuntimeConfig('live', { executionMode: 'candidate_pool' })
    liveCandidatePoolService.resetForTests({ hydrateFromPersistence: true })
    expect(liveCandidatePoolService.snapshot('candidate_pool').candidates).toHaveLength(0)
    expect(liveCandidatePoolService.reviewCandidates()).toHaveLength(0)
  })
})

function account(): LiveAccountDashboardResponse {
  return {
    ok: true,
    selectedAccountId: 'test-live-account',
    summary: {
      accountId: 'test-live-account',
      currency: 'USD',
      totalAssets: '$100,000.00',
      cash: '$50,000.00',
      availableFunds: '$50,000.00',
      buyingPower: '$50,000.00',
      tradingCurrency: 'USD',
      totalAssetsInTradingCurrency: '$100,000.00',
      cashInTradingCurrency: '$50,000.00',
      availableFundsInTradingCurrency: '$50,000.00',
      buyingPowerInTradingCurrency: '$50,000.00',
      dailyPnL: '$0.00',
      totalPnL: '$0.00',
      source: { source: 'test', accessedAt: '2026-06-19T10:00:00.000Z', timestamp: '2026-06-19T10:00:00.000Z' },
    },
    positions: [],
    risk: {
      concentrationRisk: 'unavailable',
      largestPosition: 'none',
      cashRatio: 'unavailable',
      top30Overlap: 'unavailable',
      warnings: [],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: 'test',
    },
    missingCapabilities: [],
    warnings: [],
  }
}

function marketSession(): MarketSessionStatus {
  return {
    state: 'PRE_MARKET_BEGIN',
    labelZh: '盘前',
    labelEn: 'Pre-market',
    tradable: true,
    allowsExtendedHours: true,
    updatedAt: '2026-06-19T10:00:00.000Z',
  }
}
