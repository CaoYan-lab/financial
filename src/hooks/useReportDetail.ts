import { useCallback, useEffect, useState } from 'react'
import type { ReportGenerationResult } from '../../shared/types'

export function useReportDetail(batchId?: string) {
  const [report, setReport] = useState<ReportGenerationResult>()
  const [loading, setLoading] = useState(Boolean(batchId))
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    if (!batchId) return
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(`/api/report/history/${encodeURIComponent(batchId)}`)
      if (!response.ok) throw new Error(response.status === 404 ? '报告不存在。' : `Report detail failed with HTTP ${response.status}.`)
      setReport((await response.json()) as ReportGenerationResult)
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : 'Unable to load report detail.')
    } finally {
      setLoading(false)
    }
  }, [batchId])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  return { report, loading, error, refresh }
}
