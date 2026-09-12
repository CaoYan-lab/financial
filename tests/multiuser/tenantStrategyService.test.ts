import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConnection } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  portfolioReview: vi.fn(),
  tradingDecision: vi.fn(),
  estimateFee: vi.fn(() => ({ estimatedTotal: '$1.00' })),
  riskReason: vi.fn(),
  orderSession: vi.fn((): string | null => 'RTH'),
  sessionSkipReason: vi.fn(),
  llmRuntimeConfig: vi.fn(() => ({ config: { disableUsOvernightLlm: true } })),
  trendSummary: vi.fn(() => ({ direction: 'UP' })),
  runtimeConfig: vi.fn(() => ({ activeStrategy: { riskControls: {} } })),
  activePrompt: vi.fn(() => ({
    defaultPresetId: 'default',
    timingPresets: [{
      id: 'default',
      maxPromotedOrdersPerReview: 2,
      leveragedEtfCooldownMinutes: 30,
    }],
  })),
  contexts: vi.fn(),
  workbench: vi.fn(),
  activeOrders: vi.fn(),
  quote: vi.fn(),
  minuteBars: vi.fn(),
  trendBars: vi.fn(),
  depth: vi.fn(),
  trades: vi.fn(),
  tradingDays: vi.fn(),
  simulationTickers: vi.fn(() => ['AAPL', '00700']),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({ query: mocks.query }))
vi.mock('../../api/live/livePortfolioReviewDecisionService.js', () => ({
  requestLivePortfolioReviewDecision: mocks.portfolioReview,
}))
vi.mock('../../api/longbridge/longbridgeLiveDecisionService.js', () => ({
  requestLongbridgeLiveTradingDecision: mocks.tradingDecision,
}))
vi.mock('../../api/longbridge/longbridgeFeeService.js', () => ({
  estimateLongbridgePreTradeFee: mocks.estimateFee,
}))
vi.mock('../../api/longbridge/longbridgeRiskService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/longbridge/longbridgeRiskService.js')>()
  return {
    ...actual,
    longbridgeOpeningRiskRejectionReason: mocks.riskReason,
  }
})
vi.mock('../../api/simulation/usOvernightLlmGate.js', () => ({
  orderSessionForMarketState: mocks.orderSession,
  llmMarketSessionSkipReason: mocks.sessionSkipReason,
}))
vi.mock('../../api/simulation/llmRuntimeConfigService.js', () => ({
  getLlmRuntimeConfig: mocks.llmRuntimeConfig,
}))
vi.mock('../../api/simulation/trendContextService.js', () => ({
  buildTrendContextSummary: mocks.trendSummary,
}))
vi.mock('../../api/simulation/simulationUniverse.js', () => ({
  llmSimulationTickers: mocks.simulationTickers,
}))
vi.mock('../../api/trade_strategy/tradeStrategyConfigService.js', () => ({
  getActiveLivePortfolioReviewPrompt: mocks.activePrompt,
  getTradeStrategyRuntimeConfig: mocks.runtimeConfig,
}))
vi.mock('../../api/cloud/multiuser/longbridge/contextRegistry.js', () => ({
  contextsForConnection: mocks.contexts,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantDataService.js', () => ({
  loadTenantWorkbench: mocks.workbench,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantOrderStore.js', () => ({
  listActiveTenantPendingOrders: mocks.activeOrders,
}))
vi.mock('longbridge', () => ({
  Period: { Min_1: 'Min_1', Min_30: 'Min_30' },
  AdjustType: { NoAdjust: 'NoAdjust' },
  TradeSessions: { All: 'All' },
  Market: { US: 'US', HK: 'HK' },
  NaiveDate: class {
    constructor(public year: number, public month: number, public day: number) {}
    toString() {
      return `${this.year}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`
    }
  },
}))

import {
  runTenantStrategyOnce,
  runTenantStrategyPoolOnce,
} from '../../api/cloud/multiuser/longbridge/tenantStrategyService.js'

const connection: BrokerConnection = {
  id: 'binding-1',
  userId: 'user-1',
  platform: 'longbridge',
  credentialSource: 'encrypted_bundle',
  status: 'verified',
}

