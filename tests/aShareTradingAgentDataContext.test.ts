import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountSummary, Position, RealtimeBar, RealtimePoint } from '../shared/types'
import type { AShareRealtimeSnapshot } from '../api/ashare/aShareRealtimeStore'
import type { AShareUniverseItem } from '../api/ashare/types'

const mocks = vi.hoisted(() => ({
  universe: [] as AShareUniverseItem[],
  futuStockContext: {
    source: 'futu-openapi' as const,
    status: 'OK' as const,
    generatedAt: '2026-06-29T01:00:00.000Z',
    futuCode: 'SH.688256',
    sections: {
      capitalFlow: [{ inFlow: '1000000' }],
      marketState: [{ market: 'SH', state: 'MORNING' }],
    },
    warnings: [] as string[],
  },
  stockNewsContext: {
    source: 'futu-news' as const,
    status: 'OK' as const,
    generatedAt: '2026-06-29T01:00:00.000Z',
    articles: [{ title: '寒武纪公告', source: 'Doubao Search' }],
    warnings: [] as string[],
  },
  macroNewsContext: {
    source: 'Doubao Search Custom shared snapshot' as const,
    priority: 'below_hard_constraints_and_market_facts' as const,
    snapshot: {
      generatedAt: '2026-06-29T01:00:00.000Z',
      riskLevel: 'HIGH' as const,
      summary: '美联储、CPI、CMI 和国际形势风险升温。',
      keyRisks: ['Fed', 'CPI', 'CMI'],
      articles: [{ title: '宏观新闻', source: 'Doubao Search', topic: 'Fed' }],
      warnings: [] as string[],
    },
    rules: ['宏观上下文优先级低于硬风控和行情事实。'],
  },
}))

vi.mock('../api/ashare/aShareUniverseService', () => ({
  getAshareUniverse: () => ({
    ok: true,
    universe: mocks.universe,
    updatedAt: '2026-06-29T01:00:00.000Z',
  }),
}))

vi.mock('../api/ashare/aShareTradingAgentFutuDataSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/ashare/aShareTradingAgentFutuDataSource')>()
  return {
    ...actual,
    fetchAshareFutuStockContext: vi.fn(async () => mocks.futuStockContext),
    fetchAshareFutuStockNewsContext: vi.fn(async () => mocks.stockNewsContext),
  }
})

vi.mock('../api/ashare/aShareTradingAgentMacroContextService', () => ({
  getAshareMacroNewsContextForRun: vi.fn(async () => mocks.macroNewsContext),
}))

const { buildAshareTradingAgentDataContext } = await import('../api/ashare/aShareTradingAgentDataContextService')

describe('buildAshareTradingAgentDataContext', () => {
  beforeEach(() => {
    mocks.universe = [instrument('SH.688256'), instrument('SZ.000001', '平安银行')]
    mocks.futuStockContext.warnings = []
    mocks.stockNewsContext.warnings = []
    mocks.macroNewsContext.snapshot.warnings = []
    process.env.ASHARE_LOT_SIZE = '100'
    process.env.ASHARE_MAX_SINGLE_ORDER_NOTIONAL = '50000'
    process.env.ASHARE_MAX_POSITION_RATIO = '0.2'
    process.env.ASHARE_ESTIMATED_FEE_RATE = '0.001'
  })

  it('注入 Futu 行情、Futu stock context、宏观新闻、持仓和 A 股硬约束', async () => {
    const context = await buildAshareTradingAgentDataContext({
      instrument: instrument('SH.688256'),
      marketData: fullSnapshot(),
      session: 'RTH',
      positions: [
        position({ ticker: '688256.SH', quantity: '200', averageCost: '¥980.00', marketValue: '¥200,000.00' }),
      ],
      accountSummary: accountSummary({
        availableFundsInTradingCurrency: '¥120,000.00',
        buyingPowerInTradingCurrency: '¥150,000.00',
      }),
    })

    expect(context.marketDataContext.status).toBe('OK')
    expect(context.marketDataContext.recentKlineBars).toHaveLength(120)
    expect(context.marketDataContext.recentTickerPoints).toHaveLength(240)
    expect(context.futuStockContext.sections).toHaveProperty('capitalFlow')
    expect(context.stockNewsContext.articles[0].title).toContain('寒武纪')
    expect(context.macroNewsContext.source).toBe('Doubao Search Custom shared snapshot')
    expect(context.accountPositionContext).toMatchObject({
      source: 'futu-account',
      targetTicker: 'SH.688256',
      targetLongQuantity: 200,
    })
    expect(context.sizingContext).toMatchObject({
      currency: 'CNY',
      lotSize: 100,
      lastPrice: 1000,
      limitPrice: 1000,
      availableFunds: 120000,
      buyingPower: 150000,
      targetLongQuantity: 200,
      targetMarketValue: 200000,
      targetAverageCost: 980,
      minBuyNotional: 100000,
    })
    expect(context.sizingContext.rules).toContain('BUY 数量必须是 lotSize 的整数倍。')
    expect(context.aShareRulesContext).toMatchObject({
      session: 'RTH',
      allowedActions: ['HOLD', 'BUY', 'SELL_TO_CLOSE'],
      forbiddenActions: ['SELL_SHORT'],
      humanConfirmationRequired: true,
      orderSession: 'RTH',
    })
    expect(context.universeContext.tickers).toEqual(['SH.688256', 'SZ.000001'])
    expect(context.dataQualityContext.status).toBe('OK')
  })

  it('外部上下文或行情不足时汇总 warnings 并降级 dataQuality', async () => {
    mocks.futuStockContext.warnings = ['futuStockContext: PARTIAL - capital flow unavailable']
    mocks.stockNewsContext.warnings = ['stockNewsContext: using Doubao Search fallback']
    mocks.macroNewsContext.snapshot.warnings = ['macroNewsContext: one topic unavailable']

    const context = await buildAshareTradingAgentDataContext({
      instrument: instrument('SH.688256'),
      marketData: {
        ...fullSnapshot(),
        quote: undefined,
        tickerPoints: [],
        klineBars: bars(20),
        asks: [],
        bids: [],
      },
      session: 'LUNCH_BREAK',
      positions: [],
      accountSummary: accountSummary({
        availableFundsInTradingCurrency: 'unavailable',
        availableFunds: 'unavailable',
        buyingPowerInTradingCurrency: 'unavailable',
        buyingPower: 'unavailable',
      }),
    })

    expect(context.marketDataContext.status).toBe('PARTIAL')
    expect(context.dataQualityContext.status).toBe('BLOCKING')
    expect(context.dataQualityContext.warnings).toEqual(expect.arrayContaining([
      'marketDataContext.quote unavailable.',
      'marketDataContext.recentKlineBars partial: 20/120.',
      'marketDataContext.recentTickerPoints unavailable.',
      'marketDataContext.orderBook unavailable.',
      'futuStockContext: PARTIAL - capital flow unavailable',
      'stockNewsContext: using Doubao Search fallback',
      'macroNewsContext: one topic unavailable',
    ]))
    expect(context.sizingContext.availableFunds).toBeNull()
    expect(context.sizingContext.minBuyNotional).toBeNull()
    expect(context.accountPositionContext?.targetLongQuantity).toBe(0)
  })
})

