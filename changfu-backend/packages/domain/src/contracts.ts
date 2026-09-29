export type Purpose =
  | 'CHAT'
  | 'SINGLE_DECISION'
  | 'PORTFOLIO_REVIEW'
  | 'MANAGED_ORDER_REVIEW'
  | 'REPORT'

export type BrokerProvider = 'FUTU' | 'LONGBRIDGE'

export type ContextEnvelope = {
  schemaVersion: '1.0' | '2.0'
  requestId: string
  deviceId: string
  brokerConnectionId: string
  provider?: BrokerProvider
  purpose: Purpose
  capturedAt: string
  expiresAt: string
  sequence: number
  account: Record<string, unknown>
  positions: unknown[]
  marketSessions: unknown[]
  quotes: unknown[]
  minuteBars: unknown[]
  tickerPoints: unknown[]
  orderBooks: unknown[]
  openOrders: unknown[]
  recentDeals: unknown[]
  research?: {
    entitlementStatus: 'unavailable' | 'active' | 'expired'
    planName: string | null
    poolLimit: number
    poolSymbols: string[]
    conversationSymbols: string[]
  }
  decisionContext?: {
    strategyRequirements: Record<string, unknown>
    evidenceCatalog: unknown[]
    trendContext: unknown[]
    positionExposure: unknown[]
    accountRisk: Record<string, unknown>
    ordersKnowledge: Record<string, unknown>
    dataWindow: unknown[]
    extendedSession: unknown[]
    gapCatalog: unknown[]
    temporalBoundary: Record<string, unknown>
    outputContract: Record<string, unknown>
  }
  capabilities: ConversationCapability[]
  strategyConfigVersion?: string
  researchPoolVersion?: number
  tradingConfigVersion?: number
  catalogVersion?: string
  tradingSessionId?: string | null
  requestedSymbols?: string[]
  clientPolicyVersion: string
  dataGaps: string[]
  contentHash: string
  deviceSignature: string
}

export type ConversationCapability = {
  id: string
  kind: 'skill' | 'agent' | 'tool'
  title: string
  promptVersion: string | null
  modelProfile: 'fast' | 'deep' | 'risk' | null
  toolPolicyVersion: string | null
}

export type ContextMetadata = {
  requestId: string
  deviceId: string
  brokerConnectionId: string
  provider: BrokerProvider
  schemaVersion: '1.0' | '2.0'
  purpose: Purpose
  contentHash: string
  capturedAt: string
  expiresAt: string
  byteLength: number
  requestedSymbols: string[]
  counts: {
    positions: number
    quotes: number
    minuteBars: number
    tickerPoints: number
    orderBooks: number
    openOrders: number
    recentDeals: number
    capabilities: number
    dataGaps: number
  }
}

export type OrderIntentState =
  | 'PENDING_CONFIRMATION'
  | 'CLAIMED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'TRACKING'
  | 'PARTIALLY_FILLED'
  | 'CANCEL_REQUESTED'
  | 'CANCEL_PENDING'
  | 'CANCEL_UNCERTAIN'
  | 'UNKNOWN'
  | 'SUPERSEDED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'FAILED'
  | 'EXPIRED'

export type OrderIntentEvent =
  | 'CLAIM'
  | 'BEGIN_SUBMIT'
  | 'ACKNOWLEDGE'
  | 'PARTIAL_FILL'
  | 'FILL'
  | 'TRACK'
  | 'REQUEST_CANCEL'
  | 'CANCEL_PENDING'
  | 'CANCEL_UNCERTAIN'
  | 'CANCEL'
  | 'MARK_UNKNOWN'
  | 'SUPERSEDE'
  | 'REJECT'
  | 'FAIL'
  | 'EXPIRE'

export type ModelRunResult = {
  schemaVersion: '1.0'
  requestId: string
  status: 'COMPLETED' | 'REJECTED' | 'INTERRUPTED'
  responseType: 'RESEARCH' | 'HOLD' | 'SIGNAL' | 'CANDIDATE' | 'ORDER_DRAFT' | 'ERROR'
  summary: string
  evidence: Evidence[]
  counterEvidence: Evidence[]
  risks: string[]
  dataGaps: string[]
  exitCondition: string | null
  sourceValidUntil: string | null
  orderIntent: Record<string, unknown> | null
  proposedOrder?: {
    symbol: string
    action: 'BUY' | 'BUY_TO_COVER' | 'SELL_TO_CLOSE' | 'SELL_SHORT'
    quantity: string
    limitPrice: string
  } | null
  signal?: {
    symbol: string
    action: 'BUY' | 'SELL' | 'HOLD'
    intent?: 'HOLD' | 'BUY' | 'BUY_TO_COVER' | 'SELL_TO_CLOSE' | 'SELL_SHORT'
    confidence: number
  } | null
  candidate?: Record<string, unknown> | null
  portfolioReview?: Array<{
    candidateId: string
    status: 'PROMOTED' | 'WATCH' | 'SUPPRESSED' | 'EXPIRED'
    rank: number | null
    reason: string
  }> | null
  managedOrderReview?: Array<{
    intentId: string
    action: 'KEEP' | 'CANCEL_REMAINDER'
    reason: string
  }> | null
}

export type Evidence = {
  id: string
  kind: 'ACCOUNT' | 'POSITION' | 'QUOTE' | 'TREND' | 'ORDER' | 'RISK' | 'USER'
  summary: string
  sourceAt: string | null
}
