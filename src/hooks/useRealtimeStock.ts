import { useCallback, useEffect, useState } from 'react'
import type { RealtimeStockResponse, RealtimeSubscriptionStatus } from '../../shared/types'

export function useRealtimeStock(ticker: string | undefined) {
  const [data, setData] = useState<RealtimeStockResponse>()
  const [status, setStatus] = useState<RealtimeSubscriptionStatus>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const normalizedTicker = (ticker || 'GOOG').toUpperCase()

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/realtime/${normalizedTicker}`)
      if (!response.ok) throw new Error(`Realtime request failed with HTTP ${response.status}.`)
      setData((await response.json()) as RealtimeStockResponse)
      setError(undefined)
    } catch (realtimeError) {
      setError(realtimeError instanceof Error ? realtimeError.message : 'Unable to load realtime data.')
    }
  }, [normalizedTicker])

  const subscribeTop30 = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/realtime/subscribe-top30', { method: 'POST' })
      if (!response.ok) throw new Error(`Realtime subscription failed with HTTP ${response.status}.`)
      setStatus((await response.json()) as RealtimeSubscriptionStatus)
      setError(undefined)
    } catch (subscribeError) {
      setError(subscribeError instanceof Error ? subscribeError.message : 'Unable to start realtime subscription.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    subscribeTop30().then(refresh).catch(() => undefined)
  }, [refresh, subscribeTop30])

  useEffect(() => {
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh])

  return { data, status, loading, error, refresh, subscribeTop30 }
}
