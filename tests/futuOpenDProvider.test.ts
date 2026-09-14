import { describe, expect, it, vi } from 'vitest'
import { FutuOpenDProvider } from '../api/providers/futuOpenDProvider'
import type { PythonBridgeResult } from '../api/utils/runPythonBridge'
import type { UniverseCompany } from '../shared/types'

function universeCompany(ticker: string, rank = 1): UniverseCompany {
  return {
    sourceRank: rank,
    rank,
    ticker,
    companyName: ticker,
    country: 'United States',
    marketCap: '$1,000',
    source: {
      source: 'test',
      accessedAt: '2026-06-16T00:00:00.000Z',
      timestamp: '2026-06-16T00:00:00.000Z',
    },
  }
}

describe('FutuOpenDProvider', () => {
  it('标准化 Python Bridge 快照输出', async () => {
    const bridgeRunner = async <T>(scriptName: string, payload: unknown): Promise<PythonBridgeResult<T>> => {
      if (scriptName === 'futu_snapshot.py') {
        const phase = payload as { includeTechnicals: boolean; includeOptions: boolean }
        const row = phase.includeTechnicals
          ? { ticker: 'NVDA', rsi14: '50.00', ma50: '$95.00', ma200: '$80.00' }
          : phase.includeOptions
            ? { ticker: 'NVDA', iv30: '40.00%', selectedOptionStrike: '$90.00' }
            : { ticker: 'NVDA', currentPrice: '$100.00', marketCap: '$1,000,000', peRatio: '30.00 TTM' }
        return {
          ok: true,
          data: {
            ok: true,
            source: {
              source: 'Futu OpenD',
              url: 'https://openapi.futunn.com/futu-api-doc/',
              accessedAt: '2026-06-16T00:00:00.000Z',
              timestamp: '2026-06-16 09:30:00',
            },
            warnings: [],
            rows: [row],
          } as T,
        }
      }
      return { ok: false, error: 'unexpected script' }
    }
    const provider = new FutuOpenDProvider(bridgeRunner)

    const bundle = await provider.fetchMarketSnapshot([universeCompany('NVDA')])

    expect(bundle.source.source).toBe('Futu OpenD')
    expect(bundle.rows[0].currentPrice).toBe('$100.00')
    expect(bundle.rows[0].rsi14).toBe('50.00')
    expect(bundle.rows[0].iv30).toBe('40.00%')
  })

  it('OpenD 不可用时保守返回 unavailable', async () => {
    const provider = new FutuOpenDProvider(async () => ({ ok: false, error: 'OpenD down' }))
    const bundle = await provider.fetchMarketSnapshot([universeCompany('MSFT')])

    expect(bundle.warnings[0]).toContain('Futu OpenD quotes bridge failed')
    expect(bundle.rows[0].currentPrice).toBe('unavailable')
    expect(bundle.rows[0].sevenDayNews).toContain('Futu OpenD bridge failed')
  })

  it('基础报价子进程使用较短的硬超时', async () => {
    const bridgeRunner = vi.fn(async () => ({ ok: false, error: 'timeout' }))
    const provider = new FutuOpenDProvider(bridgeRunner)

    await provider.fetchMarketSnapshot([universeCompany('NVDA')])

    expect(bridgeRunner).toHaveBeenCalledWith(
      'futu_snapshot.py',
      expect.objectContaining({ includeTechnicals: false, includeOptions: false }),
      { timeoutMs: 60_000 },
    )
  })

  it('增强阶段超时时仍保留基础报价', async () => {
    const bridgeRunner = async <T>(_scriptName: string, payload: unknown): Promise<PythonBridgeResult<T>> => {
      const phase = payload as { includeTechnicals: boolean; includeOptions: boolean }
      if (!phase.includeTechnicals && !phase.includeOptions) {
        return {
          ok: true,
          data: {
            ok: true,
            source: {
              source: 'Futu OpenD',
              accessedAt: '2026-06-16T00:00:00.000Z',
              timestamp: '2026-06-16 09:30:00',
            },
            warnings: [],
            rows: [{ ticker: 'MSFT', currentPrice: '$420.00', peRatio: '35.00 TTM' }],
          } as T,
        }
      }
      return { ok: false, error: 'timeout' }
    }
    const provider = new FutuOpenDProvider(bridgeRunner)

    const bundle = await provider.fetchMarketSnapshot([universeCompany('MSFT')])

    expect(bundle.rows[0].currentPrice).toBe('$420.00')
    expect(bundle.rows[0].rsi14).toBe('unavailable')
    expect(bundle.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('technicals bridge failed'),
      expect.stringContaining('options bridge failed'),
    ]))
  })
})
