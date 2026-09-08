import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FutuLiveOrderDetailResponse,
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
import type { ManagedOrderListResponse } from '../../shared/managedOrderTypes'

type LiveHistoryState = {
  signals?: SimulationHistoryPage<LiveSignalHistoryItem>
  'pending-orders'?: SimulationHistoryPage<LivePendingOrder>
  'candidate-pool'?: SimulationHistoryPage<LiveCandidatePoolItem>
  'submitted-orders'?: SimulationHistoryPage<LiveOrderResult>
  skipped?: SimulationHistoryPage<LiveSkippedTicker>
}

type LiveHistoryKey = keyof LiveHistoryState
type FutuOrderFilters = {
  ticker: string
  status: 'ALL' | 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'FAILED'
  side: 'ALL' | 'BUY' | 'SELL'
}

const LIVE_HISTORY_PAGE_SIZE = 12
const FUTU_ORDERS_PAGE_SIZE = 12
const AUTO_REFRESH_MS = 30_000
const CONTROL_POLL_INTERVAL_MS = 500
const CONTROL_POLL_ATTEMPTS = 60

function isDashboardResponse(payload: unknown): payload is LiveTradingDashboardResponse {
  if (!payload || typeof payload !== 'object') return false
  const dashboard = payload as Partial<LiveTradingDashboardResponse>
  return Boolean(
    dashboard.engine
    && dashboard.account
    && Array.isArray(dashboard.universe)
    && Array.isArray(dashboard.latestSignals)
    && Array.isArray(dashboard.pendingOrders)
    && Array.isArray(dashboard.submittedOrders),
  )
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

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
  const [futuOrderDetail, setFutuOrderDetail] = useState<FutuLiveOrderDetailResponse>()
  const [loadingFutuOrderDetailId, setLoadingFutuOrderDetailId] = useState<string>()
  const [futuOrderDetailError, setFutuOrderDetailError] = useState<string>()
  const [managedOrders, setManagedOrders] = useState<ManagedOrderListResponse>()
  const [cancelingManagedOrderId, setCancelingManagedOrderId] = useState<string>()
  const [tradeStrategyConfig, setTradeStrategyConfig] = useState<TradeStrategyConfigResponse>()
  const [futuOrdersPage, setFutuOrdersPageState] = useState(1)
  const [futuOrderTickerFilter, setFutuOrderTickerFilterState] = useState('ALL')
  const [futuOrderStatusFilter, setFutuOrderStatusFilterState] = useState<FutuOrderFilters['status']>('ALL')
  const [futuOrderSideFilter, setFutuOrderSideFilterState] = useState<FutuOrderFilters['side']>('ALL')
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
  const futuOrderFiltersRef = useRef<FutuOrderFilters>({
    ticker: futuOrderTickerFilter,
    status: futuOrderStatusFilter,
    side: futuOrderSideFilter,
  })
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

  const requestDashboard = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/live-trading/dashboard')
      if (!response.ok) throw new Error(`Live trading request failed with HTTP ${response.status}.`)
      const payload: unknown = await response.json()
      if (!isDashboardResponse(payload)) throw new Error('实盘看板返回内容不完整。')
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

  const requestControl = useCallback(async (url: string, expectedRunning?: boolean) => {
    setLoading(true)
    try {
      const response = await fetch(url, { method: 'POST' })
      const acknowledgement: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`实盘控制请求失败，状态码 ${response.status}。`)

      if (isDashboardResponse(acknowledgement)) {
        setData(acknowledgement)
        setError(undefined)
        return acknowledgement
      }

      for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt += 1) {
        await wait(CONTROL_POLL_INTERVAL_MS)
        const dashboardResponse = await fetch('/api/live-trading/dashboard')
        if (!dashboardResponse.ok) continue
        const dashboard: unknown = await dashboardResponse.json().catch(() => undefined)
        if (!isDashboardResponse(dashboard)) continue
        if (expectedRunning !== undefined && dashboard.engine.running !== expectedRunning) continue
        setData(dashboard)
        setError(undefined)
        return dashboard
      }

      throw new Error('实盘控制指令已提交，但等待状态更新超时。')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '实盘控制请求失败。')
      return undefined
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => requestDashboard(), [requestDashboard])
  const start = useCallback(() => requestControl('/api/live-trading/start', true), [requestControl])
  const stop = useCallback(() => requestControl('/api/live-trading/stop', false), [requestControl])
  const runOnce = useCallback(() => requestControl('/api/live-trading/run-once'), [requestControl])

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

  const loadFutuOrders = useCallback(async (
    page = 1,
    pageSize = FUTU_ORDERS_PAGE_SIZE,
    filters = futuOrderFiltersRef.current,
  ) => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ticker: filters.ticker,
        status: filters.status,
        side: filters.side,
      })
      const response = await fetch(
        `/api/live-trading/futu-orders?${params.toString()}`,
        { signal: AbortSignal.timeout(30_000) },
      )
      if (!response.ok) throw new Error(`Futu 实盘订单请求失败，状态码 ${response.status}。`)
      const payload = (await response.json()) as FutuLiveOrdersResponse
      setFutuOrders(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '无法加载 Futu 实盘订单。')
      return undefined
    }
  }, [])

  const loadManagedOrders = useCallback(async () => {
    try {
      const response = await fetch('/api/live-trading/managed-orders')
      const payload = await response.json() as ManagedOrderListResponse
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? '系统挂单读取失败。')
      setManagedOrders(payload)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '系统挂单读取失败。')
      return undefined
    }
  }, [])

  const refreshTradeStrategyConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/live-trading/trade-strategy-config')
      if (!response.ok) throw new Error(`Live strategy config request failed with HTTP ${response.status}.`)
      const payload = (await response.json()) as TradeStrategyConfigResponse
      setTradeStrategyConfig(payload)
      await requestDashboard()
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

  const setFutuOrderFilters = useCallback((patch: Partial<FutuOrderFilters>) => {
    const next = { ...futuOrderFiltersRef.current, ...patch }
    futuOrderFiltersRef.current = next
    setFutuOrderTickerFilterState(next.ticker)
    setFutuOrderStatusFilterState(next.status)
    setFutuOrderSideFilterState(next.side)
    setFutuOrdersPageState(1)
    futuOrdersPageRef.current = 1
    return loadFutuOrders(1, FUTU_ORDERS_PAGE_SIZE, next)
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
      // OpenD 订单查询耗时波动较大，独立刷新，不能阻塞主看板和操作按钮复位。
      void loadFutuOrders(futuOrdersPageRef.current, FUTU_ORDERS_PAGE_SIZE)
      await Promise.all([
        loadManagedOrders(),
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
  }, [loadFutuOrders, loadHistory, loadManagedOrders, refresh, refreshTradeStrategyConfig])

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

  const loadFutuOrderDetail = useCallback(async (input: {
    orderId: string
    ticker?: string
    submittedAt?: string
  }) => {
    setLoadingFutuOrderDetailId(input.orderId)
    setFutuOrderDetail(undefined)
    setFutuOrderDetailError(undefined)
    try {
      const params = new URLSearchParams()
      if (input.ticker) params.set('ticker', input.ticker)
      if (input.submittedAt) params.set('submittedAt', input.submittedAt)
      const suffix = params.size ? `?${params.toString()}` : ''
      const response = await fetch(
        `/api/live-trading/futu-orders/${encodeURIComponent(input.orderId)}/detail${suffix}`,
      )
      const payload = await response.json().catch(() => undefined) as FutuLiveOrderDetailResponse | undefined
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Futu 订单详情请求失败，状态码 ${response.status}。`)
      }
      setFutuOrderDetail(payload)
      return payload
    } catch (requestError) {
      setFutuOrderDetailError(requestError instanceof Error ? requestError.message : 'Futu 订单详情加载失败。')
      return undefined
    } finally {
      setLoadingFutuOrderDetailId(undefined)
    }
  }, [])

  const clearFutuOrderDetail = useCallback(() => {
    setFutuOrderDetail(undefined)
    setFutuOrderDetailError(undefined)
    setLoadingFutuOrderDetailId(undefined)
  }, [])

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
      if (payload && typeof payload === 'object' && typeof payload.autoSubmitEnabled === 'boolean') {
        setData((current) => current
          ? {
              ...current,
              autoSubmitEnabled: payload.autoSubmitEnabled,
              liveTradingEnabled:
                typeof payload.liveTradingEnabled === 'boolean'
                  ? payload.liveTradingEnabled
                  : current.liveTradingEnabled,
            }
          : current)
      }
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Futu 自动下单开关更新失败。')
      return undefined
    } finally {
      setSavingSettings(false)
    }
  }, [])

  const updateAutoCancel = useCallback(async (autoCancelEnabled: boolean) => {
    setSavingSettings(true)
    try {
      const response = await fetch('/api/live-trading/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoSubmitEnabled: data?.autoSubmitEnabled === true,
          autoCancelEnabled,
        }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `自动撤单设置失败，状态码 ${response.status}。`)
      setData((current) => current ? { ...current, autoCancelEnabled: payload.autoCancelEnabled === true } : current)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '自动撤单开关更新失败。')
      return undefined
    } finally {
      setSavingSettings(false)
    }
  }, [data?.autoSubmitEnabled])

  const cancelManagedOrder = useCallback(async (orderId: string) => {
    setCancelingManagedOrderId(orderId)
    try {
      const response = await fetch(`/api/live-trading/futu-orders/${encodeURIComponent(orderId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cancelRequestId: crypto.randomUUID(),
          reason: '用户在系统挂单监管页面手工撤单',
        }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? 'Futu 撤单失败。')
      await loadManagedOrders()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Futu 撤单失败。')
      return undefined
    } finally {
      setCancelingManagedOrderId(undefined)
    }
  }, [loadManagedOrders])

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
    futuOrderTickerFilter,
    futuOrderStatusFilter,
    futuOrderSideFilter,
    futuOrderDetail,
    loadingFutuOrderDetailId,
    futuOrderDetailError,
    managedOrders,
    cancelingManagedOrderId,
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
    setFutuOrderFilters,
    saveLlmConfig,
    saveTradeStrategyConfig,
    confirmOrder,
    rejectOrder,
    batchExpirePendingOrders,
    loadFutuOrderDetail,
    clearFutuOrderDetail,
    updateAutoSubmit,
    updateAutoCancel,
    cancelManagedOrder,
  }
}
