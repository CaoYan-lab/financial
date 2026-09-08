import { describe, expect, it, vi } from 'vitest'
import { Market } from 'longbridge'
import {
  loadLongbridgeMarketStates,
  normalizeLongbridgeSymbol,
} from '../api/longbridge/longbridgeMarketSessionService.js'

describe('Longbridge 交易日历市场状态', () => {
  it('节假日覆盖证券状态，且港美股按各自时区判断', async () => {
    const tradingDays = vi.fn(async (market: Market, start: { year: number; month: number; day: number }) => ({
      tradingDays: market === Market.HK ? [start] : [],
    }))
    const states = await loadLongbridgeMarketStates(
      { tradingDays },
      ['AAPL.US', '7747.HK'],
      new Date('2026-09-07T16:20:00.000Z'),
    )
    expect(states.get('AAPL.US')).toBe('CLOSED')
    expect(states.get('7747.HK')).toBe('WAITING_OPEN')
    expect(tradingDays).toHaveBeenCalledTimes(2)
  })

  it('美股夜盘归属下一个交易日', async () => {
    const tradingDays = vi.fn(async (_market: Market, _start: unknown, end: { year: number; month: number; day: number }) => ({
      tradingDays: [end],
    }))
    const states = await loadLongbridgeMarketStates(
      { tradingDays },
      ['AAPL'],
      new Date('2026-09-09T01:00:00.000Z'),
    )
    expect(states.get('AAPL.US')).toBe('OVERNIGHT')
  })

  it('日历请求失败时返回不可用并保持失败关闭', async () => {
    const states = await loadLongbridgeMarketStates(
      { tradingDays: vi.fn().mockRejectedValue(new Error('calendar unavailable')) },
      ['AAPL.US', '07747'],
    )
    expect(states).toEqual(new Map([
      ['AAPL.US', 'UNAVAILABLE'],
      ['7747.HK', 'UNAVAILABLE'],
    ]))
  })

  it('统一规范化港美股代码', () => {
    expect(normalizeLongbridgeSymbol('07747')).toBe('7747.HK')
    expect(normalizeLongbridgeSymbol('HK.700')).toBe('700.HK')
    expect(normalizeLongbridgeSymbol('aapl')).toBe('AAPL.US')
  })
})
