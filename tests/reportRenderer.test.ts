import { describe, expect, it } from 'vitest'
import type { DataQualityReport, RawCompanyData } from '../shared/types'
import { analyzeCompanies } from '../api/services/analysisService'
import { renderMarkdownReport } from '../api/services/reportRenderer'

function row(index: number): RawCompanyData {
  return {
    rank: index,
    ticker: `T${index}`,
    companyName: `Company ${index}`,
    country: 'United States',
    currentPrice: 'unavailable',
    marketCap: 'unavailable',
    peRatio: 'unavailable',
    rsi14: 'unavailable',
    ma50: 'unavailable',
    ma200: 'unavailable',
    ivRank: 'unavailable',
    iv30: 'unavailable',
    nextEarningsDate: 'unavailable',
    capitalPerContract: 'unavailable',
    sevenDayNews: 'unavailable',
    source: {
      source: 'test',
      accessedAt: '2026-06-16T00:00:00.000Z',
      timestamp: '2026-06-16T00:00:00.000Z',
    },
  }
}

describe('renderMarkdownReport', () => {
  it('先输出中文、包含纯数据表和中英文免责声明', () => {
    const rawData = Array.from({ length: 30 }, (_, index) => row(index + 1))
    const batchId = 'batch-test'
    const generatedAt = '2026-06-16T00:00:00.000Z'
    const dataQuality: DataQualityReport = {
      batchId,
      generatedAt,
      sources: [rawData[0].source],
      unavailableSummary: { currentPrice: 30 },
      issues: [],
      isUsableForAnalysis: true,
    }
    const analysis = analyzeCompanies(batchId, generatedAt, rawData)
    const markdown = renderMarkdownReport({ batchId, generatedAt, rawData, dataQuality, analysis })

    expect(markdown.startsWith('# Top 30 Mega-Cap Cash-Secured Put 30 日分析')).toBe(true)
    expect(markdown).toContain('报告窗口：30 日')
    expect(markdown).toContain('## A. 第零部分：纯数据表 Raw Data Table')
    expect(markdown).toContain('This analysis is for informational purposes only')
    expect(markdown).toContain('本分析仅供信息参考')
  })
})
