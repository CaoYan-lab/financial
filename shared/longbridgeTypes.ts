import type { LiveCandidatePoolSnapshot, LiveEngineStatus, LivePendingOrder, LiveSignalHistoryItem, LlmModelOption, LlmRuntimeConfig, LlmTradingDecision, RealtimeBar, RealtimeOrderBookLevel, RealtimePoint, SimulationHistoryPage, TradeStrategyConfigResponse } from './types'
import type { ManagedOrder, ManagedOrderEvent } from './managedOrderTypes'

export type LongbridgeAuthStatus = 'authenticated' | 'not_authenticated' | 'unknown'

export type LongbridgeSourceStatusResponse = {
  ok: boolean
  runtimeProvider?: 'sdk' | 'cli'
  sdkAvailable?: boolean
  cliAvailable: boolean
  cliPath: string
  cliVersion: string
  authStatus: LongbridgeAuthStatus
  authDetail: string
  tokenExpiresAt?: string
  tokenRemainingDays?: number
  quotePackages?: string[]
  accountReadAvailable?: boolean
  positionReadAvailable?: boolean
  orderReadAvailable?: boolean
  skillsInstalled: boolean
  installedSkills: string[]
  marketDataAvailable: boolean
  accountDataAvailable: boolean
  tradingAvailable: boolean
  mcpFallbackConfigured: boolean
  lastCheckedAt: string
  missingCapabilities: string[]
}

export type LongbridgeMetric = {
  label: string
  value: string
  helper: string
}

export type LongbridgePosition = {
  symbol: string
  name: string
  quantity: string
  marketValue: string
  averageCost: string
  currentPrice: string
  todayPnL: string
  unrealizedPnL: string
  currency: string
}

export type LongbridgeWorkbenchDashboardResponse = {
  ok: boolean
  sourceStatus: LongbridgeSourceStatusResponse
  accountMetrics: LongbridgeMetric[]
  positions: LongbridgePosition[]
  riskCards: LongbridgeMetric[]
  dataPanels: LongbridgeMetric[]
  researchPanels: LongbridgeMetric[]
  tradingPanels: LongbridgeMetric[]
  warnings: string[]
  updatedAt: string
}

export type LongbridgeLiveTradingConfigResponse = {
  ok: boolean
  llmRuntimeConfig: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  tradeStrategyConfig: TradeStrategyConfigResponse
  candidatePoolConfig: LiveCandidatePoolSnapshot
  warnings: string[]
}

export type LongbridgeStrategyMarketData =
  | {
      ok: true
      ticker: string
      symbol: string
      source: 'longbridge-sdk-cache' | 'longbridge-cli'
      lastPrice: number
      bars: RealtimeBar[]
      tickerPoints: RealtimePoint[]
      asks: RealtimeOrderBookLevel[]
      bids: RealtimeOrderBookLevel[]
      bestAsk?: number
      bestBid?: number
      marketState?: string
      updatedAt: string
      warnings: string[]
    }
  | {
      ok: false
      ticker: string
      symbol: string
      source: 'longbridge-sdk-cache' | 'longbridge-cli'
      reason: string
      warnings: string[]
    }

export type LongbridgeLiveRunOnceResponse = {
  ok: boolean
  symbol: string
  signal?: LiveSignalHistoryItem
  decision?: LlmTradingDecision
  marketData?: LongbridgeStrategyMarketData
  candidatePool: LiveCandidatePoolSnapshot
  pendingOrders: LivePendingOrder[]
  warnings: string[]
}

export type LongbridgeLiveTradingDashboardResponse = {
  ok: boolean
  engine: LiveEngineStatus
  liveTradingEnabled: boolean
  autoSubmitEnabled: boolean
  autoCancelEnabled: boolean
  marketableLimitTimeoutSeconds: number
  limitTimeoutSeconds: number
  brokerSyncIntervalSeconds: number
  modelReviewIntervalSeconds: number
  signals: LiveSignalHistoryItem[]
  pendingOrders: LivePendingOrder[]
  candidatePool: LiveCandidatePoolSnapshot
  warnings: string[]
  updatedAt: string
}

export type LongbridgeConfirmOrderResponse = {
  ok: boolean
  order?: LivePendingOrder
  result?: unknown
  error?: string
  blockedByGate: boolean
}

export type LongbridgeOrderExecution = {
  tradeId: string
  orderId: string
  symbol: string
  quantity: string
  price: string
  tradeDoneAt: string
}

export type LongbridgeOrderHistoryItem = {
  status: number
  statusLabel: string
  quantity: string
  price: string
  message: string
  time: string
}

export type LongbridgeOrderCharge = {
  category: string
  name: string
  amount: string
  currency: string
}

export type LongbridgeBrokerOrder = {
  orderId: string
  symbol: string
  stockName: string
  status: number
  statusLabel: string
  side: number
  sideLabel: string
  orderType: number
  orderTypeLabel: string
  quantity: string
  executedQuantity: string
  price: string | null
  executedPrice: string | null
  currency: string
  submittedAt: string
  updatedAt: string | null
  outsideRthLabel: string
  message: string
  remark: string
}

export type LongbridgeBrokerOrderStatusFilter =
  | 'ALL'
  | 'PENDING'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'

export type LongbridgeBrokerOrderSideFilter = 'ALL' | 'BUY' | 'SELL'

export type LongbridgeBrokerOrdersResponse = {
  ok: boolean
  orders: LongbridgeBrokerOrder[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  startDate: string
  endDate: string
  warnings: string[]
  error?: string
}

export type LongbridgeOrderDetailResponse =
  | {
      ok: false
      error: string
    }
  | {
      ok: true
      error?: never
      orderId: string
      symbol: string
      stockName: string
      status: number
      statusLabel: string
      side: number
      sideLabel: string
      orderType: number
      orderTypeLabel: string
      quantity: string
      executedQuantity: string
      price: string | null
      executedPrice: string | null
      currency: string
      submittedAt: string
      updatedAt: string | null
      message: string
      remark: string
      timeInForceLabel: string
      outsideRthLabel: string
      totalCharge: string
      chargeCurrency: string
      charges: LongbridgeOrderCharge[]
      executions: LongbridgeOrderExecution[]
      history: LongbridgeOrderHistoryItem[]
      checkedAt: string
    }

export type LongbridgeCombinedOrderDetailResponse = {
  ok: boolean
  orderId: string
  systemOrder?: LivePendingOrder
  brokerOrder?: Extract<LongbridgeOrderDetailResponse, { ok: true }>
  managedOrder?: ManagedOrder
  managedEvents: ManagedOrderEvent[]
  error?: string
}

export type LongbridgeHistoryKind = 'signals' | 'pending-orders' | 'candidate-pool'

export type LongbridgeHistoryPage<T> = SimulationHistoryPage<T>
