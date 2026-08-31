import { useCallback, useEffect, useState } from 'react'
import type { ReportHistoryPage } from '../../shared/types'

export function useReportHistory(initialPage = 1, initialPageSize = 10) {
  const [page, setPage] = useState(initialPage)
  const [pageSize] = useState(initialPageSize)
  const [data, setData] = useState<ReportHistoryPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(`/api/report/history?page=${page}&pageSize=${pageSize}`)
      if (!response.ok) throw new Error(`Report history failed with HTTP ${response.status}.`)
      setData((await response.json()) as ReportHistoryPage)
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Unable to load report history.')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  return { data, page, pageSize, loading, error, setPage, refresh }
}
