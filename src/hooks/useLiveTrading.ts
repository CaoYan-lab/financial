import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FutuLiveOrdersResponse,
  LiveCandidatePoolHistoryFilter,
  LiveCandidatePoolItem,
  LiveOrderResult,
  LivePendingOrder,
  LivePendingOrderSideFilter,
  LivePendingOrderStatusFilter,
  LiveSignalDirectionFilter,
  LiveSignalHistoryItem,
  LiveSignalLifecycleFilter,
  LiveSkippedTicker,
  LiveTradingDashboardResponse,
  LlmRuntimeConfigResponse,
  SimulationHistoryPage,
  TradeStrategyConfigResponse,
  UpdateLlmRuntimeConfigRequest,
  UpdateTradeStrategyConfigRequest,
} from '../../shared/types'

type LiveHistoryState = {
  signals?: SimulationHistoryPage<LiveSignalHistoryItem>
  'pending-orders'?: SimulationHistoryPage<LivePendingOrder>
  'candidate-pool'?: SimulationHistoryPage<LiveCandidatePoolItem>
  'submitted-orders'?: SimulationHistoryPage<LiveOrderResult>
  skipped?: SimulationHistoryPage<LiveSkippedTicker>
}

type LiveHistoryKey = keyof LiveHistoryState

const LIVE_HISTORY_PAGE_SIZE = 12
const FUTU_ORDERS_PAGE_SIZE = 5
const AUTO_REFRESH_MS = 30_000

