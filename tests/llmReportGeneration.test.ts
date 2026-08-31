import { describe, expect, it } from 'vitest'
import { analyzeCompanies } from '../api/services/analysisService'
import { buildReportGenerationPrompt } from '../api/services/llmReportAnalysisService'
import type { DataQualityReport, RawCompanyData, ReportMarketContext } from '../shared/types'

describe('buildReportGenerationPrompt', () => {
  it('要求模型基于 Futu 数据、趋势和市场信息生成 Markdown 报告', () => {
    const rawData = Array.from({ length: 30 }, (_, index) => row(index + 1))
    const batchId = 'batch-llm-report'
    const generatedAt = '2026-06-17T00:00:00.000Z'
    const dataQuality: DataQualityReport = {
      batchId,
      generatedAt,
      sources: [rawData[0].source],
      unavailableSummary: {},
      issues: [],
      isUsableForAnalysis: true,
    }
    const marketContext: ReportMarketContext = {
      generatedAt,
      source: 'test headline search',
      headlines: [{ ticker: 'T1', title: 'T1 test headline', source: 'test' }],
      warnings: [],
    }
    const prompt = buildReportGenerationPrompt({
      batchId,
      generatedAt,
      rawData,
      dataQuality,
      marketContext,
      reportWindowDays: 60,
      baselineAnalysis: analyzeCompanies(batchId, generatedAt, rawData),
    })

    expect(prompt[0].content).toContain('生成一份可直接阅读')
    expect(prompt[0].content).toContain('输出必须是 Markdown')
    expect(prompt[0].content).toContain('selectedOptionPremium')
    expect(prompt[0].content).not.toContain('只能返回 JSON')
    const payload = JSON.parse(prompt[1].content)
    expect(payload.task).toContain('60D')
    expect(payload.reportWindowDays).toBe(60)
    expect(payload.reportRequirements).toContain('输出 Markdown 正文，不要 JSON。')
    expect(payload.reportRequirements).toContain('60 日报告必须重点解释 trend60d、trend120d、52 周位置与 MA50/MA200 的中期结构，不能只复述 30 日波动率。')
    expect(payload.reportRequirements).toContain('禁止出现 EST premium、estimated premium、估算权利金、推算权利金等表达。')
    expect(payload.rawData[0].trend20d).toBe('3.20%')
    expect(payload.marketContext.headlines[0].title).toBe('T1 test headline')
  })
})

function row(index: number): RawCompanyData {
  return {
    rank: index,
    ticker: `T${index}`,
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
    trend20d: '3.20%',
    trend60d: '8.10%',
    trend120d: '16.40%',
    distanceTo52wHigh: '-4.50%',
    distanceTo52wLow: '38.00%',
    realizedVol30d: '24.20%',
    source: {
      source: 'test',
      accessedAt: '2026-06-17T00:00:00.000Z',
      timestamp: '2026-06-17T00:00:00.000Z',
    },
  }
}
