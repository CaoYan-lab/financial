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
const REPORT_GENERATION_TIMEOUT_MS = 360_000

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
        signal: AbortSignal.timeout(REPORT_GENERATION_TIMEOUT_MS),
        body: JSON.stringify({
          outputLanguageMode: 'zh-en',
          universeSourcePriority: ['stockanalysis', 'companiesmarketcap'],
        }),
      })

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => undefined)
        const message = errorPayload && typeof errorPayload === 'object' && 'message' in errorPayload ? String(errorPayload.message) : `Report generation failed with HTTP ${response.status}.`
        throw new Error(message)
      }

      const payload = (await response.json()) as ReportGenerationResult
      setReport(payload)
      setGenerationStatus(`报告生成完成：${payload.analysisModel?.modelLabel ?? 'LLM'} · ${payload.batchId}`)
      await refreshReportSummaries()
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unknown report generation error.')
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