export function useLiveTrading() {
  const [data, setData] = useState<LiveTradingDashboardResponse>()
  const [history, setHistory] = useState<LiveHistoryState>({})
  const [historyPages, setHistoryPagesState] = useState<Record<LiveHistoryKey, number>>({
    signals: 1,
    'pending-orders': 1,
    'candidate-pool': 1,
    'submitted-orders': 1,
    skipped: 1,
  })
  const [futuOrders, setFutuOrders] = useState<FutuLiveOrdersResponse>()
  const [tradeStrategyConfig, setTradeStrategyConfig] = useState<TradeStrategyConfigResponse>()
  const [futuOrdersPage, setFutuOrdersPageState] = useState(1)
  const [pendingOrderStatusFilter, setPendingOrderStatusFilterState] = useState<LivePendingOrderStatusFilter>('ALL')
  const [pendingOrderTickerFilter, setPendingOrderTickerFilterState] = useState('ALL')
  const [pendingOrderSideFilter, setPendingOrderSideFilterState] = useState<LivePendingOrderSideFilter>('ALL')
  const [signalTickerFilter, setSignalTickerFilterState] = useState('ALL')
  const [signalDirectionFilter, setSignalDirectionFilterState] = useState<LiveSignalDirectionFilter>('ALL')
  const [signalLifecycleFilter, setSignalLifecycleFilterState] = useState<LiveSignalLifecycleFilter>('ALL')
  const [candidatePoolHistoryFilter, setCandidatePoolHistoryFilterState] = useState<LiveCandidatePoolHistoryFilter>('ACTIVE')
  const [loading, setLoading] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [confirmingOrderId, setConfirmingOrderId] = useState<string>()
  const [rejectingOrderId, setRejectingOrderId] = useState<string>()
  const [expiringPendingOrders, setExpiringPendingOrders] = useState(false)
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const dashboardRefreshInFlight = useRef(false)
  const historyPagesRef = useRef(historyPages)
  const futuOrdersPageRef = useRef(futuOrdersPage)
  const historyFiltersRef = useRef({
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    signalTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    candidatePoolHistoryFilter,
  })
  const historyRequestSeqRef = useRef<Record<LiveHistoryKey, number>>({
    signals: 0,
    'pending-orders': 0,
    'candidate-pool': 0,
    'submitted-orders': 0,
    skipped: 0,
  })

  const requestDashboard = useCallback(async (url: string, method = 'GET') => {
    setLoading(true)
    try {
      const response = await fetch(url, { method })
      if (!response.ok) throw new Error(`Live trading request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as LiveTradingDashboardResponse
      setData(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load live trading dashboard.')
      return undefined
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => requestDashboard('/api/live-trading/dashboard'), [requestDashboard])
  const start = useCallback(() => requestDashboard('/api/live-trading/start', 'POST'), [requestDashboard])
  const stop = useCallback(() => requestDashboard('/api/live-trading/stop', 'POST'), [requestDashboard])
  const runOnce = useCallback(() => requestDashboard('/api/live-trading/run-once', 'POST'), [requestDashboard])

  const loadHistory = useCallback(async (kind: LiveHistoryKey, page = 1, pageSize = LIVE_HISTORY_PAGE_SIZE) => {
    const requestSeq = historyRequestSeqRef.current[kind] + 1
    historyRequestSeqRef.current = { ...historyRequestSeqRef.current, [kind]: requestSeq }
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      const filters = historyFiltersRef.current
      if (kind === 'pending-orders') {
        params.set('status', filters.pendingOrderStatusFilter)
        params.set('ticker', filters.pendingOrderTickerFilter)
        params.set('side', filters.pendingOrderSideFilter)
      }
      if (kind === 'signals') {
        params.set('ticker', filters.signalTickerFilter)
        params.set('direction', filters.signalDirectionFilter)
        params.set('lifecycleStatus', filters.signalLifecycleFilter)
      }
      if (kind === 'candidate-pool') {
        params.set('statusGroup', filters.candidatePoolHistoryFilter)
      }
      const response = await fetch(`/api/live-trading/history/${kind}?${params.toString()}`)
      if (!response.ok) throw new Error(`Live trading history request failed with HTTP ${response.status}.`)
      const payload = await response.json()
        if (historyRequestSeqRef.current[kind] !== requestSeq) return undefined
      setHistory((current) => ({ ...current, [kind]: payload }))
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load live trading history.')
      return undefined
    }
  }, [])

  const loadFutuOrders = useCallback(async (page = 1, pageSize = FUTU_ORDERS_PAGE_SIZE) => {
    try {
      const response = await fetch(`/api/live-trading/futu-orders?page=${page}&pageSize=${pageSize}`)
      if (!response.ok) throw new Error(`Futu REAL order request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as FutuLiveOrdersResponse
      setFutuOrders(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load Futu REAL orders.')
      return undefined
    }
  }, [])

  const refreshTradeStrategyConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/live-trading/trade-strategy-config')
      if (!response.ok) throw new Error(`Live strategy config request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as TradeStrategyConfigResponse
      setTradeStrategyConfig(payload)
      await requestDashboard('/api/live-trading/dashboard')
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load live trade strategy config.')
      return undefined
    }
  }, [requestDashboard])

  const saveTradeStrategyConfig = useCallback(async (input: UpdateTradeStrategyConfigRequest) => {
    setSavingConfig(true)
    try {
      const response = await fetch('/api/live-trading/trade-strategy-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`Live strategy config request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as TradeStrategyConfigResponse
      setTradeStrategyConfig(payload)
      setData((current) => {
        if (!current?.candidatePool) return current
        const executionMode = payload.selection.executionMode
        const presetId = payload.selection.portfolioTimingPresetId ?? current.candidatePool.presetId
        const preset = current.candidatePool.timingPresets.find((item) => item.id === presetId)
        return {
          ...current,
          candidatePool: {
            ...current.candidatePool,
            executionMode,
            enabled: executionMode === 'candidate_pool',
            presetId,
            presetLabel: preset?.label ?? current.candidatePool.presetLabel,
          },
        }
      })
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save live trade strategy config.')
      return undefined
    } finally {
      setSavingConfig(false)
    }
  }, [])

  const setHistoryPage = useCallback((kind: LiveHistoryKey, page: number) => {
    const nextPage = Math.max(1, page)
    setHistoryPagesState((current) => {
      const next = { ...current, [kind]: nextPage }
      historyPagesRef.current = next
      return next
    })
    return loadHistory(kind, nextPage, LIVE_HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setFutuOrdersPage = useCallback((page: number) => {
    const nextPage = Math.max(1, page)
    setFutuOrdersPageState(nextPage)
    futuOrdersPageRef.current = nextPage
    return loadFutuOrders(nextPage, FUTU_ORDERS_PAGE_SIZE)
  }, [loadFutuOrders])

  const clearPendingOrderHistory = useCallback(() => {
    setHistory((current) => ({
      ...current,
      'pending-orders': {
        items: [],
        page: 1,
        pageSize: LIVE_HISTORY_PAGE_SIZE,
        total: 0,
        totalPages: 1,
      },
    }))
  }, [])

  const setPendingOrderStatusFilter = useCallback((status: LivePendingOrderStatusFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, pendingOrderStatusFilter: status }
    setPendingOrderStatusFilterState(status)
    clearPendingOrderHistory()
    setHistoryPagesState((current) => {
      const next = { ...current, 'pending-orders': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('pending-orders', 1, LIVE_HISTORY_PAGE_SIZE)
  }, [clearPendingOrderHistory, loadHistory])

  const setPendingOrderTickerFilter = useCallback((ticker: string) => {
    const normalizedTicker = ticker.toUpperCase()
    historyFiltersRef.current = { ...historyFiltersRef.current, pendingOrderTickerFilter: normalizedTicker }
    setPendingOrderTickerFilterState(normalizedTicker)
    clearPendingOrderHistory()
    setHistoryPagesState((current) => {
      const next = { ...current, 'pending-orders': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('pending-orders', 1, LIVE_HISTORY_PAGE_SIZE)
  }, [clearPendingOrderHistory, loadHistory])

  const setPendingOrderSideFilter = useCallback((side: LivePendingOrderSideFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, pendingOrderSideFilter: side }
    setPendingOrderSideFilterState(side)
    clearPendingOrderHistory()
    setHistoryPagesState((current) => {
      const next = { ...current, 'pending-orders': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('pending-orders', 1, LIVE_HISTORY_PAGE_SIZE)
  }, [clearPendingOrderHistory, loadHistory])

  const setSignalDirectionFilter = useCallback((direction: LiveSignalDirectionFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, signalDirectionFilter: direction }
    setSignalDirectionFilterState(direction)
    setHistoryPagesState((current) => {
      const next = { ...current, signals: 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('signals', 1, LIVE_HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setSignalTickerFilter = useCallback((ticker: string) => {
    const normalizedTicker = ticker.trim().toUpperCase() || 'ALL'
    historyFiltersRef.current = { ...historyFiltersRef.current, signalTickerFilter: normalizedTicker }
    setSignalTickerFilterState(normalizedTicker)
    setHistoryPagesState((current) => {
      const next = { ...current, signals: 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('signals', 1, LIVE_HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setSignalLifecycleFilter = useCallback((lifecycleStatus: LiveSignalLifecycleFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, signalLifecycleFilter: lifecycleStatus }
    setSignalLifecycleFilterState(lifecycleStatus)
    setHistoryPagesState((current) => {
      const next = { ...current, signals: 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('signals', 1, LIVE_HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setCandidatePoolHistoryFilter = useCallback((statusGroup: LiveCandidatePoolHistoryFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, candidatePoolHistoryFilter: statusGroup }
    setCandidatePoolHistoryFilterState(statusGroup)
    setHistoryPagesState((current) => {
      const next = { ...current, 'candidate-pool': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('candidate-pool', 1, LIVE_HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const saveLlmConfig = useCallback(async (input: UpdateLlmRuntimeConfigRequest) => {
    setSavingConfig(true)
    try {
      const response = await fetch('/api/live-trading/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`Live LLM config request failed with HTTP ${response.status}.`)
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
      setError(requestError instanceof Error ? requestError.message : 'Unable to save live LLM runtime config.')
      return undefined
    } finally {
      setSavingConfig(false)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    if (dashboardRefreshInFlight.current) return undefined
    dashboardRefreshInFlight.current = true
    setRefreshing(true)
    try {
      const payload = await refresh()
      const currentHistoryPages = historyPagesRef.current
      await Promise.all([
        loadFutuOrders(futuOrdersPageRef.current, FUTU_ORDERS_PAGE_SIZE),
        refreshTradeStrategyConfig(),
        loadHistory('signals', currentHistoryPages.signals, LIVE_HISTORY_PAGE_SIZE),
        loadHistory('pending-orders', currentHistoryPages['pending-orders'], LIVE_HISTORY_PAGE_SIZE),
        loadHistory('candidate-pool', currentHistoryPages['candidate-pool'], LIVE_HISTORY_PAGE_SIZE),
        loadHistory('submitted-orders', currentHistoryPages['submitted-orders'], LIVE_HISTORY_PAGE_SIZE),
        loadHistory('skipped', currentHistoryPages.skipped, LIVE_HISTORY_PAGE_SIZE),
      ])
      return payload
    } finally {
      dashboardRefreshInFlight.current = false
      setRefreshing(false)
    }
  }, [loadFutuOrders, loadHistory, refresh, refreshTradeStrategyConfig])

  const confirmOrder = useCallback(async (id: string) => {
    setConfirmingOrderId(id)
    try {
      const response = await fetch(`/api/live-trading/pending-orders/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationId: `CONF-${Date.now()}` }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Live order confirmation failed with HTTP ${response.status}.`)
      setError(undefined)
      await refreshAll()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to confirm live order.')
      return undefined
    } finally {
      setConfirmingOrderId(undefined)
    }
  }, [refreshAll])

  const rejectOrder = useCallback(async (id: string) => {
    setRejectingOrderId(id)
    try {
      const response = await fetch(`/api/live-trading/pending-orders/${id}/reject`, { method: 'POST' })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Live order reject failed with HTTP ${response.status}.`)
      setError(undefined)
      await refreshAll()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to reject live order.')
      return undefined
    } finally {
      setRejectingOrderId(undefined)
    }
  }, [refreshAll])

  const batchExpirePendingOrders = useCallback(async (input: { ticker?: string; side?: LivePendingOrderSideFilter; ids?: string[] } = {}) => {
    setExpiringPendingOrders(true)
    try {
      const response = await fetch('/api/live-trading/pending-orders/batch-expire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Live order batch expire failed with HTTP ${response.status}.`)
      setError(undefined)
      await refreshAll()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to batch expire live orders.')
      return undefined
    } finally {
      setExpiringPendingOrders(false)
    }
  }, [refreshAll])

  const updateAutoSubmit = useCallback(async (autoSubmitEnabled: boolean) => {
    setSavingSettings(true)
    try {
      const response = await fetch('/api/live-trading/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSubmitEnabled }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Futu live settings update failed with HTTP ${response.status}.`)
      await refreshAll()
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Futu 自动下单开关更新失败。')
      return undefined
    } finally {
      setSavingSettings(false)
    }
  }, [refreshAll])

  useEffect(() => {
    refreshAll().catch(() => undefined)
  }, [refreshAll])

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshAll().catch(() => undefined)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refreshAll])

  return {
    data,
    history,
    tradeStrategyConfig,
    historyPages,
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    signalTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    candidatePoolHistoryFilter,
    futuOrders,
    futuOrdersPage,
    loading,
    savingConfig,
    savingSettings,
    confirmingOrderId,
    rejectingOrderId,
    expiringPendingOrders,
    refreshing,
    error,
    refresh: refreshAll,
    start,
    stop,
    runOnce,
    loadHistory,
    loadFutuOrders,
    refreshTradeStrategyConfig,
    setHistoryPage,
    setPendingOrderStatusFilter,
    setPendingOrderTickerFilter,
    setPendingOrderSideFilter,
    setSignalTickerFilter,
    setSignalDirectionFilter,
    setSignalLifecycleFilter,
    setCandidatePoolHistoryFilter,
    setFutuOrdersPage,
    saveLlmConfig,
    saveTradeStrategyConfig,
    confirmOrder,
    rejectOrder,
    batchExpirePendingOrders,
    updateAutoSubmit,
  }
}
