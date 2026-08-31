import { describe, expect, it } from 'vitest'
import { realtimeStore } from '../api/realtime/realtimeStore'

describe('realtimeStore', () => {
  it('按 ticker 覆盖刷新实时回调数据', () => {
    realtimeStore.setSubscribedTickers(['GOOG'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'GOOG',
      updatedAt: '2026-06-16T10:00:00',
      quote: {
        ticker: 'GOOG',
        code: 'US.GOOG',
        name: 'Alphabet',
        price: '$100.00',
        change: '+$1.00',
        changePercent: '+1.00%',
        open: '$99.00',
        high: '$101.00',
        low: '$98.00',
        volume: '1000',
        updatedAt: '2026-06-16T10:00:00',
      },
    })
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'GOOG',
      updatedAt: '2026-06-16T10:01:00',
      quote: {
        ticker: 'GOOG',
        code: 'US.GOOG',
        name: 'Alphabet',
        price: '$101.00',
        change: '+$2.00',
        changePercent: '+2.00%',
        open: '$99.00',
        high: '$102.00',
        low: '$98.00',
        volume: '2000',
        updatedAt: '2026-06-16T10:01:00',
      },
    })

    const snapshot = realtimeStore.snapshot('GOOG')
    expect(snapshot.subscribed).toBe(true)
    expect(snapshot.source).toBe('futu-callback')
    expect(snapshot.quote?.price).toBe('$101.00')
    expect(snapshot.callbackStatus.quote.count).toBeGreaterThanOrEqual(2)
  })

  it('分时和 K 线按时间合并缓存，而不是只保留最新回调批次', () => {
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'MSFT',
      updatedAt: '2026-06-16T10:00:00',
      points: [{ time: '2026-06-16 10:00:01.000', price: 100 }],
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'MSFT',
      updatedAt: '2026-06-16T10:00:02',
      points: [{ time: '2026-06-16 10:00:02.000', price: 101 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'MSFT',
      updatedAt: '2026-06-16T10:01:00',
      bars: [{ time: '2026-06-16 10:00:00', open: 99, high: 101, low: 98, close: 100 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'MSFT',
      updatedAt: '2026-06-16T10:02:00',
      bars: [{ time: '2026-06-16 10:01:00', open: 100, high: 102, low: 99, close: 101 }],
    })

    const snapshot = realtimeStore.snapshot('MSFT')
    expect(snapshot.tickerPoints).toHaveLength(2)
    expect(snapshot.klineBars).toHaveLength(2)
    expect(snapshot.tickerPoints.map((point) => point.price)).toEqual([100, 101])
    expect(snapshot.klineBars.map((bar) => bar.time)).toEqual(['2026-06-16 10:00:00', '2026-06-16 10:01:00'])
  })

  it('K 线和分时缓存保留最近窗口，跨交易日剔除由策略会话层处理', () => {
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'SPCU_CACHE_GAP',
      updatedAt: '2026-06-18T13:03:00',
      points: [{ time: '2026-06-18 13:03:00.000', price: 23.23 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'SPCU_CACHE_GAP',
      updatedAt: '2026-06-18T13:03:00',
      bars: [{ time: '2026-06-18 13:03:00', open: 23.06, high: 23.25, low: 23.06, close: 23.23 }],
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'SPCU_CACHE_GAP',
      updatedAt: '2026-06-23T12:49:00',
      points: [{ time: '2026-06-23 12:49:00.000', price: 18.64 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'SPCU_CACHE_GAP',
      updatedAt: '2026-06-23T12:49:00',
      bars: [{ time: '2026-06-23 12:49:00', open: 18.64, high: 18.64, low: 18.63, close: 18.63 }],
    })

    const snapshot = realtimeStore.snapshot('SPCU_CACHE_GAP')
    expect(snapshot.tickerPoints).toEqual([
      { time: '2026-06-18 13:03:00.000', price: 23.23 },
      { time: '2026-06-23 12:49:00.000', price: 18.64 },
    ])
    expect(snapshot.klineBars).toEqual([
      { time: '2026-06-18 13:03:00', open: 23.06, high: 23.25, low: 23.06, close: 23.23 },
      { time: '2026-06-23 12:49:00', open: 18.64, high: 18.64, low: 18.63, close: 18.63 },
    ])
  })

  it('同一交易日内的盘前和盘中 K 线会保留，用于早盘补足数据窗口', () => {
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'EARLY_RTH',
      updatedAt: '2026-06-23T08:00:00',
      bars: [{ time: '2026-06-23 08:00:00', open: 10, high: 10.2, low: 9.9, close: 10.1 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'EARLY_RTH',
      updatedAt: '2026-06-23T09:35:00',
      bars: [{ time: '2026-06-23 09:35:00', open: 10.1, high: 10.4, low: 10, close: 10.3 }],
    })

    const snapshot = realtimeStore.snapshot('EARLY_RTH')
    expect(snapshot.klineBars.map((bar) => bar.time)).toEqual(['2026-06-23 08:00:00', '2026-06-23 09:35:00'])
  })
})
