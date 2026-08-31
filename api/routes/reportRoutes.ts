import { Router } from 'express'
import type { ReportGenerationResult } from '../../shared/types.js'
import { FutuOpenDProvider } from '../providers/futuOpenDProvider.js'
import { analyzeCompanies } from '../services/analysisService.js'
import { generateLlmMarkdownReport } from '../services/llmReportAnalysisService.js'
import { collectRawData } from '../services/marketDataService.js'
import { collectReportMarketContext } from '../services/reportMarketContextService.js'
import { reportPersistence } from '../services/reportPersistence.js'
import { getReportPromptArchive } from '../services/reportPromptArchive.js'
import { renderMarkdownReport } from '../services/reportRenderer.js'
import { getLlmRuntimeConfig } from '../simulation/llmRuntimeConfigService.js'
import { durationMs, logger } from '../utils/logger.js'

const router = Router()
let latestReport: ReportGenerationResult | undefined
let activeReportBatchId: string | undefined

export function getLatestReport(): ReportGenerationResult | undefined {
  return latestReport
}

router.post('/generate', async (req, res, next) => {
  const startedAt = performance.now()
  const batchId = `batch-${Date.now()}`
  if (activeReportBatchId) {
    res.status(409).json({
      message: 'report_generation_in_progress',
      batchId: activeReportBatchId,
    })
    return
  }
  activeReportBatchId = batchId
  try {
    logger.info({ event: 'report.generate.started', batchId }, 'Top30 report generation started')
    const provider = new FutuOpenDProvider()
    logger.info({ event: 'report.generate.raw_data.started', batchId }, 'Top30 report raw data collection started')
    const { generatedAt, rawData, dataQuality } = await collectRawData(provider, batchId, req.body?.asOfDate)
    logger.info(
      {
        event: 'report.generate.raw_data.succeeded',
        batchId,
        rowCount: rawData.length,
        durationMs: durationMs(startedAt),
        unavailableSummary: dataQuality.unavailableSummary,
      },
      'Top30 report raw data collection succeeded',
    )
    const analysis = analyzeCompanies(batchId, generatedAt, rawData)
    const runtimeConfig = getLlmRuntimeConfig().config
    logger.info({ event: 'report.generate.market_context.started', batchId }, 'Top30 report market context collection started')
    const marketContext = await collectReportMarketContext(rawData)
    logger.info(
      {
        event: 'report.generate.market_context.succeeded',
        batchId,
        headlineCount: marketContext.headlines.length,
        warningCount: marketContext.warnings.length,
        durationMs: durationMs(startedAt),
      },
      'Top30 report market context collection succeeded',
    )
    const reportBase = {
      batchId,
      generatedAt,
      rawData,
      dataQuality,
      analysis,
      analysisModel: {
        model: runtimeConfig.model,
        modelLabel: runtimeConfig.modelLabel,
        provider: 'ark' as const,
        generatedBy: 'llm' as const,
      },
    }
    logger.info(
      { event: 'report.generate.llm_markdown.started', batchId, model: runtimeConfig.model, modelLabel: runtimeConfig.modelLabel },
      'Top30 report LLM Markdown generation started',
    )
    const markdown = await generateLlmMarkdownReport({
      batchId,
      generatedAt,
      rawData,
      dataQuality,
      baselineAnalysis: analysis,
      marketContext,
    })
    logger.info(
      { event: 'report.generate.llm_markdown.succeeded', batchId, markdownLength: markdown.length, durationMs: durationMs(startedAt) },
      'Top30 report LLM Markdown generation succeeded',
    )
    latestReport = { ...reportBase, markdown }
    reportPersistence.appendReport(latestReport, getReportPromptArchive())
    logger.info(
      { event: 'report.generate.completed', batchId, durationMs: durationMs(startedAt), model: runtimeConfig.model },
      'Top30 report generation completed',
    )

    res.json(latestReport)
  } catch (error) {
    next(error)
  } finally {
    if (activeReportBatchId === batchId) activeReportBatchId = undefined
  }
})

router.get('/latest', (_req, res) => {
  if (!latestReport) {
    latestReport = reportPersistence.readLatestReport()
  }

  if (!latestReport) {
    res.json({ message: 'unavailable' })
    return
  }

  res.json(latestReport)
})

router.get('/history', (req, res) => {
  const page = Number(req.query.page ?? 1)
  const pageSize = Number(req.query.pageSize ?? 10)
  res.json(reportPersistence.paginateReports(page, pageSize))
})

router.get('/top-opportunities/latest', (_req, res) => {
  res.json({ items: reportPersistence.readLatestTopOpportunities() })
})

router.get('/top-opportunities/history', (req, res) => {
  const page = Number(req.query.page ?? 1)
  const pageSize = Number(req.query.pageSize ?? 10)
  res.json(reportPersistence.paginateTopOpportunityGroups(page, pageSize))
})

router.get('/prompt', (_req, res) => {
  res.json(getReportPromptArchive())
})

router.get('/history/:batchId', (req, res) => {
  const report = reportPersistence.getReportByBatchId(req.params.batchId)
  if (!report) {
    res.status(404).json({ message: 'not_found' })
    return
  }
  res.json(report)
})

router.post('/render', (req, res, next) => {
  try {
    const batchId = `render-${Date.now()}`
    const generatedAt = new Date().toISOString()
    const rawData = req.body?.rawData ?? []
    const dataQuality = req.body?.dataQuality
    const analysis = analyzeCompanies(batchId, generatedAt, rawData)
    const markdown = renderMarkdownReport({ batchId, generatedAt, rawData, dataQuality, analysis })

    res.json({ batchId, generatedAt, rawData, dataQuality, analysis, markdown })
  } catch (error) {
    next(error)
  }
})

export default router
