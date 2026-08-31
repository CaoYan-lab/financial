import { describe, expect, it } from 'vitest'
import type { UniverseCompany } from '../shared/types'
import { lockTopThirtyUniverse } from '../api/services/universeService'

function company(ticker: string, sourceRank: number): UniverseCompany {
  return {
    sourceRank,
    rank: sourceRank,
    ticker,
    companyName: ticker,
    country: 'United States',
    marketCap: 'unavailable',
    source: {
      source: 'test',
      accessedAt: '2026-06-16T00:00:00.000Z',
      timestamp: '2026-06-16T00:00:00.000Z',
    },
  }
}

describe('lockTopThirtyUniverse', () => {
  it('合并重复股权类别并顺延补足 30 家', () => {
    const input = ['GOOG', 'GOOGL', 'BRK.A', 'BRK.B', ...Array.from({ length: 31 }, (_, index) => `T${index}`)].map(
      (ticker, index) => company(ticker, index + 1),
    )

    const result = lockTopThirtyUniverse(input)

    expect(result).toHaveLength(30)
    expect(result.map((item) => item.ticker)).toContain('GOOG')
    expect(result.map((item) => item.ticker)).not.toContain('GOOGL')
    expect(result.find((item) => item.ticker === 'GOOG')?.companyName).toBe('Alphabet')
    expect(result.map((item) => item.ticker)).toContain('BRK.B')
    expect(result.map((item) => item.rank)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
  })
})
