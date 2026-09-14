import type { DataProvider } from '../providers/DataProvider.js'
import { buildDataQualityReport } from '../utils/dataIntegrity.js'
import { lockTopThirtyUniverse } from './universeService.js'

export async function collectRawData(provider: DataProvider, batchId: string, asOfDate?: string) {
  const universe = await provider.fetchUniverse(asOfDate)
  const lockedUniverse = lockTopThirtyUniverse(universe)
  const marketBundle = await provider.fetchMarketSnapshot(lockedUniverse)
  const generatedAt = new Date().toISOString()
  const dataQuality = buildDataQualityReport(batchId, generatedAt, marketBundle.rows, [marketBundle.source])
  if (!dataQuality.isUsableForAnalysis) {
    const blockingIssues = dataQuality.issues
      .filter((issue) => issue.severity === 'blocking')
      .map((issue) => issue.issue)
      .join('; ')
    throw new Error(`报告数据不可用：${blockingIssues || '关键行情字段缺失'}`)
  }

  return {
    generatedAt,
    rawData: marketBundle.rows,
    dataQuality,
    warnings: marketBundle.warnings,
  }
}
