import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ReportGenerationResult,
  ReportHistoryPage,
  ReportPromptArchive,
  SourceStatusResponse,
  TopOpportunitySnapshot,
} from '../../shared/types'
import { useReportStore } from '@/stores/reportStore'

const SUMMARY_REQUEST_TIMEOUT_MS = 12_000
const REPORT_REQUEST_TIMEOUT_MS = 15_000
const REPORT_POLL_INTERVAL_MS = 2_000
const REPORT_POLL_TIMEOUT_MS = 15 * 60_000

type ReportJobAccepted = {
  jobId: string
  batchId: string
  status: 'queued'
}

type ReportJobStatus = {
  success: boolean
  status: string
  batchId?: string
  error?: string
  report?: ReportGenerationResult
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => undefined)
  if (payload && typeof payload === 'object') {
    if ('message' in payload && typeof payload.message === 'string') return payload.message
    if ('error' in payload && typeof payload.error === 'string') return payload.error
  }
  return fallback
}

async function waitForReport(jobId: string, onStatus: (status: string) => void): Promise<ReportGenerationResult> {
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REPORT_POLL_INTERVAL_MS))
    const response = await fetch(`/api/report/jobs/${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(await responseError(response, `查询报告生成进度失败（HTTP ${response.status}）`))
    }
    const payload = (await response.json()) as ReportJobStatus
    if (payload.status === 'succeeded' && payload.report) return payload.report
    if (payload.status === 'failed') throw new Error(payload.error || '报告生成失败')
    onStatus(payload.status === 'running' ? '正在生成报告，请保持页面打开。' : '报告任务已排队，正在等待处理。')
  }
  throw new Error('报告仍在后台生成，请稍后刷新报告历史。')
}

export function useReportGeneration() {
  const generatingRef = useRef(false)
  const [generationStatus, setGenerationStatus] = useState<string>()
  const {
    report,
    recentReports,
    promptArchive,
    latestTopOpportunities,
    sourceStatus,
    isGenerating,
    error,
    setReport,
    setRecentReports,
    setPromptArchive,
    setLatestTopOpportunities,
    setSourceStatus,
    setGenerating,
    setError,
  } = useReportStore()

  const refreshStatus = useCallback(async () => {
    const response = await fetch('/api/source/status', { signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS) })
    const payload = (await response.json()) as SourceStatusResponse
    setSourceStatus(payload)
  }, [setSourceStatus])

  const refreshReportSummaries = useCallback(async () => {
    const [latestResponse, historyResponse, topResponse, promptResponse] = await Promise.all([
      fetch('/api/report/latest', { signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS) }),
      fetch('/api/report/history?page=1&pageSize=3', { signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS) }),
      fetch('/api/report/top-opportunities/latest', { signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS) }),
      fetch('/api/report/prompt', { signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS) }),
    ])

    if (latestResponse.ok) {
      const latestPayload = (await latestResponse.json()) as ReportGenerationResult | { message: 'unavailable' }
      if (!('message' in latestPayload)) setReport(latestPayload)
    }

    if (historyResponse.ok) {
      const historyPayload = (await historyResponse.json()) as ReportHistoryPage
      setRecentReports(historyPayload.items)
    }

    if (topResponse.ok) {
      const topPayload = (await topResponse.json()) as { items: TopOpportunitySnapshot[] }
      setLatestTopOpportunities(topPayload.items)
    }

    if (promptResponse.ok) {
      const promptPayload = (await promptResponse.json()) as ReportPromptArchive
      setPromptArchive(promptPayload)
    }
  }, [setLatestTopOpportunities, setPromptArchive, setRecentReports, setReport])

  const generateReport = useCallback(async () => {
    if (generatingRef.current) return
    generatingRef.current = true
    setGenerating(true)
    setError(undefined)
    setGenerationStatus('正在采集 Futu Top30 数据、历史趋势、市场资讯，并调用大模型生成报告，通常需要 1-2 分钟。')

    try {
      const response = await fetch('/api/report/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          outputLanguageMode: 'zh-en',
          universeSourcePriority: ['stockanalysis', 'companiesmarketcap'],
        }),
      })

      if (!response.ok) {
        throw new Error(await responseError(response, `报告生成请求失败（HTTP ${response.status}）`))
      }

      const initialPayload = (await response.json()) as ReportGenerationResult | ReportJobAccepted
      const report = response.status === 202 && 'jobId' in initialPayload
        ? await waitForReport(initialPayload.jobId, setGenerationStatus)
        : initialPayload as ReportGenerationResult
      setReport(report)
      setGenerationStatus(`报告生成完成：${report.analysisModel?.modelLabel ?? '大模型'} · ${report.batchId}`)
      await refreshReportSummaries()
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : '报告生成失败')
      setGenerationStatus(undefined)
    } finally {
      generatingRef.current = false
      setGenerating(false)
    }
  }, [refreshReportSummaries, setError, setGenerating, setReport])

  useEffect(() => {
    Promise.all([refreshStatus(), refreshReportSummaries()]).catch((statusError) => {
      setError(statusError instanceof Error ? statusError.message : 'Unable to load source status.')
    })
  }, [refreshReportSummaries, refreshStatus, setError])

  return {
    report,
    recentReports,
    promptArchive,
    latestTopOpportunities,
    sourceStatus,
    isGenerating,
    generationStatus,
    error,
    refreshStatus,
    refreshReportSummaries,
    generateReport,
  }
}