function instrument(ticker: string, name = '寒武纪'): AShareUniverseItem {
  const [exchange] = ticker.split('.')
  return {
    ticker,
    futuCode: ticker,
    name,
    market: 'CN',
    exchange: exchange as 'SH' | 'SZ',
    tradingCurrency: 'CNY',
    assetType: 'STOCK',
    board: ticker.startsWith('SH.688') ? 'STAR' : 'SZ_MAIN',
    addedAt: '2026-06-29T01:00:00.000Z',
  }
}

function fullSnapshot(): AShareRealtimeSnapshot {
  return {
    ok: true,
    ticker: 'SH.688256',
    subscribed: true,
    source: 'futu-callback',
    quote: {
      ticker: 'SH.688256',
      code: 'SH.688256',
      name: '寒武纪',
      price: '¥1,000.00',
      marketState: 'MORNING',
      change: '+¥10.00',
      changePercent: '+1.00%',
      open: '¥990.00',
      high: '¥1,010.00',
      low: '¥980.00',
      volume: '100000',
      updatedAt: '2026-06-29T01:00:00.000Z',
    },
    tickerPoints: points(300),
    klineBars: bars(150),
    asks: [{ price: '¥1,001.00', size: '100', depth: 1 }],
    bids: [{ price: '¥999.00', size: '100', depth: 1 }],
    callbackStatus: {
      quote: { updatedAt: '2026-06-29T01:00:00.000Z', count: 1 },
      ticker: { updatedAt: '2026-06-29T01:00:00.000Z', count: 1 },
      kline: { updatedAt: '2026-06-29T01:00:00.000Z', count: 1 },
      orderBook: { updatedAt: '2026-06-29T01:00:00.000Z', count: 1 },
    },
    updatedAt: '2026-06-29T01:00:00.000Z',
  }
}

function points(count: number): RealtimePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-06-29T01:${String(index % 60).padStart(2, '0')}:00.000Z`,
    price: 990 + index,
  }))
}

function bars(count: number): RealtimeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-06-29T01:${String(index % 60).padStart(2, '0')}:00.000Z`,
    open: 990 + index,
    high: 995 + index,
    low: 985 + index,
    close: 992 + index,
  }))
}

function accountSummary(overrides: Partial<AccountSummary> = {}): AccountSummary {
  const now = '2026-06-29T01:00:00.000Z'
  return {
    accountId: 'ashare-test',
    currency: 'CNY',
    totalAssets: '¥200,000.00',
    cash: '¥120,000.00',
    availableFunds: '¥120,000.00',
    buyingPower: '¥150,000.00',
    tradingCurrency: 'CNY',
    totalAssetsInTradingCurrency: '¥200,000.00',
    cashInTradingCurrency: '¥120,000.00',
    availableFundsInTradingCurrency: '¥120,000.00',
    buyingPowerInTradingCurrency: '¥150,000.00',
    dailyPnL: '¥0.00',
    totalPnL: '¥0.00',
    source: { source: 'test', accessedAt: now, timestamp: now },
    ...overrides,
  }
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    code: overrides.ticker ?? 'SH.688256',
    ticker: overrides.ticker ?? 'SH.688256',
    name: '寒武纪',
    assetType: 'STOCK',
    underlyingTicker: overrides.underlyingTicker ?? overrides.ticker ?? 'SH.688256',
    quantity: '100',
    marketValue: '¥100,000.00',
    averageCost: '¥1,000.00',
    currentPrice: '¥1,000.00',
    todayPnL: '¥0.00',
    unrealizedPnL: '¥0.00',
    pnlRatio: '0%',
    positionRatio: '10%',
    currency: 'CNY',
    ...overrides,
  }
}
