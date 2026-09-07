export type Verdict = 'Buy / Add' | 'Hold' | 'Trim'
export type Track = 'A' | 'B' | 'Both' | 'None'
export type PutSellingView = 'Avoid' | 'Low IV - Wait' | 'Only at much lower strike'
export type DataValue = string | number

export type DataSourceCitation = {
  source: string
  url?: string
  accessedAt: string
  timestamp: string
}

export type UniverseCompany = {
  sourceRank: number
  rank: number
  ticker: string
  companyName: string
  country: string
  marketCap: string
  shareClassGroup?: string
  selectedTickerReason?: string
  source: DataSourceCitation
}

export type RawCompanyData = {
  rank: number
  ticker: string
  companyName: string
  country: string
  currentPrice: string
  marketCap: string
  peRatio: string
  rsi14: string
  ma50: string
  ma200: string
  ivRank: string
  iv30: string
  nextEarningsDate: string
  capitalPerContract: string
  sevenDayNews: string
  selectedOptionCode?: string
  selectedOptionStrike?: string
  selectedOptionExpiry?: string
  selectedOptionPremium?: string
  selectedOptionDelta?: string
  selectedOptionPremiumSource?: string
  trend20d?: string
  trend60d?: string
  trend120d?: string
  distanceTo52wHigh?: string
  distanceTo52wLow?: string
  realizedVol30d?: string
  source: DataSourceCitation
}

export type DataQualityIssue = {
  ticker?: string
  field: string
  issue: string
  severity: 'info' | 'warning' | 'blocking'
}

export type DataQualityReport = {
  batchId: string
  generatedAt: string
  sources: DataSourceCitation[]
  unavailableSummary: Record<string, number>
  issues: DataQualityIssue[]
  isUsableForAnalysis: boolean
}

export type OptionStrategy = {
  ticker: string
  strike: string
  expirationDate: string
  dte: number
  premium: string
  annualizedReturn: string
  supportLevel: string
  capitalPerContract: string
  earningsFlag: string
  flags: string[]
  rationale: string
}

export type CompanyAnalysis = {
  rank: number
  ticker: string
  companyName: string
  country: string
  currentPrice: string
  ivRank: string
  verdict: Verdict
  track: Track
  rationale: string
  supportLevel: string
  earningsFlag: string
  optionStrategy?: OptionStrategy
  riskFactor?: string
  putSellingView?: PutSellingView
}

export type GroupedSummary = {
  attractiveButNotTop5: CompanyAnalysis[]
  neutralHold: CompanyAnalysis[]
  trimWatchlistRisk: CompanyAnalysis[]
}

export type AnalysisResult = {
  batchId: string
  generatedAt: string
  companyAnalyses: CompanyAnalysis[]
  topOpportunities: CompanyAnalysis[]
  bottomLosers: CompanyAnalysis[]
  groupedSummary: GroupedSummary
}

export type ReportGenerationResult = {
  batchId: string
  generatedAt: string
  reportWindowDays?: 30 | 60
  rawData: RawCompanyData[]
  dataQuality: DataQualityReport
  analysis: AnalysisResult
  markdown: string
  analysisModel?: ReportAnalysisModel
}

export type ReportMarketHeadline = {
  ticker: string
  title: string
  url?: string
  publishedAt?: string
  source: string
}

export type ReportMarketContext = {
  generatedAt: string
  source: string
  headlines: ReportMarketHeadline[]
  warnings: string[]
}

export type ReportAnalysisModel = {
  model: string
  modelLabel: string
  provider: 'ark'
  generatedBy: 'llm'
}

export type ReportPromptArchive = {
  title: string
  summary: string
  rawPrompt: string
  source: 'user-provided-fragment'
  updatedAt: string
}

export type ReportHistorySummary = {
  id: number
  batchId: string
  generatedAt: string
  reportWindowDays?: 30 | 60
  analysisModel?: ReportAnalysisModel
  rawRowCount: number
  topOpportunityTickers: string[]
  bottomLoserTickers: string[]
  isUsableForAnalysis: boolean
}

