import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FutuSimulationOrdersResponse,
  LlmRuntimeConfigResponse,
  QuantSignal,
  SimulatedOrderResult,
  SimulationDashboardResponse,
  SimulationHistoryPage,
  SimulationSkippedTicker,
  TradeStrategyConfigResponse,
  UpdateLlmRuntimeConfigRequest,
  UpdateTradeStrategyConfigRequest,
} from '../../shared/types'

type SimulationHistoryState = {
  signals?: SimulationHistoryPage<QuantSignal>
  orders?: SimulationHistoryPage<SimulatedOrderResult>
  skipped?: SimulationHistoryPage<SimulationSkippedTicker>
}

const AUTO_REFRESH_MS = 30_000

export function useSimulationTrading() {
  const [data, setData] = useState<SimulationDashboardResponse>()
  const [history, setHistory] = useState<SimulationHistoryState>({})
  const [futuOrders, setFutuOrders] = useState<FutuSimulationOrdersResponse>()
  const [tradeStrategyConfig, setTradeStrategyConfig] = useState<TradeStrategyConfigResponse>()
  const [loading, setLoading] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>()
  const dashboardRefreshInFlight = useRef(false)
  const historyRefreshInFlight = useRef(false)

  const request = useCallback(async (url: string, method = 'GET') => {
    setLoading(true)
    try {
      const response = await fetch(url, { method })
      if (!response.ok) throw new Error(`Simulation request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as SimulationDashboardResponse
      setData(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load simulation dashboard.')
      return undefined
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => request('/api/simulation/dashboard'), [request])
  const start = useCallback(() => request('/api/simulation/start', 'POST'), [request])
  const stop = useCallback(() => request('/api/simulation/stop', 'POST'), [request])
  const runOnce = useCallback(() => request('/api/simulation/run-once', 'POST'), [request])
  const loadHistory = useCallback(async (kind: keyof SimulationHistoryState, page = 1, pageSize = 12) => {
    try {
      const response = await fetch(`/api/simulation/history/${kind}?page=${page}&pageSize=${pageSize}`)
      if (!response.ok) throw new Error(`Simulation history request failed with HTTP ${response.status}.`)
      const payload = await response.json()
      setHistory((current) => ({ ...current, [kind]: payload }))
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load simulation history.')
      return undefined
    }
  }, [])
  const loadFutuOrders = useCallback(async (page = 1, pageSize = 12) => {
    try {
      const response = await fetch(`/api/simulation/futu-orders?page=${page}&pageSize=${pageSize}`)
      if (!response.ok) throw new Error(`Futu order request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as FutuSimulationOrdersResponse
      setFutuOrders(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load Futu simulation orders.')
      return undefined
    }
  }, [])

  const refreshTradeStrategyConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/simulation/trade-strategy-config')
      if (!response.ok) throw new Error(`Simulation strategy config request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as TradeStrategyConfigResponse
      setTradeStrategyConfig(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load simulation trade strategy config.')
      return undefined
    }
  }, [])

  const saveTradeStrategyConfig = useCallback(async (input: UpdateTradeStrategyConfigRequest) => {
    setSavingConfig(true)
    try {
      const response = await fetch('/api/simulation/trade-strategy-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`Simulation strategy config request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as TradeStrategyConfigResponse
      setTradeStrategyConfig(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save simulation trade strategy config.')
      return undefined
    } finally {
      setSavingConfig(false)
    }
  }, [])

  const saveLlmConfig = useCallback(async (input: UpdateLlmRuntimeConfigRequest) => {
    setSavingConfig(true)
    try {
      const response = await fetch('/api/simulation/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`LLM config request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as LlmRuntimeConfigResponse
      setData((current) =>
        current
          ? {
              ...current,
              llmRuntimeConfig: payload.config,
              modelOptions: payload.modelOptions,
              warnings: [...current.warnings, ...payload.warnings],
            }
          : current,
      )
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save LLM runtime config.')
      return undefined
    } finally {
      setSavingConfig(false)
    }
  }, [])

  const refreshDashboardAndOrders = useCallback(async () => {
    if (dashboardRefreshInFlight.current) return undefined
    dashboardRefreshInFlight.current = true
    try {
      const payload = await refresh()
      await loadFutuOrders(futuOrders?.page ?? 1)
      return payload
    } finally {
      dashboardRefreshInFlight.current = false
    }
  }, [futuOrders?.page, loadFutuOrders, refresh])

  const refreshHistoryPages = useCallback(async () => {
    if (historyRefreshInFlight.current) return undefined
    historyRefreshInFlight.current = true
    try {
      await Promise.all([
        loadHistory('signals', history.signals?.page ?? 1),
        loadHistory('orders', history.orders?.page ?? 1),
        loadHistory('skipped', history.skipped?.page ?? 1),
      ])
      setLastRefreshedAt(new Date().toISOString())
      return true
    } finally {
      historyRefreshInFlight.current = false
    }
  }, [history.orders?.page, history.signals?.page, history.skipped?.page, loadHistory])

  const refreshAll = useCallback(async (options: { includeHistory?: boolean } = {}) => {
    const includeHistory = options.includeHistory ?? true
    setRefreshing(true)
    try {
      const [dashboardResult] = await Promise.allSettled([refreshDashboardAndOrders(), refreshTradeStrategyConfig(), includeHistory ? refreshHistoryPages() : Promise.resolve(undefined)])
      return dashboardResult.status === 'fulfilled' ? dashboardResult.value : undefined
    } finally {
      setRefreshing(false)
    }
  }, [refreshDashboardAndOrders, refreshHistoryPages, refreshTradeStrategyConfig])

  useEffect(() => {
    refreshAll().catch(() => undefined)
  }, [refreshAll])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const engineRunning = data?.engine.running === true
      refreshAll({ includeHistory: engineRunning }).catch(() => undefined)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [data?.engine.running, refreshAll])

  return { data, history, futuOrders, tradeStrategyConfig, loading, savingConfig, refreshing, lastRefreshedAt, error, refresh: refreshAll, start, stop, runOnce, loadHistory, loadFutuOrders, refreshTradeStrategyConfig, saveLlmConfig, saveTradeStrategyConfig }
}
