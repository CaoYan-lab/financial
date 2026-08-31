import { useCallback, useEffect, useState } from 'react'
import type { AShareUniverseResponse } from './useAshareInstrumentLookup'
import type {
  AShareTradingAgentRun,
  LiveCandidatePoolHistoryFilter,
  LiveCandidatePoolItem,
  LiveAccountDashboardResponse,
  LiveCandidatePoolSnapshot,
  LivePendingOrder,
  LivePendingOrderSideFilter,
  LivePendingOrderStatusFilter,
  LiveSignalDirectionFilter,
  LiveSignalHistoryItem,
  LiveSignalLifecycleFilter,
  LlmModelOption,
  LlmRuntimeConfig,
  SimulationHistoryPage,
  TradeStrategyConfigResponse,
  UpdateLlmRuntimeConfigRequest,
  UpdateTradeStrategyConfigRequest,
} from '../../../shared/types'

export type AShareSession = 'RTH' | 'LUNCH_BREAK' | 'PRE_OPEN' | 'CLOSED' | 'WEEKEND'

export type AShareTradingAgentLlmPreset = {
  id: string
  label: string
  provider: string
  backendUrl?: string
  quickThinkLlm: string
  deepThinkLlm: string
  apiKeyEnv: string
  apiKeyConfigured: boolean
}

export type AShareTradingAgentLlmConfig = {
  presetId: string
  presetLabel: string
  provider: string
  backendUrl?: string
  quickThinkLlm: string
  deepThinkLlm: string
  apiKeyEnv: string
  apiKeyConfigured: boolean
  maxDebateRounds: number
  maxRiskRounds: number
  outputLanguage: string
  updatedAt: string
}

export type UpdateAshareTradingAgentLlmConfigRequest = {
  presetId?: string
  maxDebateRounds?: number
  maxRiskRounds?: number
  outputLanguage?: string
}

export type AShareDashboardResponse = {
  ok: true
  engine: {
    running: boolean
    startedAt?: string
    lastRunAt?: string
    nextRunAt?: string
    lastError?: string
    universe: string[]
  }
  universe: AShareUniverseResponse['universe']
  realtime: {
    running: boolean
    subscribedTickers: string[]
    startedAt?: string
    lastEventAt?: string
    lastError?: string
  }
  session: {
    session: AShareSession
    shouldSkipLlm: boolean
    reason?: string
    checkedAt: string
  }
  account: LiveAccountDashboardResponse
  readiness: Array<{
    ticker: string
    name: string
    quoteReady: boolean
    tickerPoints: number
    klineBars: number
    orderBookReady: boolean
    lastPrice?: string
    change?: string
    changePercent?: string
    marketState?: string
    updatedAt: string
  }>
  llmRuntimeConfig: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  tradeStrategyConfig: TradeStrategyConfigResponse
  tradingAgent: {
    enabled: boolean
    source: 'TauricResearch/TradingAgents'
    repoPath: string
    repoReady: boolean
    pythonBin: string
    pythonReady: boolean
    adapterReady: boolean
    error?: string
  }
  tradingAgentLlmConfig: AShareTradingAgentLlmConfig
  tradingAgentLlmPresets: AShareTradingAgentLlmPreset[]
  latestSignals: LiveSignalHistoryItem[]
  latestAgentRuns: AShareTradingAgentRun[]
  pendingOrders: LivePendingOrder[]
  skippedTickers: Array<{
    ticker: string
    reason: string
    updatedAt: string
  }>
  candidatePool: LiveCandidatePoolSnapshot
  rules: string[]
  updatedAt: string
}