export type ReportHistoryPage = {
  items: ReportHistorySummary[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export type TopOpportunitySnapshot = {
  id: number
  reportId: number
  batchId: string
  generatedAt: string
  opportunityRank: number
  analysis: CompanyAnalysis
}

export type TopOpportunityHistoryGroup = {
  report: ReportHistorySummary
  opportunities: TopOpportunitySnapshot[]
}

export type TopOpportunityHistoryPage = {
  items: TopOpportunityHistoryGroup[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export type SourceStatusResponse = {
  futuOpenDAvailable: boolean
  futuPythonSdkAvailable: boolean
  futuOpenDLoggedIn: boolean
  optionsDataAvailable: boolean
  technicalDataAvailable: boolean
  universePrimaryAvailable: boolean
  universeFallbackAvailable: boolean
  lastCheckedAt: string
  missingCapabilities: string[]
}

export type RealtimeCallbackKind = 'quote' | 'ticker' | 'kline' | 'orderBook'

export type RealtimeQuote = {
  ticker: string
  code: string
  name?: string
  price: string
  marketState?: string
  change: string
  changePercent: string
  open: string
  high: string
  low: string
  volume: string
  updatedAt: string
}

export type RealtimePoint = {
  time: string
  price: number
}

export type RealtimeBar = {
  time: string
  open: number
  high: number
  low: number
  close: number
}

export type RealtimeOrderBookLevel = {
  price: string
  size: string
  depth: number
}

export type RealtimeCallbackStatus = Record<RealtimeCallbackKind, { updatedAt: string; count: number }>

export type RealtimeStockResponse = {
  ok: boolean
  ticker: string
  subscribed: boolean
  source: 'futu-callback' | 'mock-fallback'
  quote?: RealtimeQuote
  tickerPoints: RealtimePoint[]
  klineBars: RealtimeBar[]
  asks: RealtimeOrderBookLevel[]
  bids: RealtimeOrderBookLevel[]
  callbackStatus: RealtimeCallbackStatus
  subscriptionTickers: string[]
  warnings: string[]
  updatedAt: string
}

export type RealtimeSubscriptionStatus = {
  running: boolean
  subscribedTickers: string[]
  startedAt?: string
  lastEventAt?: string
  lastError?: string
  eventCounts: RealtimeCallbackStatus
}

export type AccountSummary = {
  accountId: string
  currency: string
  totalAssets: string
  cash: string
  availableFunds: string
  buyingPower: string
  dailyPnL: string
  totalPnL: string
  source: DataSourceCitation
}

export type Position = {
  code: string
  ticker: string
  name: string
  assetType: 'STOCK' | 'OPTION' | 'ETF' | 'OTHER'
  underlyingTicker: string
  optionType?: string
  strike?: string
  expirationDate?: string
  contractSummary?: string
  quantity: string
  marketValue: string
  averageCost: string
  currentPrice: string
  todayPnL: string
  unrealizedPnL: string
  pnlRatio: string
  positionRatio: string
  currency: string
}

export type EstimatedPositionFeeContext = {
  source: 'estimated'
  currency: string
  positionQuantity: number
  absPositionQuantity: number
  averageCost: number | null
  currentPrice: number | null
  grossUnrealizedPnL: number | null
  estimatedEntryFee: number | null
  estimatedExitFee: number | null
  estimatedRoundTripFee: number | null
  estimatedNetUnrealizedPnL: number | null
  estimatedExitFeeRatioToGrossPnL: number | null
  grossProfitButNetLoss: boolean
  note: string
}

export type PortfolioRiskSummary = {
  concentrationRisk: string
  largestPosition: string
  cashRatio: string
  top30Overlap: string
  warnings: string[]
}

export type TradingEnvironmentStatus = {
  environment: 'REAL' | 'SIMULATE' | 'UNKNOWN'
  liveTradingEnabled: boolean
  requiresConfirmation: boolean
  warning: string
}

export type AccountDashboardResponse = {
  ok: boolean
  summary: AccountSummary
  positions: Position[]
  risk: PortfolioRiskSummary
  trading: TradingEnvironmentStatus
  missingCapabilities: string[]
}

export type TradePreviewRequest = {
  ticker: string
  side: 'BUY' | 'SELL'
  quantity: number
  orderType: 'LIMIT' | 'MARKET'
  limitPrice?: number
  confirmLiveTrade?: boolean
  confirmationText?: string
}

export type TradePreviewResponse = {
  ok: boolean
  orderSide: string
  ticker: string
  quantity: string
  orderType: string
  limitPrice: string
  estimatedNotional: string
  riskWarnings: string[]
  canSubmitLiveOrder: boolean
}

export type SimulationAccount = {
  accountId: string
  trdEnv: 'SIMULATE'
  accType: string
  simAccType: string
  trdMarketAuth: string
  currency: string
  source: DataSourceCitation
}

export type SimulationAccountDashboardResponse = {
  ok: boolean
  accounts: SimulationAccount[]
  selectedAccountId: string
  summary: AccountSummary
  positions: Position[]
  trading: TradingEnvironmentStatus
  warnings: string[]
}

export type QuantStrategyName = 'LLM_AUTONOMOUS_STOCK_TRADER'

export type QuantSignalSide = 'BUY' | 'SELL_SHORT' | 'SELL_TO_CLOSE' | 'HOLD'

export type SimulationUniverseItem = {
  ticker: string
  label: string
  marketSession?: MarketSessionStatus
}

export type MarketSessionStatus = {
  ticker: string
  code: string
  state: string
  labelZh: string
  labelEn: string
  tradable: boolean
  allowsExtendedHours: boolean
  updatedAt: string
}

export type LlmDataWindowRecommendation = {
  kline1mBars: number
  tickerPoints: number
  orderBookDepth: number
  pollIntervalSeconds: number
  trendLookbackTradingDays?: number
  trendBarInterval?: '15m' | '30m' | '1d'
  strategyHorizon?: 'INTRADAY' | 'SWING_1_TO_7_DAYS'
  reason: string
  source: 'llm' | 'fallback'
}

export type TrendContextWindow = {
  lookbackTradingDays: number
  barInterval: '15m' | '30m' | '1d'
  source: 'futu-history-kline'
  available: boolean
  reason?: string
}

export type TrendContextSummary = {
  ticker: string
  window: TrendContextWindow
  currentPrice: number
  previousClose?: number
  sevenDayHigh?: number
  sevenDayLow?: number
  pricePositionInRange?: number
  trendDirection: 'UP' | 'DOWN' | 'SIDEWAYS' | 'UNKNOWN'
  trendStrength: 'WEAK' | 'MEDIUM' | 'STRONG' | 'UNKNOWN'
  volatilityLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN'
  movingAverages: {
    short?: number
    medium?: number
    long?: number
  }
  supportLevels: number[]
  resistanceLevels: number[]
  summary: string
  updatedAt: string
}

export type LlmModelOption = {
  id: string
  label: string
  provider: 'ark'
  apiKeyEnv?: string
  urlEnv?: string
  defaultUrl?: string
  requestProtocol?: 'responses' | 'chat_completions'
}

export type LlmRuntimeConfig = {
  model: string
  modelLabel: string
  concurrency: number
  maxConcurrency: number
  updatedAt: string
}

export type LlmRuntimeConfigResponse = {
  ok: boolean
  config: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  warnings: string[]
}

export type UpdateLlmRuntimeConfigRequest = {
  model?: string
  concurrency?: number
}

export type QuantSignal = {
  historyId?: number
  id: string
  ticker: string
  strategy: QuantStrategyName
  model?: string
  modelLabel?: string
  side: QuantSignalSide
  confidence: string
  reason: string
  price: string
  quantity: string
  limitPrice: string
  riskAssessment: string
  generatedAt: string
  dataWindow: string
  trendContext?: {
    available: boolean
    lookbackTradingDays: number
    barInterval: string
    trendDirection: string
    trendStrength: string
    pricePositionInRange?: number
    summary: string
  }
  trendAlignment?: string
  tradeHorizon?: string
  whyNotNoise?: string
  source: 'futu-callback'
  rawModelOutput?: string
}

export type LlmTradingDecision = {
  ok: boolean
  approved: boolean
  action: QuantSignalSide
  ticker: string
  orderQuantity: number
  limitPrice: number
  confidence: string
  reason: string
  riskAssessment: string
  trendAlignment?: 'WITH_TREND' | 'AGAINST_TREND' | 'REVERSAL_ATTEMPT' | 'NO_TREND' | 'UNAVAILABLE'
  tradeHorizon?: 'SCALP' | 'INTRADAY' | 'SWING_1_TO_7_DAYS'
  whyNotNoise?: string
  dataWindowUsed: {
    kline1mBars: number
    tickerPoints: number
    orderBookDepth: number
  }
  rawText?: string
  error?: string
}

export type SimulatedOrderIntent = {
  ticker: string
  side: Exclude<QuantSignalSide, 'HOLD'>
  quantity: number
  orderType: 'LIMIT' | 'MARKETABLE_LIMIT' | 'MARKET'
  orderSession: 'RTH' | 'ETH'
  limitPrice: number
  strategy: QuantStrategyName
  signalId: string
  reason: string
  sizingReason?: string
  estimatedNotional?: string
  estimatedRoundTripFee?: string
}

export type SimulatedOrderResult = {
  historyId?: number
  ok: boolean
  orderId: string
  ticker: string
  side: string
  quantity: string
  orderType: string
  orderSession?: string
  limitPrice: string
  submittedAt: string
  strategy: QuantStrategyName
  signalId: string
  llmDecision?: LlmTradingDecision
  rawResponse?: unknown
  error?: string
}

export type FutuSimulationOrder = {
  orderId: string
  ticker: string
  code: string
  side: string
  orderType: string
  orderSession?: string
  orderStatus: string
  orderStatusLabel: string
  quantity: string
  filledQuantity: string
  remainingQuantity: string
  price: string
  filledAveragePrice: string
  createTime: string
  updatedTime: string
  dealtAmount: string
  currency: string
  remark: string
  rawResponse?: unknown
}

export type FutuSimulationOrdersResponse = {
  ok: boolean
  orders: FutuSimulationOrder[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  startDate: string
  endDate: string
  accountId: string
  warnings: string[]
}

export type SimulationLinkedOrderDetailResponse = {
  ok: boolean
  source: 'history-order' | 'futu-order'
  historyOrder?: SimulatedOrderResult
  signal?: QuantSignal
  futuOrder?: FutuSimulationOrder
  warnings: string[]
}

export type SimulationEngineStatus = {
  running: boolean
  mode: 'SIMULATE'
  accountId: string
  startedAt: string
  lastRunAt: string
  nextRunAt: string
  universe: string[]
  strategy: QuantStrategyName
  runIntervalMs: number
  submittedOrderCount: number
  signalCount: number
  lastError: string
  dataWindow?: LlmDataWindowRecommendation
}

export type SimulationSkippedTicker = {
  ticker: string
  reason: string
  updatedAt: string
}

export type SimulationHistoryKind = 'signals' | 'orders' | 'skipped'

export type SimulationHistoryPage<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export type SimulationDashboardResponse = {
  account: SimulationAccountDashboardResponse
  engine: SimulationEngineStatus
  universe: SimulationUniverseItem[]
  llmRuntimeConfig: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  latestSignals: QuantSignal[]
  latestOrders: SimulatedOrderResult[]
  skippedTickers: SimulationSkippedTicker[]
  warnings: string[]
}

export type LiveFeeSource = 'estimated_pre_trade' | 'actual_post_trade' | 'unavailable'

export type LiveOrderFeeDetail = {
  item: string
  amount: number
}

export type LiveOrderFeeContext = {
  source: LiveFeeSource
  orderId?: string
  currency: string
  feeAmount: number | null
  feeDetails: LiveOrderFeeDetail[]
  estimatedAmount?: number | null
  queriedAt?: string
  warning?: string
}

export type LiveAccountDashboardResponse = AccountDashboardResponse & {
  selectedAccountId: string
  warnings: string[]
}

export type LiveEngineStatus = {
  running: boolean
  mode: 'REAL'
  accountId: string
  startedAt: string
  lastRunAt: string
  nextRunAt: string
  universe: string[]
  strategy: QuantStrategyName
  runIntervalMs: number
  pendingOrderCount: number
  submittedOrderCount: number
  signalCount: number
  lastError: string
  dataWindow?: LlmDataWindowRecommendation
}

export type LiveOrderIntent = {
  ticker: string
  side: Exclude<QuantSignalSide, 'HOLD'>
  quantity: number
  orderType: 'LIMIT' | 'MARKETABLE_LIMIT' | 'MARKET'
  orderSession: 'RTH' | 'ETH'
  limitPrice: number
  strategy: QuantStrategyName
  signalId: string
  reason: string
  sizingReason?: string
  estimatedNotional?: string
  feeContext: LiveOrderFeeContext
}

export type LivePendingOrderStatus =
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED_SUBMITTING'
  | 'SUBMITTED'
  | 'REJECTED_BY_USER'
  | 'BLOCKED_BY_RISK'
  | 'SUBMIT_FAILED'

export type LivePendingOrder = {
  historyId?: number
  id: string
  status: LivePendingOrderStatus
  createdAt: string
  updatedAt: string
  intent: LiveOrderIntent
  signal: QuantSignal
  llmDecision: LlmTradingDecision
  riskWarnings: string[]
  decisionMode?: 'legacy_direct' | 'candidate_pool' | 'trading_agent'
  candidateId?: string
  portfolioDecisionId?: string
  confirmation?: LiveOrderConfirmation
  submittedOrder?: LiveOrderResult
}

export type LiveOrderConfirmation = {
  confirmedAt: string
  confirmationId: string
  confirmedBy: 'user'
}

export type LiveOrderResult = {
  historyId?: number
  ok: boolean
  orderId: string
  ticker: string
  side: string
  quantity: string
  orderType: string
  orderSession?: string
  limitPrice: string
  submittedAt: string
  strategy: QuantStrategyName
  signalId: string
  pendingOrderId: string
  feeContext?: LiveOrderFeeContext
  llmDecision?: LlmTradingDecision
  rawResponse?: unknown
  error?: string
}

export type FutuLiveOrder = FutuSimulationOrder & {
  feeContext?: LiveOrderFeeContext
}

export type FutuLiveOrdersResponse = Omit<FutuSimulationOrdersResponse, 'orders'> & {
  orders: FutuLiveOrder[]
}

export type FutuLiveDeal = {
  dealId: string
  orderId: string
  ticker: string
  side: string
  quantity: string
  price: string
  dealtAmount: string
  createdAt: string
  counterBrokerId: string
  counterBrokerName: string
  rawResponse?: unknown
}

export type FutuLiveOrderDetailResponse =
  | {
      ok: false
      error: string
      warnings: string[]
    }
  | {
      ok: true
      error?: never
      order: FutuLiveOrder
      deals: FutuLiveDeal[]
      checkedAt: string
      warnings: string[]
    }

export type LiveSkippedTicker = SimulationSkippedTicker

export type LiveHistoryKind = 'signals' | 'pending_orders' | 'submitted_orders' | 'rejected_orders' | 'skipped' | 'confirmations'

export type LiveTradingDashboardResponse = {
  account: LiveAccountDashboardResponse
  engine: LiveEngineStatus
  universe: SimulationUniverseItem[]
  llmRuntimeConfig: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  latestSignals: QuantSignal[]
  pendingOrders: LivePendingOrder[]
  submittedOrders: LiveOrderResult[]
  skippedTickers: LiveSkippedTicker[]
  warnings: string[]
  liveTradingEnabled: boolean
  autoSubmitEnabled: boolean
  autoCancelEnabled: boolean
  marketableLimitTimeoutSeconds: number
  limitTimeoutSeconds: number
  brokerSyncIntervalSeconds: number
  modelReviewIntervalSeconds: number
}
