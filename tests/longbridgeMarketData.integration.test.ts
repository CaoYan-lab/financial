import { describe, expect, it } from 'vitest'
import { loadLongbridgeStrategyMarketData, normalizeLongbridgeSymbol } from '../api/longbridge/longbridgeMarketDataService'

const run = process.env.RUN_LONGBRIDGE_INTEGRATION === '1' ? describe : describe.skip

run('Longbridge market data integration', () => {
  it('读取 AAPL.US 真实 quote 和 1m K 线并标准化', async () => {
    const data = await loadLongbridgeStrategyMarketData('AAPL.US', { klineCount: 30 })

    expect(data.ok).toBe(true)
    if (!data.ok) throw new Error(data.reason)
    expect(data.source).toBe('longbridge-cli')
    expect(data.symbol).toBe('AAPL.US')
    expect(data.ticker).toBe('AAPL')
    expect(data.lastPrice).toBeGreaterThan(0)
    expect(data.bars.length).toBeGreaterThan(0)
    expect(data.updatedAt).toBeTruthy()
  }, 60_000)

  it('支持港股 symbol 标准化', () => {
    expect(normalizeLongbridgeSymbol('700.HK')).toBe('700.HK')
    expect(normalizeLongbridgeSymbol('00700.HK')).toBe('700.HK')
    expect(normalizeLongbridgeSymbol('07709')).toBe('7709.HK')
    expect(normalizeLongbridgeSymbol('NVDA')).toBe('NVDA.US')
  })

  it('不可用 symbol 返回结构化错误', async () => {
    const data = await loadLongbridgeStrategyMarketData('NOT_A_REAL_SYMBOL.US', { klineCount: 5, includeDepth: false, includeTrades: false })

    expect(data.ok).toBe(false)
    if (data.ok) throw new Error('expected invalid symbol to fail')
    expect(data.reason).toBeTruthy()
    expect(data.source).toBe('longbridge-cli')
  }, 60_000)
})
