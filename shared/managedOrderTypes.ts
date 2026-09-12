export type ManagedBroker = 'futu' | 'longbridge'

export type ManagedOrderStatus =
  | 'TRACKING'
  | 'PARTIALLY_FILLED'
  | 'CANCEL_RECOMMENDED'
  | 'CANCEL_REQUESTED'
  | 'CANCEL_PENDING'
  | 'FILLED'
  | 'CANCELED'
  | 'PARTIALLY_CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN'

export type ManagedOrderDecision = {
  action: 'KEEP' | 'CANCEL'
  confidence: 'low' | 'medium' | 'high'
  source: 'hard_rule' | 'model' | 'manual'
  reason: string
  riskAssessment: string
  decidedAt: string
}

export type ManagedOrder = {
  platform: ManagedBroker
  orderId: string
  pendingOrderId: string
  signalId: string
  ticker: string
  side: string
  orderType: string
  orderSession?: string
  strategy: string
  tradeHorizon?: string
  submittedQuantity: number
  executedQuantity: number
  remainingQuantity: number
  submittedPrice: number | null
  executedPrice: number | null
  latestPrice: number | null
  priceDriftPct: number | null
  brokerStatus: string
  status: ManagedOrderStatus
  canCancel: boolean
  submittedAt: string
  brokerUpdatedAt?: string
  lastCheckedAt?: string
  terminalAt?: string
  ownershipVerified: boolean
  hardRuleReasons: string[]
  latestDecision?: ManagedOrderDecision
  cancelRequestId?: string
  cancelError?: string
  rawBrokerSnapshot?: unknown
  version: number
  createdAt: string
  updatedAt: string
}

export type ManagedOrderEvent = {
  id?: string
  requestId?: string
  platform: ManagedBroker
  orderId: string
  eventType: string
  source: 'reconcile' | 'hard_rule' | 'model' | 'manual' | 'system'
  detail: Record<string, unknown>
  createdAt: string
}

export type ManagedBrokerOrderSnapshot = {
  ok: boolean
  platform: ManagedBroker
  orderId: string
  brokerStatus: string
  status: ManagedOrderStatus
  canCancel: boolean
  submittedQuantity: number
  executedQuantity: number
  remainingQuantity: number
  submittedPrice: number | null
  executedPrice: number | null
  brokerUpdatedAt?: string
  rawResponse?: unknown
  error?: string
}

export type ManagedCancelBrokerResponse = {
  ok: boolean
  accepted: boolean
  platform: ManagedBroker
  orderId: string
  snapshot?: ManagedBrokerOrderSnapshot
  rawResponse?: unknown
  error?: string
}

export type BrokerExecutionSettings = {
  autoSubmitEnabled: boolean
  autoCancelEnabled: boolean
  blockOpeningWhenCashNegative: boolean
  marketableLimitTimeoutSeconds: number
  limitTimeoutSeconds: number
  brokerSyncIntervalSeconds: number
  modelReviewIntervalSeconds: number
  modelAutoCancelConfidence: 'high'
}

export type ManagedOrderSupervisorSnapshot = {
  running: boolean
  managedOrderCount: number
  cancellableOrderCount: number
  partiallyFilledOrderCount: number
  cancelPendingCount: number
  lastSyncAt: string
  lastModelReviewAt: string
  lastError: string
}

export type ManagedOrderListResponse = {
  ok: boolean
  orders: ManagedOrder[]
  events: ManagedOrderEvent[]
  supervisor?: ManagedOrderSupervisorSnapshot
  error?: string
}
