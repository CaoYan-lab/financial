import { describe, expect, it } from 'vitest'
import type { RawCompanyData } from '../shared/types'
import { analyzeCompanies } from '../api/services/analysisService'

function row(index: number, overrides: Partial<RawCompanyData> = {}): RawCompanyData {
  return {
    rank: index,
    ticker: index === 1 ? 'NVDA' : `T${index}`,
    companyName: `Company ${index}`,
    country: 'United States',
    currentPrice: '$100.00',
    marketCap: '$1T',
    peRatio: '25',
    rsi14: '45',
    ma50: '$98.00',
    ma200: '$95.00',
    ivRank: '60%',
    iv30: '35%',
    nextEarningsDate: '2099-01-01',
    capitalPerContract: '$9,000',
    sevenDayNews: 'Constructive news.',
    source: {
      source: 'test',
      accessedAt: '2026-06-16T00:00:00.000Z',
      timestamp: '2026-06-16T00:00:00.000Z',
    },
    ...overrides,
  }
}

describe('analyzeCompanies', () => {
  it('生成 Top 5、Bottom 5，并识别 Track Both', () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(index + 1))
    rows[29] = row(30, { ticker: 'HOT', rsi14: '80', peRatio: '60' })

    const result = analyzeCompanies('batch-test', '2026-06-16T00:00:00.000Z', rows)

    expect(result.topOpportunities).toHaveLength(5)
    expect(result.bottomLosers).toHaveLength(5)
    expect(result.companyAnalyses[0].track).toBe('Both')
    expect(result.bottomLosers.some((item) => item.ticker === 'HOT')).toBe(true)
  })
})