export function useAshareWorkbench() {
  const [dashboard, setDashboard] = useState<AShareDashboardResponse>()
  const [history, setHistory] = useState<{
    signals?: SimulationHistoryPage<LiveSignalHistoryItem>
    'pending-orders'?: SimulationHistoryPage<LivePendingOrder>
    'candidate-pool'?: SimulationHistoryPage<LiveCandidatePoolItem>
  }>({})
  const [pendingOrderStatusFilter, setPendingOrderStatusFilter] = useState<LivePendingOrderStatusFilter>('ALL')
  const [pendingOrderTickerFilter, setPendingOrderTickerFilter] = useState('ALL')
  const [pendingOrderSideFilter, setPendingOrderSideFilter] = useState<LivePendingOrderSideFilter>('ALL')
  const [signalTickerFilter, setSignalTickerFilter] = useState('ALL')
  const [signalDirectionFilter, setSignalDirectionFilter] = useState<LiveSignalDirectionFilter>('ALL')
  const [signalLifecycleFilter, setSignalLifecycleFilter] = useState<LiveSignalLifecycleFilter>('ALL')
  const [candidatePoolHistoryFilter, setCandidatePoolHistoryFilter] = useState<LiveCandidatePoolHistoryFilter>('ACTIVE')
  const [loading, setLoading] = useState(true)
  const [runningAction, setRunningAction] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [confirmingOrderId, setConfirmingOrderId] = useState<string>()
  const [rejectingOrderId, setRejectingOrderId] = useState<string>()
  const [error, setError] = useState<string>()

  const fetchHistory = useCallback(async (kind: 'signals' | 'pending-orders' | 'candidate-pool', page = 1) => {
    const params = new URLSearchParams({ page: String(page), pageSize: '10' })
    if (kind === 'signals') {
      params.set('ticker', signalTickerFilter)
      params.set('direction', signalDirectionFilter)
      params.set('lifecycleStatus', signalLifecycleFilter)
    }
    if (kind === 'pending-orders') {
      params.set('ticker', pendingOrderTickerFilter)
      params.set('status', pendingOrderStatusFilter)
      params.set('side', pendingOrderSideFilter)
    }
    if (kind === 'candidate-pool') {
      params.set('statusGroup', candidatePoolHistoryFilter)
    }
    const response = await fetch(`/api/a-share/history/${kind}?${params.toString()}`)
    if (!response.ok) throw new Error(`A 股历史数据请求失败：HTTP ${response.status}`)
    const payload = (await response.json()) as SimulationHistoryPage<unknown>
    setHistory((current) => ({ ...current, [kind]: payload }))
    return payload
  }, [
    candidatePoolHistoryFilter,
    pendingOrderSideFilter,
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    signalTickerFilter,
  ])

  const refreshHistory = useCallback(async () => {
    await Promise.all([fetchHistory('signals'), fetchHistory('pending-orders'), fetchHistory('candidate-pool')])
  }, [fetchHistory])

  const requestDashboard = useCallback(async (url = '/api/a-share/dashboard', method = 'GET') => {
    setRunningAction(method !== 'GET')
    try {
      const response = await fetch(url, { method })
      if (!response.ok) throw new Error(`A 股工作台请求失败：HTTP ${response.status}`)
      const payload = (await response.json()) as AShareDashboardResponse
      setDashboard(payload)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'A 股工作台请求失败。')
      return undefined
    } finally {
      setLoading(false)
      setRunningAction(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    await requestDashboard()
    await refreshHistory()
  }, [refreshHistory, requestDashboard])
  const start = useCallback(async () => {
    const result = await requestDashboard('/api/a-share/start', 'POST')
    await refreshHistory()
    return result
  }, [refreshHistory, requestDashboard])
  const stop = useCallback(async () => {
    const result = await requestDashboard('/api/a-share/stop', 'POST')
    await refreshHistory()
    return result
  }, [refreshHistory, requestDashboard])
  const runOnce = useCallback(async () => {
    const result = await requestDashboard('/api/a-share/run-once', 'POST')
    await refreshHistory()
    return result
  }, [refreshHistory, requestDashboard])

  const runTradingAgentMockRun = useCallback(async () => {
    setRunningAction(true)
    try {
      const response = await fetch('/api/a-share/trading-agent/mock-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: 'SZ.000001', name: '平安银行', price: 10.88 }),
      })
      if (!response.ok) throw new Error(`Trading Agent Mock 落库测试失败：HTTP ${response.status}`)
      await requestDashboard()
      await refreshHistory()
      setError(undefined)
      return await response.json()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Trading Agent Mock 落库测试失败。')
      return undefined
    } finally {
      setRunningAction(false)
    }
  }, [refreshHistory, requestDashboard])

  const setHistoryPage = useCallback((kind: 'signals' | 'pending-orders' | 'candidate-pool', page: number) => {
    return fetchHistory(kind, page)
  }, [fetchHistory])

  const confirmOrder = useCallback(async (id: string) => {
    setConfirmingOrderId(id)
    try {
      const response = await fetch(`/api/a-share/pending-orders/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationId: `ASHARE-CONF-${Date.now()}` }),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `A 股订单确认失败：HTTP ${response.status}`)
      setError(undefined)
      await refresh()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'A 股订单确认失败。')
      return undefined
    } finally {
      setConfirmingOrderId(undefined)
    }
  }, [refresh])

  const rejectOrder = useCallback(async (id: string) => {
    setRejectingOrderId(id)
    try {
      const response = await fetch(`/api/a-share/pending-orders/${id}/reject`, { method: 'POST' })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `A 股订单拒绝失败：HTTP ${response.status}`)
      setError(undefined)
      await refresh()
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'A 股订单拒绝失败。')
      return undefined
    } finally {
      setRejectingOrderId(undefined)
    }
  }, [refresh])

  const saveLlmConfig = useCallback(async (input: UpdateLlmRuntimeConfigRequest) => {
    setSavingConfig(true)
    try {
      const response = await fetch('/api/a-share/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`A 股 LLM 配置保存失败：HTTP ${response.status}`)
      const payload = await response.json() as { config: LlmRuntimeConfig; modelOptions: LlmModelOption[]; warnings: string[] }
      setDashboard((current) => current ? { ...current, llmRuntimeConfig: payload.config, modelOptions: payload.modelOptions } : current)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'A 股 LLM 配置保存失败。')
      return undefined
    } finally {
      setSavingConfig(false)
    }
  }, [])

  const saveTradeStrategyConfig = useCallback(async (input: UpdateTradeStrategyConfigRequest) => {
    setSavingConfig(true)
    try {
      const response = await fetch('/api/a-share/trade-strategy-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`A 股策略配置保存失败：HTTP ${response.status}`)
      const payload = await response.json() as TradeStrategyConfigResponse
      setDashboard((current) => current ? {
        ...current,
        tradeStrategyConfig: payload,
        candidatePool: {
          ...current.candidatePool,
          executionMode: payload.selection.executionMode,
          enabled: payload.selection.executionMode === 'candidate_pool',
          presetId: payload.selection.portfolioTimingPresetId ?? current.candidatePool.presetId,
          presetLabel: current.candidatePool.timingPresets.find((item) => item.id === (payload.selection.portfolioTimingPresetId ?? current.candidatePool.presetId))?.label ?? current.candidatePool.presetLabel,
        },
      } : current)
      await refreshHistory()
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'A 股策略配置保存失败。')
      return undefined
    } finally {
      setSavingConfig(false)
    }
  }, [refreshHistory])

  const saveTradingAgentLlmConfig = useCallback(async (input: UpdateAshareTradingAgentLlmConfigRequest) => {
    setSavingConfig(true)
    try {
      const response = await fetch('/api/a-share/trading-agent-llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error(`Trading Agent LLM 配置保存失败：HTTP ${response.status}`)
      const payload = await response.json() as { config: AShareTradingAgentLlmConfig; presets: AShareTradingAgentLlmPreset[]; warnings: string[] }
      setDashboard((current) => current ? { ...current, tradingAgentLlmConfig: payload.config, tradingAgentLlmPresets: payload.presets } : current)
      setError(undefined)
      return payload
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Trading Agent LLM 配置保存失败。')
      return undefined
    } finally {
      setSavingConfig(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return {
    dashboard,
    history,
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    signalTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    candidatePoolHistoryFilter,
    loading,
    runningAction,
    savingConfig,
    confirmingOrderId,
    rejectingOrderId,
    error,
    refresh,
    start,
    stop,
    runOnce,
    runTradingAgentMockRun,
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
    saveLlmConfig,
    saveTradingAgentLlmConfig,
    saveTradeStrategyConfig,
  }
}
