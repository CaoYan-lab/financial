import { randomUUID } from 'node:crypto'
import type {
  LiveAccountDashboardResponse,
  LivePendingOrder,
  Position,
  QuantSignal,
} from '../../../../shared/types.js'
import type { LongbridgeStrategyMarketData } from '../../../../shared/longbridgeTypes.js'
import { requestLivePortfolioReviewDecision } from '../../../live/livePortfolioReviewDecisionService.js'
import { requestLongbridgeLiveTradingDecision } from '../../../longbridge/longbridgeLiveDecisionService.js'
import { estimateLongbridgePreTradeFee } from '../../../longbridge/longbridgeFeeService.js'
import {
  loadLongbridgeLotSize,
  longbridgeTradingCurrency,
} from '../../../longbridge/longbridgeLotSizeService.js'
import { longbridgeOpeningRiskRejectionReason } from '../../../longbridge/longbridgeRiskService.js'
import { getLlmRuntimeConfig } from '../../../simulation/llmRuntimeConfigService.js'
import { orderSessionForMarketState } from '../../../simulation/usOvernightLlmGate.js'
import { llmSimulationTickers } from '../../../simulation/simulationUniverse.js'
import { buildTrendContextSummary } from '../../../simulation/trendContextService.js'
import { liveEvaluationSkipReason } from '../../../trading/liveEvaluationStatusService.js'
import {
  getActiveLivePortfolioReviewPrompt,
  getTradeStrategyRuntimeConfig,
} from '../../../trade_strategy/tradeStrategyConfigService.js'
import { query } from '../../db/pgClient.js'
import type { BrokerConnection } from '../types.js'
import { contextsForConnection } from './contextRegistry.js'
import { loadTenantWorkbench } from './tenantDataService.js'
import { loadTenantMarketStates } from './tenantMarketSessionService.js'
import { listActiveTenantPendingOrders } from './tenantOrderStore.js'

const STRATEGY = 'LLM_AUTONOMOUS_STOCK_TRADER' as const
type StrategyRunOptions = {
  account?: LiveAccountDashboardResponse
  marketState?: string
  now?: Date
}
type TenantSignal = Omit<QuantSignal, 'source'> & {
  source: 'longbridge-sdk-cache'
  lifecycleStatus: string
  lifecycleReason: string
}
type TenantCandidate = {
  id: string
  candidateId: string
  ticker: string
  action: QuantSignal['side']
  groupKey: string
  riskTags: string[]
  firstSeenAt: string
  lastSeenAt: string
  expiresAt: string
  signalCount: number
  priceDriftPct: number
  proposedQuantity: number
  proposedNotional: number
  confidence: string
  status: string
  signal: TenantSignal
  decision: Awaited<ReturnType<typeof requestLongbridgeLiveTradingDecision>>
  marketData: Extract<LongbridgeStrategyMarketData, { ok: true }>
  portfolioDecisionId?: string
  portfolioRank?: number
  portfolioDecisionReason?: string
}

