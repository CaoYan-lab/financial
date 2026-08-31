import type { AShareTradingAgentRoleReport, AShareTradingAgentRun, AccountSummary, Position, RealtimeBar, RealtimeCallbackStatus, RealtimeOrderBookLevel, RealtimePoint, RealtimeQuote } from '../../shared/types.js'
import type { AShareUniverseItem } from './types.js'

export type AShareStockNewsArticle = {
  title: string
  source: string
  publishedAt?: string
  url?: string
  summary?: string
}

export type AShareStockNewsContext = {
  source: 'futu-news'
  status: 'OK' | 'UNAVAILABLE' | 'ERROR'
  generatedAt: string
  articles: AShareStockNewsArticle[]
  warnings: string[]
}

export type AShareFutuStockContext = {
  source: 'futu-openapi'
  status: 'OK' | 'PARTIAL' | 'UNAVAILABLE' | 'ERROR'
  generatedAt: string
  futuCode: string
  sections: {
    researchRatingSummary?: unknown
    analystConsensus?: unknown
    morningstarReport?: unknown
    financialUnusual?: unknown
    capitalFlow?: unknown
    capitalDistribution?: unknown
    marketState?: unknown
    globalState?: unknown
  }
  warnings: string[]
}

export type AShareMarketDataContext = {
  source: 'futu-callback'
  status: 'OK' | 'PARTIAL'
  quote?: RealtimeQuote
  recentKlineBars: RealtimeBar[]
  recentTickerPoints: RealtimePoint[]
  asks: RealtimeOrderBookLevel[]
  bids: RealtimeOrderBookLevel[]
  callbackStatus: RealtimeCallbackStatus
  updatedAt: string
}

export type MacroNewsRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' | 'UNAVAILABLE'

export type MacroNewsArticle = {
  title: string
  source: string
  publishedAt?: string
  url?: string
  summary?: string
  topic?: string
}

export type MacroNewsPromptContext = {
  source: 'Doubao Search Custom shared snapshot' | 'Longbridge CLI shared snapshot'
  priority: 'below_hard_constraints_and_market_facts'
  snapshot: {
    generatedAt: string
    riskLevel: MacroNewsRiskLevel
    summary: string
    keyRisks: string[]
    articles: MacroNewsArticle[]
    warnings: string[]
  }
  rules: string[]
}

export type AShareTradingAgentDataContext = {
  ticker: string
  futuCode: string
  name: string
  generatedAt: string
  marketDataContext: AShareMarketDataContext
  futuStockContext: AShareFutuStockContext
  stockNewsContext: AShareStockNewsContext
  macroNewsContext: MacroNewsPromptContext
  accountPositionContext?: {
    source: 'futu-account'
    targetTicker: string
    targetLongQuantity: number
    matchingPositions: Position[]
    rule: string
  }
  sizingContext: {
    source: 'node-adapter'
    currency: 'CNY'
    lotSize: number
    lastPrice: number | null
    limitPrice: number | null
    availableFunds: number | null
    buyingPower: number | null
    targetLongQuantity: number
    targetMarketValue: number | null
    targetAverageCost: number | null
    maxSingleOrderNotional: number
    maxPositionRatio: number
    estimatedFeeRate: number
    minBuyNotional: number | null
    accountSummary?: AccountSummary
    rules: string[]
  }
  aShareRulesContext: Record<string, unknown>
  universeContext: {
    size: number
    tickers: string[]
    current: AShareUniverseItem
  }
  dataQualityContext: {
    status: 'OK' | 'PARTIAL' | 'BLOCKING'
    warnings: string[]
  }
}

export type AShareTradingAgentBridgeRoleResult = AShareTradingAgentRoleReport & {
  modelType?: 'quick' | 'deep'
}

export type AShareTradingAgentContextBridgeResponse = {
  ok: boolean
  source?: string
  repoPath?: string
  ticker?: string
  tradeDate?: string
  action?: 'HOLD' | 'BUY' | 'SELL_TO_CLOSE'
  decision?: string
  roleReports?: AShareTradingAgentBridgeRoleResult[]
  finalDecision?: Record<string, unknown>
  rawDecision?: string
  error?: string
}

export type AShareTradingAgentRunRecord = AShareTradingAgentRun
