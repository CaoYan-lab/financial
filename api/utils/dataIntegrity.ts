import { UNAVAILABLE } from '../../shared/constants.js'
import type { DataQualityIssue, DataQualityReport, DataSourceCitation, RawCompanyData } from '../../shared/types.js'

const rawFields: Array<keyof RawCompanyData> = [
  'currentPrice',
  'marketCap',
  'peRatio',
  'rsi14',
  'ma50',
  'ma200',
  'ivRank',
  'iv30',
  'nextEarningsDate',
  'capitalPerContract',
  'sevenDayNews',
]

export function buildDataQualityReport(
  batchId: string,
  generatedAt: string,
  rows: RawCompanyData[],
  sources: DataSourceCitation[],
): DataQualityReport {
  const unavailableSummary: Record<string, number> = {}
  const issues: DataQualityIssue[] = []

  if (rows.length !== 30) {
    issues.push({
      field: 'rawData',
      issue: `Expected exactly 30 rows, received ${rows.length}.`,
      severity: 'blocking',
    })
  }

  for (const row of rows) {
    for (const field of rawFields) {
      if (String(row[field]).toLowerCase().includes(UNAVAILABLE)) {
        unavailableSummary[field] = (unavailableSummary[field] ?? 0) + 1
        issues.push({
          ticker: row.ticker,
          field,
          issue: `${field} is unavailable.`,
          severity: 'info',
        })
      }
    }
  }

  const marketSources = new Set(rows.map((row) => row.source.source))
  if (marketSources.size > 1) {
    issues.push({
      field: 'source',
      issue: 'Rows contain multiple market data sources.',
      severity: 'warning',
    })
  }

  return {
    batchId,
    generatedAt,
    sources,
    unavailableSummary,
    issues,
    isUsableForAnalysis: !issues.some((issue) => issue.severity === 'blocking'),
  }
}

