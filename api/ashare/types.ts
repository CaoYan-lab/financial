import type { AShareTradingAgentLlmConfig, AShareTradingAgentLlmPreset } from './aShareRuntimeConfigService.js'
import type { AShareTradingAgentRuntimeStatus } from './aShareTradingAgentService.js'
import type { AShareTradingAgentRun, LiveAccountDashboardResponse, LiveCandidatePoolSnapshot, LivePendingOrder, LiveSkippedTicker, LlmModelOption, LlmRuntimeConfig, QuantSignal, TradeStrategyConfigResponse } from '../../shared/types.js'

export type AShareExchange = 'SH' | 'SZ'

export type AShareAssetType = 'STOCK' | 'ETF'

export type AShareBoard = 'SH_MAIN' | 'STAR' | 'SZ_MAIN' | 'CHINEXT' | 'BSE' | 'UNKNOWN'

export type AShareInstrumentLookupCandidate = {
  ticker: string
  futuCode: string
  name: string
  market: 'CN'
  exchange: AShareExchange
  tradingCurrency: 'CNY'
  assetType: AShareAssetType
  board?: AShareBoard
}

export type AShareInstrumentLookupRequest = {
  query: string
}

export type AShareInstrumentLookupResponse = {
  ok: boolean
  query: string
  candidates: AShareInstrumentLookupCandidate[]
  error?: string
  updatedAt: string
}

export type AShareUniverseItem = AShareInstrumentLookupCandidate & {
  addedAt: string
}

export type AShareUniverseResponse = {
  ok: boolean
  universe: AShareUniverseItem[]
  error?: string
  updatedAt: string
}

export type AShareEngineStatus = {
  running: boolean
  startedAt?: string
  lastRunAt?: string
  nextRunAt?: string
  lastError?: string
  universe: string[]
}

export type AShareTickerReadiness = {
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
}

export type AShareDashboardResponse = {
  ok: true
  engine: AShareEngineStatus
  universe: AShareUniverseItem[]
  realtime: {
    running: boolean
    subscribedTickers: string[]
    startedAt?: string
    lastEventAt?: string
    lastError?: string
  }
  session: {
    session: 'RTH' | 'LUNCH_BREAK' | 'PRE_OPEN' | 'CLOSED' | 'WEEKEND'
    shouldSkipLlm: boolean
    reason?: string
    checkedAt: string
  }
  account: LiveAccountDashboardResponse
  readiness: AShareTickerReadiness[]
  llmRuntimeConfig: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  tradeStrategyConfig: TradeStrategyConfigResponse
  tradingAgent: AShareTradingAgentRuntimeStatus
  tradingAgentLlmConfig: AShareTradingAgentLlmConfig
  tradingAgentLlmPresets: AShareTradingAgentLlmPreset[]
  latestSignals: QuantSignal[]
  latestAgentRuns: AShareTradingAgentRun[]
  pendingOrders: LivePendingOrder[]
  skippedTickers: LiveSkippedTicker[]
  candidatePool: LiveCandidatePoolSnapshot
  rules: string[]
  updatedAt: string
}