export async function runTenantStrategyOnce(
  userId: string,
  connection: BrokerConnection,
  symbolInput?: string,
  options: StrategyRunOptions = {},
): Promise<Record<string, unknown>> {
  const symbol = normalizeSymbol(symbolInput || process.env.MULTIUSER_DEFAULT_SYMBOL || 'AAPL.US')
  const marketState = options.marketState
    ?? (await loadTenantMarketStates(connection, [symbol], options.now)).get(symbol)
    ?? 'CLOSED'
  const preflightSkipReason = tenantSessionSkipReason(
    tickerFromSymbol(symbol),
    marketState,
    options.now,
  )
  if (preflightSkipReason) {
    return {
      ok: false,
      skipped: true,
      symbol,
      marketState,
      error: preflightSkipReason,
    }
  }
  const [account, marketData] = await Promise.all([
    options.account ?? tenantAccount(connection, longbridgeTradingCurrency(symbol)),
    tenantMarketData(connection, symbol, marketState),
  ])
  if (!marketData.ok) {
    const reason = 'reason' in marketData ? marketData.reason : '行情不可用'
    await appendEvent(userId, connection.id, 'signals', 'SKIPPED', {
      id: `tenant-signal-${randomUUID()}`,
      ticker: marketData.ticker,
      side: 'HOLD',
      reason,
      generatedAt: new Date().toISOString(),
    })
    return { ok: false, symbol, error: reason }
  }

  const sessionSkipReason = tenantSessionSkipReason(
    marketData.ticker,
    marketData.marketState,
    options.now,
  )
  if (sessionSkipReason) {
    return {
      ok: false,
      skipped: true,
      symbol,
      marketState: marketData.marketState,
      error: sessionSkipReason,
    }
  }

  const trendBars = await tenantTrendBars(connection, symbol)
  const dataWindow = {
    kline1mBars: Math.max(1, marketData.bars.length),
    tickerPoints: Math.max(1, marketData.tickerPoints.length),
    orderBookDepth: Math.max(1, Math.min(marketData.asks.length, marketData.bids.length)),
    pollIntervalSeconds: 60,
    trendLookbackTradingDays: 7,
    trendBarInterval: '30m' as const,
    strategyHorizon: 'SWING_1_TO_7_DAYS' as const,
    source: 'fallback' as const,
    reason: '当前用户独立 Longbridge SDK 数据窗口。',
  }
  const decision = await requestLongbridgeLiveTradingDecision({
    symbol,
    account,
    marketData,
    dataWindow,
    trendContext: buildTrendContextSummary(
      marketData.ticker,
      { lookbackTradingDays: 7, barInterval: '30m', currentPrice: marketData.lastPrice },
      trendBars,
    ),
    managedOpenOrders: [],
  })
  const orderSession = orderSessionForMarketState(marketData.marketState)
  const existingOrders = await listActiveTenantPendingOrders(userId, connection.id)
  const conflictingOrder = existingOrders.find((order) =>
    order.intent.ticker.toUpperCase() === marketData.ticker.toUpperCase())
  const riskReason =
    conflictingOrder
      ? `当前标的已有未终态待确认订单 ${conflictingOrder.id}，本轮禁止生成重复或反向订单。`
      : decision.ok && decision.approved && decision.action !== 'HOLD' && decision.orderQuantity > 0
      ? orderSession
        ? longbridgeOpeningRiskRejectionReason(
            account,
            decision,
            decision.limitPrice || marketData.lastPrice,
            getTradeStrategyRuntimeConfig('live').activeStrategy,
            marketData.symbol,
            marketData.lotSize,
          )
        : `当前市场状态 ${marketData.marketState || '不可用'} 只允许策略研究，不允许生成真实订单。`
      : undefined
  const now = new Date().toISOString()
  const signal: TenantSignal = {
    id: `tenant-signal-${randomUUID()}`,
    ticker: marketData.ticker,
    strategy: STRATEGY,
    side: decision.action,
    confidence: decision.confidence,
    reason: decision.reason,
    price: money(marketData.lastPrice),
    quantity: String(decision.orderQuantity),
    limitPrice: money(decision.limitPrice || marketData.lastPrice),
    riskAssessment: decision.riskAssessment,
    generatedAt: now,
    dataWindow: `独立 SDK：${marketData.bars.length} 根 1 分钟 K 线、${marketData.tickerPoints.length} 条逐笔`,
    trendAlignment: decision.trendAlignment,
    tradeHorizon: decision.tradeHorizon,
    whyNotNoise: decision.whyNotNoise,
    source: 'longbridge-sdk-cache',
    rawModelOutput: decision.rawText,
    lifecycleStatus: riskReason ? 'BLOCKED_BY_RISK' : decision.action === 'HOLD' ? 'HOLD' : 'CANDIDATE_POOL',
    lifecycleReason: riskReason ?? (decision.action === 'HOLD' ? '模型建议观望。' : '已进入当前用户候选池。'),
  }
  await appendEvent(userId, connection.id, 'signals', signal.lifecycleStatus ?? 'COMPLETED', signal)

  if (riskReason || !decision.ok || !decision.approved || decision.action === 'HOLD' || decision.orderQuantity <= 0) {
    return { ok: decision.ok, symbol, signal, decision, riskReason }
  }

  const candidate: TenantCandidate = {
    id: `tenant-candidate-${randomUUID()}`,
    candidateId: `tenant-candidate-${randomUUID()}`,
    ticker: decision.ticker,
    action: decision.action,
    groupKey: `${decision.ticker}_DIRECT`,
    riskTags: ['TENANT_ISOLATED', 'SHADOW_MODE'],
    firstSeenAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    signalCount: 1,
    priceDriftPct: 0,
    proposedQuantity: decision.orderQuantity,
    proposedNotional: decision.orderQuantity * marketData.lastPrice,
    confidence: decision.confidence,
    status: 'ACTIVE',
    signal,
    decision,
    marketData,
  }
  candidate.id = candidate.candidateId
  await appendEvent(userId, connection.id, 'candidate-pool', 'ACTIVE', candidate)

  const reviewPool = await activeTenantCandidates(userId, connection.id)
  const prompt = getActiveLivePortfolioReviewPrompt()
  const preset = prompt.timingPresets.find((item) => item.id === prompt.defaultPresetId) ?? prompt.timingPresets[0]
  const review = await requestLivePortfolioReviewDecision({
    candidates: reviewPool.map(reviewCandidate),
    account,
    positions: account.positions,
    pendingOrders: existingOrders.map((order) => ({
      id: order.id,
      ticker: order.intent.ticker,
      side: order.intent.side,
      createdAt: order.createdAt,
    })),
    constraints: {
      maxPromotedOrdersPerReview: preset.maxPromotedOrdersPerReview,
      minSignalConfirmations: 1,
      leveragedEtfCooldownMinutes: preset.leveragedEtfCooldownMinutes,
      sameGroupMutualExclusion: false,
      humanConfirmationRequired: true,
    },
  }, { namespace: 'live' })
  await persistReviewStatuses(userId, connection.id, reviewPool, review)
  const promotion = review.promotedCandidates.find((item) => item.candidateId === candidate.candidateId)
  if (!review.ok || !promotion) {
    return { ok: true, symbol, signal, decision, candidate, review }
  }

  const pending = pendingOrder(decision, signal, marketData, orderSession!, candidate.candidateId, review.portfolioDecisionId)
  await appendEvent(userId, connection.id, 'pending-orders', pending.status, pending)
  return { ok: true, symbol, signal, decision, candidate, review, pendingOrder: pending }
}

