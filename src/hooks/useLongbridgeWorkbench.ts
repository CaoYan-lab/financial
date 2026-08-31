import { useCallback, useEffect, useState } from 'react'
import type { LongbridgeWorkbenchDashboardResponse } from '../../shared/longbridgeTypes'

export function useLongbridgeWorkbench() {
  const [dashboard, setDashboard] = useState<LongbridgeWorkbenchDashboardResponse>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch('/api/longbridge/workbench/dashboard')
      if (!response.ok) throw new Error(`Longbridge dashboard failed with HTTP ${response.status}`)
      setDashboard((await response.json()) as LongbridgeWorkbenchDashboardResponse)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load Longbridge workbench.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { dashboard, loading, error, refresh }
}
