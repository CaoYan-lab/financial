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
import type {
  LongbridgeBrokerOrderSideFilter,
  LongbridgeBrokerOrdersResponse,
  LongbridgeBrokerOrderStatusFilter,
  LongbridgeCombinedOrderDetailResponse,
  LongbridgeLiveRunOnceResponse,
  LongbridgeLiveTradingDashboardResponse,
} from '../../shared/longbridgeTypes'
import type { ManagedOrderListResponse } from '../../shared/managedOrderTypes'
import { localizeLongbridgeOrderError } from '../../shared/orderErrorMessages'

type LongbridgeHistoryState = {
  signals?: SimulationHistoryPage<LiveSignalHistoryItem>
  'pending-orders'?: SimulationHistoryPage<LivePendingOrder>
  'candidate-pool'?: SimulationHistoryPage<LiveCandidatePoolItem>
}

type LongbridgeHistoryKey = keyof LongbridgeHistoryState
type BrokerOrderFilters = {
  ticker: string
  status: LongbridgeBrokerOrderStatusFilter
  side: LongbridgeBrokerOrderSideFilter
}

const HISTORY_PAGE_SIZE = 12
const BROKER_ORDERS_PAGE_SIZE = 12
const AUTO_REFRESH_MS = 30_000
const CONTROL_POLL_INTERVAL_MS = 500
const CONTROL_POLL_ATTEMPTS = 60

function isDashboardResponse(payload: unknown): payload is LongbridgeLiveTradingDashboardResponse {
  if (!payload || typeof payload !== 'object') return false
  const dashboard = payload as Partial<LongbridgeLiveTradingDashboardResponse>
  return Boolean(
    dashboard.engine
    && dashboard.evaluationStatus
    && Array.isArray(dashboard.signals)
    && Array.isArray(dashboard.pendingOrders)
    && dashboard.candidatePool,
  )
}

function isQueuedResponse(payload: unknown): payload is { enqueued: true } {
  return Boolean(
    payload
    && typeof payload === 'object'
    && (payload as { enqueued?: unknown }).enqueued === true,
  )
}

