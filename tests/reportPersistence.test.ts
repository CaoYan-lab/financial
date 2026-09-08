import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeCompanies } from '../api/services/analysisService'
import { getReportPromptArchive } from '../api/services/reportPromptArchive'
import { renderMarkdownReport } from '../api/services/reportRenderer'
import type { DataQualityReport, RawCompanyData, ReportGenerationResult } from '../shared/types'

let tempDir: string
let previousPersistTest: string | undefined
let previousDbPath: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'top30-report-history-'))
  previousPersistTest = process.env.REPORT_PERSIST_TEST
  previousDbPath = process.env.REPORT_HISTORY_DB_PATH
  process.env.REPORT_PERSIST_TEST = '1'
  process.env.REPORT_HISTORY_DB_PATH = join(tempDir, 'report-history.sqlite3')
  vi.resetModules()
})

afterEach(() => {
  if (previousPersistTest === undefined) delete process.env.REPORT_PERSIST_TEST
  else process.env.REPORT_PERSIST_TEST = previousPersistTest
  if (previousDbPath === undefined) delete process.env.REPORT_HISTORY_DB_PATH
  else process.env.REPORT_HISTORY_DB_PATH = previousDbPath
  rmSync(tempDir, { recursive: true, force: true })
  vi.resetModules()
})

describe('reportPersistence', { timeout: 30_000 }, () => {
  it('持久化报告并维护 Top5 独立映射', async () => {
    const { reportPersistence } = await import('../api/services/reportPersistence')
    reportPersistence.clearForTests()

    const first = report('batch-a', '2026-06-17T10:00:00.000Z')
    const second = report('batch-b', '2026-06-17T11:00:00.000Z')
    reportPersistence.appendReport(first, getReportPromptArchive())
    reportPersistence.appendReport(second, getReportPromptArchive())

    expect(reportPersistence.readLatestReport()?.batchId).toBe('batch-b')

    const page = reportPersistence.paginateReports(1, 1)
    expect(page.total).toBe(2)
    expect(page.items[0].batchId).toBe('batch-b')
    expect(page.items[0].reportWindowDays).toBe(60)
    expect(page.items[0].rawRowCount).toBe(30)
    expect(page.items[0].topOpportunityTickers).toHaveLength(5)

    const latestTop5 = reportPersistence.readLatestTopOpportunities()
    expect(latestTop5).toHaveLength(5)
    expect(latestTop5[0].batchId).toBe('batch-b')
    expect(latestTop5[0].reportId).toBe(page.items[0].id)
    expect(latestTop5[0].opportunityRank).toBe(1)

    const groups = reportPersistence.paginateTopOpportunityGroups(1, 2)
    expect(groups.items).toHaveLength(2)
    expect(groups.items[0].report.batchId).toBe('batch-b')
    expect(groups.items[0].opportunities).toHaveLength(5)

    const firstDetail = reportPersistence.getReportByBatchId('batch-a')
    expect(firstDetail?.batchId).toBe('batch-a')
    expect(firstDetail?.reportWindowDays).toBe(30)
  })
})

function report(batchId: string, generatedAt: string): ReportGenerationResult {
  const rawData = Array.from({ length: 30 }, (_, index) => row(index + 1))
  const dataQuality: DataQualityReport = {
    batchId,
    generatedAt,
    sources: [rawData[0].source],
    unavailableSummary: {},
    issues: [],
    isUsableForAnalysis: true,
  }
  const analysis = analyzeCompanies(batchId, generatedAt, rawData)
  const base = { batchId, generatedAt, rawData, dataQuality, analysis }
  const reportWindowDays = batchId === 'batch-b' ? 60 : 30
  return { ...base, reportWindowDays, markdown: renderMarkdownReport({ ...base, reportWindowDays }) }
}

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
    source: {
      source: 'test',
      accessedAt: '2026-06-17T00:00:00.000Z',
      timestamp: '2026-06-17T00:00:00.000Z',
    },
  }
}
