import { useCallback, useEffect, useState } from 'react'
import type { TopOpportunityHistoryPage } from '../../shared/types'

export function useTopOpportunityHistory(initialPage = 1, initialPageSize = 10) {
  const [page, setPage] = useState(initialPage)
  const [pageSize] = useState(initialPageSize)
  const [data, setData] = useState<TopOpportunityHistoryPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(`/api/report/top-opportunities/history?page=${page}&pageSize=${pageSize}`)
      if (!response.ok) throw new Error(`Top opportunity history failed with HTTP ${response.status}.`)
      setData((await response.json()) as TopOpportunityHistoryPage)
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Unable to load Top5 history.')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  return { data, page, pageSize, loading, error, setPage, refresh }
}