const decimal = (value: number) => ({ toString: () => String(value) })
const bar = (close = 100) => ({
  timestamp: new Date(0),
  open: decimal(99),
  high: decimal(101),
  low: decimal(98),
  close: decimal(close),
})
const marketDecision = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  approved: true,
  ticker: 'AAPL',
  action: 'BUY',
  confidence: 'HIGH',
  reason: '趋势明确',
  orderQuantity: 2,
  limitPrice: 100,
  riskAssessment: '可控',
  trendAlignment: 'ALIGNED',
  tradeHorizon: 'SWING_1_TO_7_DAYS',
  whyNotNoise: '多周期确认',
  rawText: '{}',
  ...overrides,
})

describe('Longbridge 租户策略服务', () => {
  let candidateEvents: Array<Record<string, unknown>>

  beforeEach(() => {
    vi.clearAllMocks()
    candidateEvents = []
    mocks.contexts.mockReturnValue({
      quote: {
        quote: mocks.quote,
        candlesticks: vi.fn((...args: unknown[]) =>
          args[1] === 'Min_30' ? mocks.trendBars(...args) : mocks.minuteBars(...args)),
        depth: mocks.depth,
        trades: mocks.trades,
        tradingDays: mocks.tradingDays,
      },
    })
    mocks.quote.mockResolvedValue([{ lastDone: decimal(100), tradeStatus: 0 }])
    mocks.tradingDays.mockImplementation(async (_market: string, begin: { year: number; month: number; day: number }, end: { year: number; month: number; day: number }) => ({
      tradingDays: [begin, end],
    }))
    mocks.minuteBars.mockResolvedValue([bar()])
    mocks.trendBars.mockResolvedValue([bar(99), bar(100)])
    mocks.depth.mockResolvedValue({
      asks: [{ price: decimal(101), volume: 3 }],
      bids: [{ price: decimal(99), volume: 4 }],
    })
    mocks.trades.mockResolvedValue([{ timestamp: new Date(0), price: decimal(100) }])
    mocks.workbench.mockResolvedValue({
      accountMetrics: [
        { label: '账户净资产', value: '$10,000.00' },
        { label: '账户现金', value: '$5,000.00' },
        { label: '现金可用', value: '$4,000.00' },
        { label: '最大购买力', value: '$8,000.00' },
        { label: '风险等级', value: '2' },
      ],
      riskCards: [
        { label: '最大融资额度', value: '$20,000.00' },
        { label: '剩余融资额度', value: '$3,000.00' },
        { label: '初始保证金', value: '$10,500.00' },
        { label: '维持保证金', value: '$9,000.00' },
        { label: '追加保证金', value: '$0.00' },
      ],
      positions: [{
        symbol: 'AAPL.US',
        name: 'Apple',
        quantity: '10',
        marketValue: '$1,000.00',
        averageCost: '$90.00',
        currentPrice: '$100.00',
        todayPnL: '$1.00',
        unrealizedPnL: '$100.00',
        currency: 'USD',
      }],
    })
    mocks.activeOrders.mockResolvedValue([])
    mocks.tradingDecision.mockResolvedValue(marketDecision())
    mocks.riskReason.mockReturnValue(undefined)
    mocks.orderSession.mockReturnValue('RTH')
    mocks.sessionSkipReason.mockReturnValue(undefined)
    mocks.portfolioReview.mockImplementation(async ({ candidates }: { candidates: Array<{ candidateId: string }> }) => ({
      ok: true,
      portfolioDecisionId: 'review-1',
      portfolioRationale: '通过',
      promotedCandidates: candidates.map((item, index) => ({
        candidateId: item.candidateId,
        rank: index + 1,
        reason: '优先',
      })),
      watchedCandidates: [],
      suppressedCandidates: [],
      expiredCandidates: [],
    }))
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT DISTINCT ON')) {
        return candidateEvents.map((payload) => ({ payload }))
      }
      if (sql.includes('INSERT INTO multiuser.longbridge_events') && params?.[2] === 'candidate-pool') {
        candidateEvents.push(JSON.parse(String(params[4])) as Record<string, unknown>)
      }
      return []
    })
  })

  it('行情失败时记录跳过信号并规范化港股代码', async () => {
    mocks.quote.mockRejectedValueOnce(new Error('quote unavailable'))
    mocks.trendBars.mockRejectedValueOnce(new Error('trend unavailable'))
    const result = await runTenantStrategyOnce('user-1', connection, '00700')
    expect(result).toMatchObject({ ok: false, symbol: '700.HK' })
    expect(mocks.query.mock.calls.some(([, params]) =>
      Array.isArray(params) && params[2] === 'signals' && params[3] === 'SKIPPED')).toBe(true)
  })

  it('模型 HOLD 时只记录信号，不进入候选池', async () => {
    mocks.tradingDecision.mockResolvedValueOnce(marketDecision({
      action: 'HOLD',
      approved: false,
      orderQuantity: 0,
    }))
    const result = await runTenantStrategyOnce('user-1', connection, 'aapl.us')
    expect(result).toMatchObject({ ok: true, signal: { lifecycleStatus: 'HOLD' } })
    expect(candidateEvents).toHaveLength(0)
  })

  it('将租户长桥融资风险等级和保证金状态传给模型', async () => {
    mocks.tradingDecision.mockResolvedValueOnce(marketDecision({
      action: 'HOLD',
      approved: false,
      orderQuantity: 0,
    }))

    await runTenantStrategyOnce('user-1', connection, 'AAPL.US')

    expect(mocks.tradingDecision).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({
        summary: expect.objectContaining({
          financingRiskLevel: 2,
          financingRiskLabel: '预警',
          financingOpeningRestricted: true,
          initialMargin: '$10,500.00',
          marginCall: '$0.00',
          remainingFinancing: '$3,000.00',
        }),
      }),
    }))
  })

  it('统一市场门禁命中时不请求模型且不落信号数据', async () => {
    mocks.sessionSkipReason.mockReturnValueOnce('港股休市后不评估')
    const result = await runTenantStrategyOnce('user-1', connection, '07747', {
      marketState: 'CLOSED',
    })
    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      symbol: '7747.HK',
      marketState: 'CLOSED',
    })
    expect(mocks.tradingDecision).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([, params]) =>
      Array.isArray(params) && params[2] === 'signals')).toBe(false)
  })

  it('向统一门禁透传美股夜盘开关和租户市场状态', async () => {
    const now = new Date('2026-09-08T08:30:00.000Z')
    mocks.tradingDecision.mockResolvedValueOnce(marketDecision({
      action: 'HOLD',
      approved: false,
      orderQuantity: 0,
    }))
    await runTenantStrategyOnce('user-1', connection, 'AAPL', {
      marketState: 'PRE_MARKET_BEGIN',
      now,
    })
    expect(mocks.sessionSkipReason).toHaveBeenCalledWith({
      ticker: 'AAPL',
      marketState: 'PRE_MARKET_BEGIN',
      disableUsOvernightLlm: true,
      now,
    })
  })

  it('市场状态不可用时按休市保护且不请求模型', async () => {
    const result = await runTenantStrategyOnce('user-1', connection, 'AAPL', {
      marketState: 'UNAVAILABLE',
    })
    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      marketState: 'UNAVAILABLE',
    })
    expect(String(result.error)).toContain('无法确认')
    expect(mocks.tradingDecision).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([, params]) =>
      Array.isArray(params) && params[2] === 'signals')).toBe(false)
  })

  it('未指定标的时按完整股票池逐一评估并按市场复用账户快照', async () => {
    mocks.tradingDecision.mockResolvedValue(marketDecision({
      action: 'HOLD',
      approved: false,
      orderQuantity: 0,
    }))
    const result = await runTenantStrategyPoolOnce('user-1', connection)
    expect(result).toMatchObject({
      ok: true,
      universe: ['AAPL.US', '700.HK'],
      evaluatedCount: 2,
      succeededCount: 2,
      failedCount: 0,
    })
    expect(mocks.workbench).toHaveBeenCalledTimes(2)
    expect(mocks.workbench).toHaveBeenCalledWith(connection, 'USD')
    expect(mocks.workbench).toHaveBeenCalledWith(connection, 'HKD')
    expect(mocks.tradingDecision).toHaveBeenCalledTimes(2)
  })

  it('全池休市属于正常跳过，不计为执行失败', async () => {
    mocks.sessionSkipReason.mockReturnValue('当前市场休市')
    const result = await runTenantStrategyPoolOnce('user-1', connection)
    expect(result).toMatchObject({
      ok: true,
      evaluatedCount: 2,
      succeededCount: 0,
      skippedCount: 2,
      failedCount: 0,
    })
    expect(mocks.workbench).not.toHaveBeenCalled()
    expect(mocks.tradingDecision).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([, params]) =>
      Array.isArray(params) && params[2] === 'signals')).toBe(false)
  })

  it('已有同标的待确认订单时由风险规则阻断', async () => {
    mocks.activeOrders.mockResolvedValueOnce([{
      id: 'existing',
      status: 'PENDING_CONFIRMATION',
      createdAt: 'now',
      updatedAt: 'now',
      intent: { ticker: 'AAPL', side: 'SELL' },
      riskWarnings: [],
    }])
    const result = await runTenantStrategyOnce('user-1', connection)
    expect(String(result.riskReason)).toContain('已有未终态待确认订单')
    expect(mocks.riskReason).not.toHaveBeenCalled()
  })

  it('市场时段不允许下单时阻断候选', async () => {
    mocks.orderSession.mockReturnValueOnce(null)
    const result = await runTenantStrategyOnce('user-1', connection, 'AAPL')
    expect(String(result.riskReason)).toContain('只允许策略研究')
  })

  it('策略风险检查拒绝时不进入候选池', async () => {
    mocks.riskReason.mockReturnValueOnce('集中度超限')
    const result = await runTenantStrategyOnce('user-1', connection, 'AAPL')
    expect(result).toMatchObject({ riskReason: '集中度超限' })
    expect(mocks.runtimeConfig).toHaveBeenCalledWith('live')
  })

  it('候选未获组合裁决晋级时停止在候选池', async () => {
    mocks.portfolioReview.mockResolvedValueOnce({
      ok: true,
      portfolioDecisionId: 'review-2',
      portfolioRationale: '观察',
      promotedCandidates: [],
      watchedCandidates: [{ candidateId: 'not-current', reason: '等待' }],
      suppressedCandidates: [],
      expiredCandidates: [],
    })
    const result = await runTenantStrategyOnce('user-1', connection, 'AAPL')
    expect(result).toMatchObject({ ok: true, candidate: { ticker: 'AAPL' } })
    expect(result).not.toHaveProperty('pendingOrder')
  })

  it('组合裁决失败时为全部候选写入 REVIEW_FAILED', async () => {
    mocks.portfolioReview.mockResolvedValueOnce({
      ok: false,
      portfolioDecisionId: 'review-failed',
      portfolioRationale: '模型不可用',
      promotedCandidates: [],
      watchedCandidates: [],
      suppressedCandidates: [],
      expiredCandidates: [],
    })
    const result = await runTenantStrategyOnce('user-1', connection, 'AAPL')
    expect(result).not.toHaveProperty('pendingOrder')
    expect(candidateEvents.some((item) => item.status === 'REVIEW_FAILED')).toBe(true)
  })

  it('组合裁决晋级后生成待人工确认订单', async () => {
    const result = await runTenantStrategyOnce('user-1', connection, 'AAPL')
    expect(result).toMatchObject({
      ok: true,
      signal: { lifecycleStatus: 'CANDIDATE_POOL' },
      pendingOrder: {
        status: 'PENDING_CONFIRMATION',
        intent: {
          ticker: 'AAPL',
          side: 'BUY',
          quantity: 2,
          orderSession: 'RTH',
        },
      },
    })
    expect(mocks.estimateFee).toHaveBeenCalled()
    expect(mocks.portfolioReview).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ selectedAccountId: connection.id }),
        positions: expect.arrayContaining([expect.objectContaining({ ticker: 'AAPL' })]),
      }),
      { namespace: 'live' },
    )
  })

  it('裁决状态更新忽略不存在候选并覆盖 WATCH/SUPPRESSED/EXPIRED', async () => {
    mocks.portfolioReview.mockImplementationOnce(async ({ candidates }: { candidates: Array<{ candidateId: string }> }) => ({
      ok: true,
      portfolioDecisionId: 'review-all',
      portfolioRationale: '分类',
      promotedCandidates: [{ candidateId: 'missing', rank: 1, reason: 'missing' }],
      watchedCandidates: [{ candidateId: candidates[0].candidateId, reason: 'watch' }],
      suppressedCandidates: [{ candidateId: candidates[0].candidateId, reason: 'suppress' }],
      expiredCandidates: [{ candidateId: candidates[0].candidateId, reason: 'expire' }],
    }))
    await runTenantStrategyOnce('user-1', connection, 'AAPL')
    expect(candidateEvents.map((item) => item.status)).toEqual(expect.arrayContaining([
      'WATCH', 'SUPPRESSED', 'EXPIRED',
    ]))
  })
})
