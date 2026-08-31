import { beforeEach, describe, expect, it } from 'vitest'
import { latestQuotePrice } from '../api/longbridge/longbridgeMarketDataService'
import { loadLongbridgeRealtimeStrategyMarketData, loadLongbridgeRealtimeTrendContext } from '../api/longbridge/longbridgeRealtimeDataAdapter'
import { longbridgeRealtimeStore } from '../api/longbridge/longbridgeRealtimeStore'
import { longbridgeRealtimeSubscriptionService } from '../api/longbridge/longbridgeRealtimeSubscriptionService'

describe('Longbridge realtime SDK cache', () => {
  beforeEach(() => {
    longbridgeRealtimeSubscriptionService.resetForTests()
  })

  it('优先用 SDK cache 组装 LLM 行情窗口', async () => {
    seedAaplCache()

    const data = await loadLongbridgeRealtimeStrategyMarketData('AAPL.US', { klineCount: 30 })

    expect(data.ok).toBe(true)
    if (!data.ok) throw new Error(data.reason)
    expect(data.source).toBe('longbridge-sdk-cache')
    expect(data.symbol).toBe('AAPL.US')
    expect(data.ticker).toBe('AAPL')
    expect(data.lastPrice).toBe(201.5)
    expect(data.bars).toHaveLength(30)
    expect(data.tickerPoints.length).toBeGreaterThan(0)
    expect(data.asks[0].price).toBe('$201.60')
    expect(data.bids[0].price).toBe('$201.40')
  })

  it('可从 SDK cache K 线构造趋势上下文', async () => {
    seedAaplCache()

    const trend = await loadLongbridgeRealtimeTrendContext('AAPL.US', {
      lookbackTradingDays: 7,
      barInterval: '30m',
      currentPrice: 201.5,
    })

    expect(trend.window.available).toBe(true)
    expect(trend.window.source).toBe('longbridge-sdk-cache')
    expect(trend.summary).toContain('Longbridge SDK 缓存')
  })

  it('SDK cache 保留最近窗口，常规盘读取时才剔除跨交易日旧数据', async () => {
    longbridgeRealtimeStore.markSubscribed(['SPCU.US'])
    longbridgeRealtimeStore.upsertQuote({
      symbol: 'SPCU.US',
      lastPrice: 18.64,
      marketState: 'Normal',
      updatedAt: '2026-06-23T12:49:00.000Z',
      source: 'longbridge-sdk-cache',
    })
    longbridgeRealtimeStore.upsertBars('SPCU.US', '1m', [
      { time: '2026-06-18T13:03:00.000Z', open: 23.06, high: 23.25, low: 23.06, close: 23.23 },
      { time: '2026-06-23T12:49:00.000Z', open: 18.64, high: 18.64, low: 18.63, close: 18.63 },
    ])
    longbridgeRealtimeStore.appendTrades('SPCU.US', [
      { time: '2026-06-18T13:03:00.000Z', price: 23.23 },
      { time: '2026-06-23T12:49:00.000Z', price: 18.64 },
    ])

    const snapshot = longbridgeRealtimeStore.getSnapshot('SPCU.US')
    expect(snapshot?.bars['1m']).toHaveLength(2)
    expect(snapshot?.tickerPoints).toHaveLength(2)

    const data = await loadLongbridgeRealtimeStrategyMarketData('SPCU.US', { klineCount: 1 })
    expect(data.ok).toBe(true)
    if (!data.ok) throw new Error(data.reason)
    expect(data.bars).toEqual([{ time: '2026-06-23T12:49:00.000Z', open: 18.64, high: 18.64, low: 18.63, close: 18.63 }])
  })

  it('实盘评估可禁止 SDK cache 不足时临时 CLI 兜底', async () => {
    longbridgeRealtimeStore.markSubscribed(['MU.US'])
    longbridgeRealtimeStore.upsertQuote({
      symbol: 'MU.US',
      lastPrice: 124.5,
      marketState: 'PreMarket',
      updatedAt: '2026-06-24T08:30:00-04:00',
      source: 'longbridge-sdk-cache',
    })
    longbridgeRealtimeStore.upsertBars('MU.US', '1m', [
      { time: '2026-06-24T08:29:00-04:00', open: 124, high: 125, low: 123.9, close: 124.5 },
    ])

    const data = await loadLongbridgeRealtimeStrategyMarketData('MU.US', { klineCount: 120, allowFallback: false })

    expect(data.ok).toBe(false)
    if (data.ok) throw new Error('expected skipped market data')
    expect(data.source).toBe('longbridge-sdk-cache')
    expect(data.reason).toBe('Longbridge SDK cache 1m K 线不足')
    expect(data.warnings.join('；')).toContain('当前 1 / 要求 120')
  })

  it('美股开盘初期 Normal 状态仍保留同日盘前 K 线补足窗口', async () => {
    longbridgeRealtimeStore.markSubscribed(['AAPL.US'])
    longbridgeRealtimeStore.upsertQuote({
      symbol: 'AAPL.US',
      lastPrice: 202,
      marketState: 'Normal',
      updatedAt: '2026-06-24T09:31:00-04:00',
      source: 'longbridge-sdk-cache',
    })
    longbridgeRealtimeStore.upsertBars('AAPL.US', '1m', [
      { time: '2026-06-23T15:59:00-04:00', open: 198, high: 199, low: 197, close: 198.5 },
      { time: '2026-06-24T08:59:00-04:00', open: 200, high: 201, low: 199.5, close: 200.5 },
      { time: '2026-06-24T09:30:00-04:00', open: 201, high: 202, low: 200.8, close: 201.5 },
      { time: '2026-06-24T09:31:00-04:00', open: 201.5, high: 202.5, low: 201.4, close: 202 },
    ])

    const data = await loadLongbridgeRealtimeStrategyMarketData('AAPL.US', { klineCount: 3, allowFallback: false })

    expect(data.ok).toBe(true)
    if (!data.ok) throw new Error(data.reason)
    expect(data.bars.map((bar) => bar.time)).toEqual([
      '2026-06-24T12:59:00.000Z',
      '2026-06-24T13:30:00.000Z',
      '2026-06-24T13:31:00.000Z',
    ])
  })

  it('美股盘前 quote 优先使用 pre_market 最新价而不是上一交易日常规收盘价', () => {
    const quote = {
      symbol: 'AMD.US',
      last: '519.850',
      status: 'Normal',
      pre_market: {
        last: '527.896',
        timestamp: '2026-06-24T09:56:10Z',
      },
    }

    expect(latestQuotePrice(quote, 'AMD.US', new Date('2026-06-24T09:56:10Z'))).toBe(527.896)
    expect(latestQuotePrice(quote, 'AMD.US', new Date('2026-06-24T14:00:00Z'))).toBe(519.85)
  })

  it('SDK cache 盘前 quote 为旧收盘价时用最新成交点作为 LLM 最新价', async () => {
    longbridgeRealtimeStore.markSubscribed(['AMD.US'])
    longbridgeRealtimeStore.upsertQuote({
      symbol: 'AMD.US',
      lastPrice: 519.85,
      marketState: 'Normal',
      updatedAt: '2026-06-24T09:56:10.000Z',
      source: 'longbridge-sdk-cache',
    })
    longbridgeRealtimeStore.upsertBars('AMD.US', '1m', [
      { time: '2026-06-24T09:54:00.000Z', open: 526, high: 528, low: 526, close: 527 },
      { time: '2026-06-24T09:55:00.000Z', open: 527, high: 528, low: 526, close: 527.5 },
    ])
    longbridgeRealtimeStore.appendTrades('AMD.US', [
      { time: '2026-06-24T09:56:10.000Z', price: 527.896 },
    ])

    const data = await loadLongbridgeRealtimeStrategyMarketData('AMD.US', { klineCount: 2, allowFallback: false })

    expect(data.ok).toBe(true)
    if (!data.ok) throw new Error(data.reason)
    expect(data.lastPrice).toBe(527.896)
  })

  it('SDK cache 港股盘前当前日不足时允许带上最近上一交易日窗口', async () => {
    longbridgeRealtimeStore.markSubscribed(['7709.HK'])
    longbridgeRealtimeStore.upsertQuote({
      symbol: '7709.HK',
      lastPrice: 10.1,
      marketState: 'PreMarket',
      updatedAt: '2026-06-24T09:26:00+08:00',
      source: 'longbridge-sdk-cache',
    })
    longbridgeRealtimeStore.upsertBars('7709.HK', '1m', [
      { time: '2026-06-23T15:59:00+08:00', open: 10, high: 10.1, low: 9.9, close: 10 },
      { time: '2026-06-24T09:25:00+08:00', open: 10, high: 10.2, low: 10, close: 10.1 },
    ])
    longbridgeRealtimeStore.appendTrades('7709.HK', [
      { time: '2026-06-24T09:25:30+08:00', price: 10.1 },
    ])
    longbridgeRealtimeStore.upsertDepth('7709.HK', {
      asks: [{ price: 'HK$10.11', size: '100', depth: 1 }],
      bids: [{ price: 'HK$10.09', size: '100', depth: 1 }],
    })

    const data = await loadLongbridgeRealtimeStrategyMarketData('7709.HK', { klineCount: 2 })
    expect(data.ok).toBe(true)
    if (!data.ok) throw new Error(data.reason)
    expect(data.ticker).toBe('07709')
    expect(data.bars.map((bar) => bar.time)).toEqual(['2026-06-23T07:59:00.000Z', '2026-06-24T01:25:00.000Z'])
    expect(data.tickerPoints.length).toBeGreaterThanOrEqual(2)
  })

  it('SDK 环境变量缺失时标记为降级，不伪装订阅成功', async () => {
    const original = {
      key: process.env.LONGBRIDGE_APP_KEY,
      secret: process.env.LONGBRIDGE_APP_SECRET,
      token: process.env.LONGBRIDGE_ACCESS_TOKEN,
    }
    delete process.env.LONGBRIDGE_APP_KEY
    delete process.env.LONGBRIDGE_APP_SECRET
    delete process.env.LONGBRIDGE_ACCESS_TOKEN

    await longbridgeRealtimeSubscriptionService.ensureSubscribed(['AAPL.US'])

    const status = longbridgeRealtimeStore.getStatus()
    expect(status.state).toBe('degraded')
    expect(status.sdkAvailable).toBe(false)
    expect(status.lastError).toContain('LONGBRIDGE_APP_KEY')

    restoreEnv('LONGBRIDGE_APP_KEY', original.key)
    restoreEnv('LONGBRIDGE_APP_SECRET', original.secret)
    restoreEnv('LONGBRIDGE_ACCESS_TOKEN', original.token)
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function seedAaplCache() {
  const now = Date.now()
  longbridgeRealtimeStore.markSubscribed(['AAPL.US'])
  longbridgeRealtimeStore.upsertQuote({
    symbol: 'AAPL.US',
    lastPrice: 201.5,
    marketState: 'Normal',
    updatedAt: new Date(now).toISOString(),
    source: 'longbridge-sdk-cache',
  })
  longbridgeRealtimeStore.upsertBars('AAPL.US', '1m', Array.from({ length: 60 }, (_, index) => bar(now, index, 1)))
  longbridgeRealtimeStore.upsertBars('AAPL.US', '30m', Array.from({ length: 30 }, (_, index) => bar(now, index, 30)))
  longbridgeRealtimeStore.upsertDepth('AAPL.US', {
    asks: [{ price: '$201.60', size: '100', depth: 1 }],
    bids: [{ price: '$201.40', size: '100', depth: 1 }],
  })
  longbridgeRealtimeStore.appendTrades('AAPL.US', [
    { time: new Date(now - 1_000).toISOString(), price: 201.45 },
    { time: new Date(now).toISOString(), price: 201.5 },
  ])
}

function bar(now: number, index: number, minutes: number) {
  const close = 200 + index * 0.05
  return {
    time: new Date(now - (60 - index) * minutes * 60_000).toISOString(),
    open: close - 0.02,
    high: close + 0.05,
    low: close - 0.05,
    close,
  }
}
