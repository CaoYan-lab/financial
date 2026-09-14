import { describe, expect, it } from 'vitest'
import type { DataProvider } from '../api/providers/DataProvider'
import { collectRawData } from '../api/services/marketDataService'
import { buildDataQualityReport } from '../api/utils/dataIntegrity'
import type { DataSourceCitation, RawCompanyData, UniverseCompany } from '../shared/types'

const source: DataSourceCitation = {
  source: 'Futu OpenD',
  accessedAt: '2026-09-14T00:00:00.000Z',
  timestamp: '2026-09-14T00:00:00.000Z',
}

function universe(): UniverseCompany[] {
  return Array.from({ length: 30 }, (_, index) => ({
    sourceRank: index + 1,
    rank: index + 1,
    ticker: `TEST${index + 1}`,
    companyName: `Test ${index + 1}`,
    country: 'United States',
    marketCap: '$1,000',
    source,
  }))
}

function unavailableRows(): RawCompanyData[] {
  return universe().map((company) => ({
    rank: company.rank,
    ticker: company.ticker,
    companyName: company.companyName,
    country: company.country,
    currentPrice: 'unavailable',
    marketCap: company.marketCap,
    peRatio: 'unavailable',
    rsi14: 'unavailable',
    ma50: 'unavailable',
    ma200: 'unavailable',
    ivRank: 'unavailable',
    iv30: 'unavailable',
    nextEarningsDate: 'unavailable',
    capitalPerContract: 'unavailable',
    sevenDayNews: 'unavailable',
    source,
  }))
}

describe('报告关键数据门禁', () => {
  it('全部价格不可用时标记为不可分析', () => {
    const quality = buildDataQualityReport('batch-test', source.timestamp, unavailableRows(), [source])

    expect(quality.isUsableForAnalysis).toBe(false)
    expect(quality.issues).toContainEqual(expect.objectContaining({
      field: 'currentPrice',
      severity: 'blocking',
    }))
  })

  it('阻止全空行情进入报告生成阶段', async () => {
    const provider: DataProvider = {
      getStatus: async () => {
        throw new Error('not used')
      },
      fetchUniverse: async () => universe(),
      fetchMarketSnapshot: async () => ({
        source,
        warnings: ['bridge timeout'],
        rows: unavailableRows(),
      }),
    }

    await expect(collectRawData(provider, 'batch-test')).rejects.toThrow('报告数据不可用')
  })
})