function responseError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  return typeof error === 'string' ? error : undefined
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

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
  const [orderDetail, setOrderDetail] = useState<LongbridgeCombinedOrderDetailResponse>()
  const [loadingOrderDetailId, setLoadingOrderDetailId] = useState<string>()
  const [orderDetailError, setOrderDetailError] = useState<string>()
  const [brokerOrders, setBrokerOrders] = useState<LongbridgeBrokerOrdersResponse>()
  const [brokerOrdersPage, setBrokerOrdersPageState] = useState(1)
  const [brokerOrderTickerFilter, setBrokerOrderTickerFilterState] = useState('ALL')
  const [brokerOrderStatusFilter, setBrokerOrderStatusFilterState] = useState<LongbridgeBrokerOrderStatusFilter>('ALL')
  const [brokerOrderSideFilter, setBrokerOrderSideFilterState] = useState<LongbridgeBrokerOrderSideFilter>('ALL')
  const [managedOrders, setManagedOrders] = useState<ManagedOrderListResponse>()
  const [cancelingManagedOrderId, setCancelingManagedOrderId] = useState<string>()
  const [running, setRunning] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const dashboardRefreshInFlight = useRef(false)
  const brokerOrdersPageRef = useRef(brokerOrdersPage)
  const brokerOrderFiltersRef = useRef<BrokerOrderFilters>({
    ticker: brokerOrderTickerFilter,
    status: brokerOrderStatusFilter,
    side: brokerOrderSideFilter,
  })
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
    const payload: unknown = await response.json()
    if (!response.ok) throw new Error(responseError(payload) ?? `Longbridge live dashboard request failed with HTTP ${response.status}.`)
    if (!isDashboardResponse(payload)) throw new Error('长桥实盘看板返回内容不完整。')
    setData(payload)
    setError(undefined)
    return payload
  }, [])

  const waitForDashboard = useCallback(async (expectedRunning?: boolean) => {
    for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt += 1) {
      await wait(CONTROL_POLL_INTERVAL_MS)
      const response = await fetch('/api/longbridge/live-trading/dashboard')
      if (!response.ok) continue
      const payload: unknown = await response.json().catch(() => undefined)
      if (!isDashboardResponse(payload)) continue
      if (expectedRunning !== undefined && payload.engine.running !== expectedRunning) continue
      setData(payload)
      return payload
    }
    throw new Error('长桥控制指令已提交，但等待状态更新超时。')
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

  const loadManagedOrders = useCallback(async () => {
    try {
      const response = await fetch('/api/longbridge/live-trading/managed-orders')
      const payload = await response.json() as ManagedOrderListResponse
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? '长桥系统挂单读取失败。')
      setManagedOrders(payload)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥系统挂单读取失败。')
      return undefined
    }
  }, [])

  const loadBrokerOrders = useCallback(async (
    page = 1,
    pageSize = BROKER_ORDERS_PAGE_SIZE,
    filters = brokerOrderFiltersRef.current,
  ) => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ticker: filters.ticker,
        status: filters.status,
        side: filters.side,
      })
      const response = await fetch(`/api/longbridge/live-trading/orders?${params.toString()}`, {
        signal: AbortSignal.timeout(30_000),
      })
      const payload = await response.json().catch(() => undefined) as LongbridgeBrokerOrdersResponse | undefined
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? '长桥券商订单清单加载失败。')
      setBrokerOrders(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(localizeLongbridgeOrderError(
        requestError instanceof Error ? requestError.message : '长桥券商订单清单加载失败。',
      ))
      return undefined
    }
  }, [])

  const setBrokerOrdersPage = useCallback((page: number) => {
    const nextPage = Math.max(1, page)
    brokerOrdersPageRef.current = nextPage
    setBrokerOrdersPageState(nextPage)
    return loadBrokerOrders(nextPage, BROKER_ORDERS_PAGE_SIZE)
  }, [loadBrokerOrders])

  const setBrokerOrderFilters = useCallback((patch: Partial<BrokerOrderFilters>) => {
    const next = { ...brokerOrderFiltersRef.current, ...patch }
    brokerOrderFiltersRef.current = next
    setBrokerOrderTickerFilterState(next.ticker)
    setBrokerOrderStatusFilterState(next.status)
    setBrokerOrderSideFilterState(next.side)
    brokerOrdersPageRef.current = 1
    setBrokerOrdersPageState(1)
    return loadBrokerOrders(1, BROKER_ORDERS_PAGE_SIZE, next)
  }, [loadBrokerOrders])

  const refreshAll = useCallback(async () => {
    if (dashboardRefreshInFlight.current) return undefined
    dashboardRefreshInFlight.current = true
    setRefreshing(true)
    try {
      const payload = await refreshDashboard()
      const currentHistoryPages = historyPagesRef.current
      await Promise.all([
        loadManagedOrders(),
        loadHistory('signals', currentHistoryPages.signals, HISTORY_PAGE_SIZE),
        loadHistory('pending-orders', currentHistoryPages['pending-orders'], HISTORY_PAGE_SIZE),
        loadHistory('candidate-pool', currentHistoryPages['candidate-pool'], HISTORY_PAGE_SIZE),
      ])
      await loadBrokerOrders(brokerOrdersPageRef.current, BROKER_ORDERS_PAGE_SIZE)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥实盘状态加载失败。')
      return undefined
    } finally {
      dashboardRefreshInFlight.current = false
      setRefreshing(false)
    }
  }, [loadBrokerOrders, loadHistory, loadManagedOrders, refreshDashboard])

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
      if (isQueuedResponse(payload)) {
        await waitForDashboard()
        await refreshAll()
        return undefined
      }
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
  }, [refreshAll, waitForDashboard])

  const start = useCallback(async () => {
    setRunning(true)
    setError(undefined)
    try {
      const response = await fetch('/api/longbridge/live-trading/start', { method: 'POST' })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(responseError(payload) ?? `Longbridge live start request failed with HTTP ${response.status}.`)
      const result = isDashboardResponse(payload)
        ? payload
        : isQueuedResponse(payload)
          ? await waitForDashboard(true)
          : undefined
      if (!result) throw new Error('长桥实盘启动接口返回内容不完整。')
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
  }, [refreshAll, waitForDashboard])

  const stop = useCallback(async () => {
    setRunning(true)
    setError(undefined)
    try {
      const response = await fetch('/api/longbridge/live-trading/stop', { method: 'POST' })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(responseError(payload) ?? `Longbridge live stop request failed with HTTP ${response.status}.`)
      const result = isDashboardResponse(payload)
        ? payload
        : isQueuedResponse(payload)
          ? await waitForDashboard(false)
          : undefined
      if (!result) throw new Error('长桥实盘停止接口返回内容不完整。')
      setData(result)
      await refreshAll()
      return result
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥实盘评估停止失败。')
      return undefined
    } finally {
      setRunning(false)
    }
  }, [refreshAll, waitForDashboard])

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
      setError(localizeLongbridgeOrderError(
        requestError instanceof Error ? requestError.message : '长桥订单确认失败。',
      ))
      return undefined
    } finally {
      setConfirmingOrderId(undefined)
    }
  }, [refreshAll])

  const loadOrderDetail = useCallback(async (orderId: string, submittedAt?: string) => {
    setLoadingOrderDetailId(orderId)
    setOrderDetail(undefined)
    setOrderDetailError(undefined)
    try {
      const params = new URLSearchParams()
      if (submittedAt) params.set('submittedAt', submittedAt)
      const suffix = params.size ? `?${params.toString()}` : ''
      const response = await fetch(`/api/longbridge/live-trading/orders/${encodeURIComponent(orderId)}/detail${suffix}`)
      const payload = await response.json().catch(() => undefined) as LongbridgeCombinedOrderDetailResponse | undefined
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `长桥订单详情请求失败，HTTP ${response.status}。`)
      }
      setOrderDetail(payload)
      return payload
    } catch (requestError) {
      setOrderDetailError(requestError instanceof Error ? requestError.message : '长桥订单详情加载失败。')
      return undefined
    } finally {
      setLoadingOrderDetailId(undefined)
    }
  }, [])

  const clearOrderDetail = useCallback(() => {
    setOrderDetail(undefined)
    setOrderDetailError(undefined)
    setLoadingOrderDetailId(undefined)
  }, [])

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
      if (
        payload
        && typeof payload === 'object'
        && typeof payload.autoSubmitEnabled === 'boolean'
      ) {
        setData((current) => current
          ? {
              ...current,
              autoSubmitEnabled: payload.autoSubmitEnabled,
              liveTradingEnabled:
                typeof payload.liveTradingEnabled === 'boolean'
                  ? payload.liveTradingEnabled
                  : current.liveTradingEnabled,
              updatedAt:
                typeof payload.updatedAt === 'string'
                  ? payload.updatedAt
                  : current.updatedAt,
            }
          : current)
      }
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥自动下单开关更新失败。')
      return undefined
    } finally {
      setSavingSettings(false)
    }
  }, [])

  const updateAutoCancel = useCallback(async (autoCancelEnabled: boolean) => {
    setSavingSettings(true)
    try {
      const response = await fetch('/api/longbridge/live-trading/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoSubmitEnabled: data?.autoSubmitEnabled === true,
          autoCancelEnabled,
        }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `长桥自动撤单设置失败，状态码 ${response.status}。`)
      setData((current) => current
        ? {
            ...current,
            autoCancelEnabled: payload?.autoCancelEnabled === true,
            updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : current.updatedAt,
          }
        : current)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥自动撤单开关更新失败。')
      return undefined
    } finally {
      setSavingSettings(false)
    }
  }, [data?.autoSubmitEnabled])

  const cancelManagedOrder = useCallback(async (orderId: string) => {
    setCancelingManagedOrderId(orderId)
    try {
      const response = await fetch(`/api/longbridge/live-trading/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cancelRequestId: crypto.randomUUID(),
          reason: '用户在系统挂单监管页面手工撤单',
        }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? '长桥撤单失败。')
      await loadManagedOrders()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '长桥撤单失败。')
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
    historyPages,
    lastRun,
    confirmingOrderId,
    rejectingOrderId,
    expiringPendingOrders,
    savingSettings,
    orderDetail,
    loadingOrderDetailId,
    orderDetailError,
    managedOrders,
    brokerOrders,
    brokerOrdersPage,
    brokerOrderTickerFilter,
    brokerOrderStatusFilter,
    brokerOrderSideFilter,
    cancelingManagedOrderId,
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
    loadOrderDetail,
    loadBrokerOrders,
    setBrokerOrdersPage,
    setBrokerOrderFilters,
    clearOrderDetail,
    rejectOrder,
    batchExpirePendingOrders,
    updateAutoSubmit,
    updateAutoCancel,
    cancelManagedOrder,
  }
}
