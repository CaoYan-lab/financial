import { describe, expect, it } from 'vitest'
import { FutuOpenDProvider } from '../api/providers/futuOpenDProvider'
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
    const provider = new FutuOpenDProvider(async (scriptName) => {
      if (scriptName === 'futu_snapshot.py') {
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
            rows: [
              {
                ticker: 'NVDA',
                currentPrice: '$100.00',
                marketCap: '$1,000,000',
                peRatio: '30.00 TTM',
                rsi14: '50.00',
                ma50: '$95.00',
                ma200: '$80.00',
                ivRank: 'unavailable',
                iv30: '40.00%',
                nextEarningsDate: 'unavailable',
                capitalPerContract: '$9,000.00',
                sevenDayNews: 'unavailable',
              },
            ],
          },
        }
      }
      return { ok: false, error: 'unexpected script' }
    })

    const bundle = await provider.fetchMarketSnapshot([universeCompany('NVDA')])

    expect(bundle.source.source).toBe('Futu OpenD')
    expect(bundle.rows[0].currentPrice).toBe('$100.00')
    expect(bundle.rows[0].iv30).toBe('40.00%')
  })

  it('OpenD 不可用时保守返回 unavailable', async () => {
    const provider = new FutuOpenDProvider(async () => ({ ok: false, error: 'OpenD down' }))
    const bundle = await provider.fetchMarketSnapshot([universeCompany('MSFT')])

    expect(bundle.warnings[0]).toContain('Futu OpenD bridge failed')
    expect(bundle.rows[0].currentPrice).toBe('unavailable')
    expect(bundle.rows[0].sevenDayNews).toContain('Futu OpenD bridge failed')
  })
})