export async function runTenantStrategyPoolOnce(
  userId: string,
  connection: BrokerConnection,
  options: { now?: Date } = {},
): Promise<Record<string, unknown>> {
  const universe = llmSimulationTickers().map(normalizeSymbol)
  const marketStates = await loadTenantMarketStates(connection, universe, options.now)
  const hasActiveMarket = universe.some((symbol) => !tenantSessionSkipReason(
    tickerFromSymbol(symbol),
    marketStates.get(symbol) ?? 'CLOSED',
    options.now,
  ))
  const accountByCurrency = hasActiveMarket
    ? new Map(await Promise.all(
        [...new Set(universe.map(longbridgeTradingCurrency))].map(async (currency) =>
          [currency, await tenantAccount(connection, currency)] as const),
      ))
    : undefined
  const results: Array<Record<string, unknown>> = []

  // Keep one decision in flight per tenant so candidate review and pending-order
  // deduplication remain deterministic for the shared account.
  for (const symbol of universe) {
    try {
      const result = await runTenantStrategyOnce(userId, connection, symbol, {
        account: accountByCurrency?.get(longbridgeTradingCurrency(symbol)),
        marketState: marketStates.get(symbol) ?? 'CLOSED',
        now: options.now,
      })
      const decision = result.decision as Record<string, unknown> | undefined
      const signal = result.signal as Record<string, unknown> | undefined
      results.push({
        ok: result.ok === true,
        skipped: result.skipped === true,
        symbol,
        marketState: result.marketState ?? marketStates.get(symbol),
        action: decision?.action ?? signal?.side,
        lifecycleStatus: signal?.lifecycleStatus,
        error: result.error,
      })
    } catch (error) {
      results.push({
        ok: false,
        symbol,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const succeededCount = results.filter((result) => result.ok === true).length
  const skippedCount = results.filter((result) => result.skipped === true).length
  const failedCount = results.length - succeededCount - skippedCount
  return {
    ok: failedCount === 0,
    universe,
    evaluatedCount: results.length,
    succeededCount,
    skippedCount,
    failedCount,
    results,
  }
}

async function activeTenantCandidates(userId: string, bindingId: string): Promise<TenantCandidate[]> {
  const rows = await query<{ payload: TenantCandidate }>(
    `SELECT DISTINCT ON (payload->>'candidateId') payload
     FROM multiuser.longbridge_events
     WHERE user_id = $1 AND binding_id = $2 AND kind = 'candidate-pool'
     ORDER BY payload->>'candidateId', created_at DESC, id DESC`,
    [userId, bindingId],
  )
  const now = Date.now()
  return rows
    .map((row) => row.payload)
    .filter((item) =>
      (item.status === 'ACTIVE' || item.status === 'WATCH')
      && Date.parse(item.expiresAt) > now)
}

function reviewCandidate(candidate: TenantCandidate) {
  const price = candidate.marketData.lastPrice
  return {
    candidateId: candidate.candidateId,
    ticker: candidate.ticker,
    action: candidate.action,
    groupKey: candidate.groupKey,
    riskTags: candidate.riskTags,
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    signalCount: candidate.signalCount,
    firstSignalPrice: price,
    latestSignalPrice: price,
    latestMarketPrice: price,
    priceDriftPct: candidate.priceDriftPct,
    proposedQuantity: candidate.proposedQuantity,
    proposedNotional: candidate.proposedNotional,
    confidence: candidate.confidence,
    recentReasons: [candidate.signal.reason],
  }
}

async function persistReviewStatuses(
  userId: string,
  bindingId: string,
  candidates: TenantCandidate[],
  review: Awaited<ReturnType<typeof requestLivePortfolioReviewDecision>>,
): Promise<void> {
  const byId = new Map(candidates.map((item) => [item.candidateId, item]))
  const updates = [
    ...review.promotedCandidates.map((item) => ({ ...item, status: 'PROMOTED' })),
    ...review.watchedCandidates.map((item) => ({ ...item, status: 'WATCH' })),
    ...review.suppressedCandidates.map((item) => ({ ...item, status: 'SUPPRESSED' })),
    ...review.expiredCandidates.map((item) => ({ ...item, status: 'EXPIRED' })),
  ]
  if (!review.ok && candidates.length) {
    for (const candidate of candidates) {
      await appendEvent(userId, bindingId, 'candidate-pool', 'REVIEW_FAILED', {
        ...candidate,
        status: 'REVIEW_FAILED',
        portfolioDecisionId: review.portfolioDecisionId,
        portfolioDecisionReason: review.portfolioRationale,
      })
    }
    return
  }
  for (const update of updates) {
    const candidate = byId.get(update.candidateId)
    if (!candidate) continue
    await appendEvent(userId, bindingId, 'candidate-pool', update.status, {
      ...candidate,
      status: update.status,
      portfolioDecisionId: review.portfolioDecisionId,
      portfolioRank: 'rank' in update ? update.rank : undefined,
      portfolioDecisionReason: update.reason,
    })
  }
}

async function tenantTrendBars(connection: BrokerConnection, symbol: string) {
  const { quote } = contextsForConnection(connection)
  try {
    const sdk = await import('longbridge')
    const bars = await quote.candlesticks(
      symbol,
      sdk.Period.Min_30,
      104,
      sdk.AdjustType.NoAdjust,
      sdk.TradeSessions.All,
    )
    return bars.map((item) => ({
      time: item.timestamp.toISOString(),
      open: decimal(item.open),
      high: decimal(item.high),
      low: decimal(item.low),
      close: decimal(item.close),
    }))
  } catch {
    return []
  }
}

async function tenantAccount(
  connection: BrokerConnection,
  currency: 'USD' | 'HKD' = 'USD',
): Promise<LiveAccountDashboardResponse> {
  const dashboard = await loadTenantWorkbench(connection, currency)
  const metric = (label: string) => dashboard.accountMetrics.find((item) => item.label === label)?.value ?? '$0.00'
  const positions: Position[] = dashboard.positions.map((item) => ({
    code: item.symbol,
    ticker: tickerFromSymbol(item.symbol),
    name: item.name,
    assetType: 'STOCK',
    underlyingTicker: tickerFromSymbol(item.symbol),
    quantity: item.quantity,
    marketValue: item.marketValue,
    averageCost: item.averageCost,
    currentPrice: item.currentPrice,
    todayPnL: item.todayPnL,
    unrealizedPnL: item.unrealizedPnL,
    pnlRatio: '暂无',
    positionRatio: '暂无',
    currency: item.currency,
  }))
  return {
    ok: true,
    selectedAccountId: connection.id,
    summary: {
      accountId: connection.id,
      currency,
      totalAssets: metric('账户净资产'),
      cash: metric('账户现金'),
      availableFunds: metric('账户现金'),
      buyingPower: metric('最大购买力'),
      tradingCurrency: currency,
      totalAssetsInTradingCurrency: metric('账户净资产'),
      cashInTradingCurrency: metric('账户现金'),
      availableFundsInTradingCurrency: metric('账户现金'),
      buyingPowerInTradingCurrency: metric('最大购买力'),
      dailyPnL: '暂无',
      totalPnL: '暂无',
      source: {
        source: 'Longbridge SDK tenant',
        accessedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      },
    },
    positions,
    risk: {
      concentrationRisk: '按当前用户独立持仓计算',
      largestPosition: positions[0]?.ticker ?? '无',
      cashRatio: '暂无',
      top30Overlap: '暂无',
      warnings: [],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: '当前用户默认处于影子模式。',
    },
    missingCapabilities: [],
    warnings: [],
  }
}

async function tenantMarketData(
  connection: BrokerConnection,
  symbol: string,
  marketState: string,
): Promise<LongbridgeStrategyMarketData> {
  const { quote } = contextsForConnection(connection)
  try {
    const sdk = await import('longbridge')
    const [quotes, bars, depth, trades, lotSize] = await Promise.all([
      quote.quote([symbol]),
      quote.candlesticks(symbol, sdk.Period.Min_1, 120, sdk.AdjustType.NoAdjust, sdk.TradeSessions.All),
      quote.depth(symbol),
      quote.trades(symbol, 240),
      loadLongbridgeLotSize(quote, symbol),
    ])
    const latest = quotes[0]
    const lastPrice = decimal(latest?.lastDone)
    if (!latest || lastPrice <= 0) throw new Error('行情未返回有效最新价')
    return {
      ok: true,
      ticker: tickerFromSymbol(symbol),
      symbol,
      source: 'longbridge-sdk-cache',
      lastPrice,
      bars: bars.map((item) => ({
        time: item.timestamp.toISOString(),
        open: decimal(item.open),
        high: decimal(item.high),
        low: decimal(item.low),
        close: decimal(item.close),
      })),
      tickerPoints: trades.map((item) => ({
        time: item.timestamp.toISOString(),
        price: decimal(item.price),
      })),
      asks: depth.asks.map((item, index) => ({ price: String(item.price), size: String(item.volume), depth: index + 1 })),
      bids: depth.bids.map((item, index) => ({ price: String(item.price), size: String(item.volume), depth: index + 1 })),
      bestAsk: decimal(depth.asks[0]?.price),
      bestBid: decimal(depth.bids[0]?.price),
      lotSize,
      marketState: Number(latest.tradeStatus) === 0 ? marketState : 'CLOSED',
      updatedAt: new Date().toISOString(),
      warnings: [],
    }
  } catch (error) {
    return {
      ok: false,
      ticker: tickerFromSymbol(symbol),
      symbol,
      source: 'longbridge-sdk-cache',
      reason: `当前用户行情读取失败：${error instanceof Error ? error.message : String(error)}`,
      warnings: [],
    }
  }
}

function pendingOrder(
  decision: Awaited<ReturnType<typeof requestLongbridgeLiveTradingDecision>>,
  signal: TenantSignal,
  marketData: Extract<LongbridgeStrategyMarketData, { ok: true }>,
  orderSession: 'RTH' | 'ETH',
  candidateId: string,
  portfolioDecisionId: string,
): LivePendingOrder {
  const now = new Date().toISOString()
  return {
    id: `tenant-pending-${randomUUID()}`,
    status: 'PENDING_CONFIRMATION',
    createdAt: now,
    updatedAt: now,
    intent: {
      ticker: decision.ticker,
      side: decision.action as Exclude<typeof decision.action, 'HOLD'>,
      quantity: decision.orderQuantity,
      orderType: 'MARKETABLE_LIMIT',
      orderSession,
      limitPrice: decision.limitPrice || marketData.lastPrice,
      strategy: STRATEGY,
      signalId: signal.id,
      reason: decision.reason,
      estimatedNotional: money(decision.orderQuantity * (decision.limitPrice || marketData.lastPrice)),
      feeContext: estimateLongbridgePreTradeFee(decision.orderQuantity, decision.limitPrice || marketData.lastPrice, marketData.symbol),
    },
    signal: signal as unknown as QuantSignal,
    llmDecision: decision,
    riskWarnings: ['当前用户独立影子模式：必须人工确认，且逐户实盘门禁开启后方可报单。'],
    decisionMode: 'candidate_pool',
    candidateId,
    portfolioDecisionId,
  }
}

async function appendEvent(
  userId: string,
  bindingId: string,
  kind: string,
  status: string,
  payload: unknown,
): Promise<void> {
  await query(
    `INSERT INTO multiuser.longbridge_events (user_id, binding_id, kind, status, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, bindingId, kind, status, JSON.stringify(payload)],
  )
}

function tenantSessionSkipReason(
  ticker: string,
  marketState: string,
  now?: Date,
): string | undefined {
  return liveEvaluationSkipReason({
    ticker,
    marketState,
    disableUsOvernightLlm: getLlmRuntimeConfig().config.disableUsOvernightLlm,
    now,
  })
}

function normalizeSymbol(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (normalized.includes('.')) return normalized
  if (/^\d{1,5}$/.test(normalized)) return `${normalized.replace(/^0+/, '')}.HK`
  return `${normalized}.US`
}

function tickerFromSymbol(symbol: string): string {
  const [code, market] = symbol.toUpperCase().split('.')
  return market === 'HK' ? code.padStart(5, '0') : code
}

function decimal(value: unknown): number {
  const result = Number(String(value ?? 0))
  return Number.isFinite(result) ? result : 0
}

function money(value: number): string {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '暂无'
}
