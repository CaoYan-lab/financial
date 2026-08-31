import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LiveCandidatePoolHistoryFilter,
  LiveCandidatePoolItem,
  LivePendingOrder,
  LivePendingOrderSideFilter,
  LivePendingOrderStatusFilter,
  LiveSignalDirectionFilter,
  LiveSignalHistoryItem,
  LiveSignalLifecycleFilter,
  SimulationHistoryPage,
} from '../../shared/types'
import type { LongbridgeLiveRunOnceResponse, LongbridgeLiveTradingDashboardResponse } from '../../shared/longbridgeTypes'

type LongbridgeHistoryState = {
  signals?: SimulationHistoryPage<LiveSignalHistoryItem>
  'pending-orders'?: SimulationHistoryPage<LivePendingOrder>
  'candidate-pool'?: SimulationHistoryPage<LiveCandidatePoolItem>
}

type LongbridgeHistoryKey = keyof LongbridgeHistoryState

const HISTORY_PAGE_SIZE = 12
const AUTO_REFRESH_MS = 30_000

export function useLongbridgeLiveTrading() {
  const [data, setData] = useState<LongbridgeLiveTradingDashboardResponse>()
  const [history, setHistory] = useState<LongbridgeHistoryState>({})
  const [historyPages, setHistoryPagesState] = useState<Record<LongbridgeHistoryKey, number>>({
    signals: 1,
    'pending-orders': 1,
    'candidate-pool': 1,
  })
  const [pendingOrderStatusFilter, setPendingOrderStatusFilterState] = useState<LivePendingOrderStatusFilter>('ALL')
  const [pendingOrderTickerFilter, setPendingOrderTickerFilterState] = useState('ALL')
  const [pendingOrderSideFilter, setPendingOrderSideFilterState] = useState<LivePendingOrderSideFilter>('ALL')
  const [signalTickerFilter, setSignalTickerFilterState] = useState('ALL')
  const [signalDirectionFilter, setSignalDirectionFilterState] = useState<LiveSignalDirectionFilter>('ALL')
  const [signalLifecycleFilter, setSignalLifecycleFilterState] = useState<LiveSignalLifecycleFilter>('ALL')
  const [candidatePoolHistoryFilter, setCandidatePoolHistoryFilterState] = useState<LiveCandidatePoolHistoryFilter>('ACTIVE')
  const [lastRun, setLastRun] = useState<LongbridgeLiveRunOnceResponse>()
  const [confirmingOrderId, setConfirmingOrderId] = useState<string>()
  const [rejectingOrderId, setRejectingOrderId] = useState<string>()
  const [expiringPendingOrders, setExpiringPendingOrders] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [running, setRunning] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const dashboardRefreshInFlight = useRef(false)
  const historyPagesRef = useRef(historyPages)
  const historyFiltersRef = useRef({
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    signalTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    candidatePoolHistoryFilter,
  })
  const historyRequestSeqRef = useRef<Record<LongbridgeHistoryKey, number>>({
    signals: 0,
    'pending-orders': 0,
    'candidate-pool': 0,
  })

  const refreshDashboard = useCallback(async () => {
    const response = await fetch('/api/longbridge/live-trading/dashboard')
    const payload = await response.json()
    if (!response.ok) throw new Error(payload?.error ?? `Longbridge live dashboard request failed with HTTP ${response.status}.`)
    setData(payload as LongbridgeLiveTradingDashboardResponse)
    setError(undefined)
    return payload as LongbridgeLiveTradingDashboardResponse
  }, [])

  const loadHistory = useCallback(async (kind: LongbridgeHistoryKey, page = 1, pageSize = HISTORY_PAGE_SIZE) => {
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
      const response = await fetch(`/api/longbridge/live-trading/history/${kind}?${params.toString()}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge live history request failed with HTTP ${response.status}.`)
      if (historyRequestSeqRef.current[kind] !== requestSeq) return undefined
      setHistory((current) => ({ ...current, [kind]: payload }))
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥实盘历史加载失败。')
      return undefined
    }
  }, [])

  const refreshAll = useCallback(async () => {
    if (dashboardRefreshInFlight.current) return undefined
    dashboardRefreshInFlight.current = true
    setRefreshing(true)
    try {
      const payload = await refreshDashboard()
      const currentHistoryPages = historyPagesRef.current
      await Promise.all([
        loadHistory('signals', currentHistoryPages.signals, HISTORY_PAGE_SIZE),
        loadHistory('pending-orders', currentHistoryPages['pending-orders'], HISTORY_PAGE_SIZE),
        loadHistory('candidate-pool', currentHistoryPages['candidate-pool'], HISTORY_PAGE_SIZE),
      ])
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥实盘状态加载失败。')
      return undefined
    } finally {
      dashboardRefreshInFlight.current = false
      setRefreshing(false)
    }
  }, [loadHistory, refreshDashboard])

  const runOnce = useCallback(async (symbol = 'AAPL.US') => {
    setRunning(true)
    setError(undefined)
    try {
      const response = await fetch('/api/longbridge/live-trading/run-once', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge live run-once request failed with HTTP ${response.status}.`)
      const result = payload as LongbridgeLiveRunOnceResponse
      setLastRun(result)
      await refreshAll()
      if (!result.ok) {
        const marketDataReason = result.marketData?.ok === false ? result.marketData.reason : undefined
        setError(result.decision?.reason ?? result.warnings[0] ?? marketDataReason ?? '长桥实盘评估未通过。')
      }
      return result
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥实盘评估请求失败。')
      return undefined
    } finally {
      setRunning(false)
    }
  }, [refreshAll])

  const start = useCallback(async () => {
    setRunning(true)
    setError(undefined)
    try {
      const response = await fetch('/api/longbridge/live-trading/start', { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge live start request failed with HTTP ${response.status}.`)
      const result = payload as LongbridgeLiveTradingDashboardResponse
      setData(result)
      await refreshAll()
      if (!result.engine.running && result.engine.lastError) setError(result.engine.lastError)
      return result
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥实盘评估启动失败。')
      return undefined
    } finally {
      setRunning(false)
    }
  }, [refreshAll])

  const stop = useCallback(async () => {
    setRunning(true)
    setError(undefined)
    try {
      const response = await fetch('/api/longbridge/live-trading/stop', { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge live stop request failed with HTTP ${response.status}.`)
      setData(payload as LongbridgeLiveTradingDashboardResponse)
      await refreshAll()
      return payload as LongbridgeLiveTradingDashboardResponse
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥实盘评估停止失败。')
      return undefined
    } finally {
      setRunning(false)
    }
  }, [refreshAll])

  const setHistoryPage = useCallback((kind: LongbridgeHistoryKey, page: number) => {
    const nextPage = Math.max(1, page)
    setHistoryPagesState((current) => {
      const next = { ...current, [kind]: nextPage }
      historyPagesRef.current = next
      return next
    })
    return loadHistory(kind, nextPage, HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setPendingOrderStatusFilter = useCallback((status: LivePendingOrderStatusFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, pendingOrderStatusFilter: status }
    setPendingOrderStatusFilterState(status)
    setHistoryPagesState((current) => {
      const next = { ...current, 'pending-orders': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('pending-orders', 1, HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setPendingOrderTickerFilter = useCallback((ticker: string) => {
    const normalizedTicker = ticker.trim().toUpperCase() || 'ALL'
    historyFiltersRef.current = { ...historyFiltersRef.current, pendingOrderTickerFilter: normalizedTicker }
    setPendingOrderTickerFilterState(normalizedTicker)
    setHistoryPagesState((current) => {
      const next = { ...current, 'pending-orders': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('pending-orders', 1, HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setPendingOrderSideFilter = useCallback((side: LivePendingOrderSideFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, pendingOrderSideFilter: side }
    setPendingOrderSideFilterState(side)
    setHistoryPagesState((current) => {
      const next = { ...current, 'pending-orders': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('pending-orders', 1, HISTORY_PAGE_SIZE)
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
    return loadHistory('signals', 1, HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setSignalDirectionFilter = useCallback((direction: LiveSignalDirectionFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, signalDirectionFilter: direction }
    setSignalDirectionFilterState(direction)
    setHistoryPagesState((current) => {
      const next = { ...current, signals: 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('signals', 1, HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setSignalLifecycleFilter = useCallback((lifecycleStatus: LiveSignalLifecycleFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, signalLifecycleFilter: lifecycleStatus }
    setSignalLifecycleFilterState(lifecycleStatus)
    setHistoryPagesState((current) => {
      const next = { ...current, signals: 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('signals', 1, HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const setCandidatePoolHistoryFilter = useCallback((statusGroup: LiveCandidatePoolHistoryFilter) => {
    historyFiltersRef.current = { ...historyFiltersRef.current, candidatePoolHistoryFilter: statusGroup }
    setCandidatePoolHistoryFilterState(statusGroup)
    setHistoryPagesState((current) => {
      const next = { ...current, 'candidate-pool': 1 }
      historyPagesRef.current = next
      return next
    })
    return loadHistory('candidate-pool', 1, HISTORY_PAGE_SIZE)
  }, [loadHistory])

  const confirmOrder = useCallback(async (id: string) => {
    setConfirmingOrderId(id)
    try {
      const response = await fetch(`/api/longbridge/live-trading/pending-orders/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationId: `LB-CONF-${Date.now()}` }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge order confirmation failed with HTTP ${response.status}.`)
      setError(undefined)
      await refreshAll()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥订单确认失败。')
      return undefined
    } finally {
      setConfirmingOrderId(undefined)
    }
  }, [refreshAll])

  const rejectOrder = useCallback(async (id: string) => {
    setRejectingOrderId(id)
    try {
      const response = await fetch(`/api/longbridge/live-trading/pending-orders/${id}/reject`, { method: 'POST' })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge order reject failed with HTTP ${response.status}.`)
      setError(undefined)
      await refreshAll()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥订单拒绝失败。')
      return undefined
    } finally {
      setRejectingOrderId(undefined)
    }
  }, [refreshAll])

  const batchExpirePendingOrders = useCallback(async (input: { ticker?: string; side?: LivePendingOrderSideFilter; ids?: string[] } = {}) => {
    setExpiringPendingOrders(true)
    try {
      const response = await fetch('/api/longbridge/live-trading/pending-orders/batch-expire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge order batch expire failed with HTTP ${response.status}.`)
      setError(undefined)
      await refreshAll()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥订单批量过期失败。')
      return undefined
    } finally {
      setExpiringPendingOrders(false)
    }
  }, [refreshAll])

  const updateAutoSubmit = useCallback(async (autoSubmitEnabled: boolean) => {
    setSavingSettings(true)
    try {
      const response = await fetch('/api/longbridge/live-trading/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSubmitEnabled }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `Longbridge live settings update failed with HTTP ${response.status}.`)
      await refreshAll()
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥自动下单开关更新失败。')
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
    historyPages,
    lastRun,
    confirmingOrderId,
    rejectingOrderId,
    expiringPendingOrders,
    savingSettings,
    running,
    refreshing,
    error,
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    signalTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    candidatePoolHistoryFilter,
    refresh: refreshAll,
    start,
    stop,
    runOnce,
    setHistoryPage,
    setPendingOrderStatusFilter,
    setPendingOrderTickerFilter,
    setPendingOrderSideFilter,
    setSignalTickerFilter,
    setSignalDirectionFilter,
    setSignalLifecycleFilter,
    setCandidatePoolHistoryFilter,
    confirmOrder,
    rejectOrder,
    batchExpirePendingOrders,
    updateAutoSubmit,
  }
}
