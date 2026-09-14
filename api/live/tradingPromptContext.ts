import { createHash } from 'node:crypto'
import type { LiveAccountDashboardResponse, LlmTradingDecision, TrendContextSummary } from '../../shared/types.js'
import type { TradingPromptBroker } from '../../shared/tradingPromptTypes.js'
import type { ManagedOrder } from '../../shared/managedOrderTypes.js'
import type { ProductionPromptContext } from './tradingPromptV2.js'
import { getTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import { parseMoney } from '../longbridge/longbridgeRiskService.js'
import { financingOpeningStatus, verifiedCloseQuantity } from './brokerFinancingRisk.js'
import { estimatePreTradeFee } from './liveFeeService.js'

type Market = { ticker: string; updatedAt?: string; lastPrice?: number; bestAsk?: number; bestBid?: number; marketState?: string; lotSize?: number; bars?: unknown[]; asks?: unknown[]; bids?: unknown[]; ok?: boolean }
export type CandidateMarketEvidence = {
  ticker: string
  sourceAt: string | null
  valid: boolean
  market: Market | null
  trend: TrendContextSummary | null
  currency: string
  plan: { riskPlanId: string; action: string; quantity: number; limitPrice: number; invalidationPrice: number | null; exitCondition: string | null }
  costs: { source: string; feeAmount: number | null; currency: string; warning: string }
}

const normalizedTicker = (ticker: string) => ticker.toUpperCase().replace(/^US\.|^HK\./, '').replace(/\.US$|\.HK$/, '')
const fresh = (sourceAt?: string | null) => !!sourceAt && Number.isFinite(Date.parse(sourceAt)) && Date.parse(sourceAt) <= Date.now() + 5000 && Date.now() - Date.parse(sourceAt) <= 60000
const currencyForTicker = (ticker: string) => /^\d+$/.test(normalizedTicker(ticker)) ? 'HKD' : 'USD'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
function marketSnapshot(market?: Market | null): Market | null {
  if (!market) return null
  return {
    ticker: normalizedTicker(market.ticker), updatedAt: market.updatedAt, lastPrice: market.lastPrice,
    bestAsk: market.bestAsk, bestBid: market.bestBid, marketState: market.marketState,
    lotSize: market.lotSize, bars: market.bars?.slice(-30), asks: market.asks?.slice(0, 5), bids: market.bids?.slice(0, 5),
  }
}
function validUntil(times: Array<string | null | undefined>): string | null {
  if (!times.length || times.some(t => !t || !Number.isFinite(Date.parse(t)) || Date.parse(t) > Date.now() + 5000)) return null
  return new Date(Math.min(...times.map(t => Date.parse(t!))) + 60000).toISOString()
}

export function productionAccountRisk(broker: TradingPromptBroker, account: LiveAccountDashboardResponse, reservedRisk = 0) {
  const s = account.summary, accessedAt = s.source?.timestamp ?? s.source?.accessedAt
  const level = s.financingRiskLevel
  const normalized = financingOpeningStatus(broker, s)
  const openingRiskStatus = !account.ok || !fresh(accessedAt) ? 'UNKNOWN' : normalized
  const equity = parseMoney(s.totalAssetsInTradingCurrency ?? s.totalAssets)
  const strategy = getTradeStrategyRuntimeConfig('live').activeStrategy
  const heatPct = Number(strategy.riskControls?.portfolioHeat?.maxPctEquity)
  const tradePct = Number(strategy.riskControls?.perTradeLossBudget?.maxPctEquity)
  const maxPortfolioRisk = equity !== undefined && equity > 0 && heatPct > 0 ? equity * heatPct : null
  const maxPerTradeRisk = equity !== undefined && equity > 0 && tradePct > 0 ? equity * tradePct : null
  const effectiveReservedRisk = Number.isFinite(reservedRisk) && reservedRisk >= 0
    ? reservedRisk
    : maxPortfolioRisk
  const availableRiskBudget = maxPortfolioRisk === null || effectiveReservedRisk === null
    ? null
    : Math.max(0, maxPortfolioRisk - effectiveReservedRisk)
  return {
    openingRiskStatus, sourceAt: accessedAt ?? null, availableRiskBudget, reservedRisk: effectiveReservedRisk,
    maxPortfolioRisk, maxPerTradeRisk,
    reason: normalized === 'UNKNOWN' ? '融资风险原始字段未可靠映射，不能推断安全' : '按策略权益风险上限扣除当前待确认订单预留',
    rawExposureLevel: s.futuExposureLevel ?? null, rawRiskStatus: s.futuRiskStatus ?? null,
    broker, financingLevel: broker === 'longbridge' ? level ?? null : null,
    initialMargin: s.initialMargin ?? null, maintenanceMargin: s.maintenanceMargin ?? null,
    marginCall: s.marginCall ?? null, financingOpeningRestricted: s.financingOpeningRestricted ?? null,
  }
}
function accountFacts(account: LiveAccountDashboardResponse) {
  const s = account.summary
  return {
    ok: account.ok, currency: s.tradingCurrency ?? s.currency,
    equity: parseMoney(s.totalAssetsInTradingCurrency ?? s.totalAssets) ?? null,
    buyingPower: parseMoney(s.buyingPowerInTradingCurrency ?? s.buyingPower) ?? null,
    cash: parseMoney(s.cashInTradingCurrency ?? s.cash) ?? null,
    sourceAt: s.source?.timestamp ?? s.source?.accessedAt ?? null,
    positions: account.positions.map(p => ({
      ticker: p.ticker, assetType: p.assetType, quantity: parseMoney(p.quantity) ?? null,
      currentPrice: p.currentPrice, averageCost: p.averageCost, currency: p.currency, unrealizedPnL: p.unrealizedPnL,
      availableToClose: verifiedCloseQuantity(p.availableToClose, parseMoney(p.quantity) ?? null),
    })),
  }
}

export function buildSingleProductionContext(broker: TradingPromptBroker, input: {
  account: LiveAccountDashboardResponse; marketData: Market; trendContext?: TrendContextSummary
  managedOpenOrders?: ManagedOrder[]; pendingOrders?: Array<{ ticker: string; [key: string]: unknown }>
  scope?: string
}): ProductionPromptContext {
  const ticker = normalizedTicker(input.marketData.ticker)
  const account = accountFacts(input.account), market = marketSnapshot(input.marketData)!
  const currency = currencyForTicker(ticker)
  const direct = account.positions.filter(p => normalizedTicker(p.ticker) === ticker && ['STOCK', 'ETF'].includes(p.assetType))
  const known = input.account.ok && fresh(account.sourceAt) && direct.every(p => p.quantity !== null)
  const quantity = known ? direct.reduce((sum, p) => sum + p.quantity!, 0) : null
  const pendingRisk = reservedPendingRisk(input.pendingOrders ?? [])
  const dataGaps = ['融资与借券成本未知']
  if (!known || direct.some(p => p.availableToClose === null)) dataGaps.push('券商可平数量未提供')
  if (financingOpeningStatus(broker, input.account.summary) === 'UNKNOWN') dataGaps.push('融资风险字段未知')
  if (account.currency !== currency) dataGaps.push('账户币种与标的币种不一致')
  const ordersKnowledge = input.managedOpenOrders && input.pendingOrders ? 'known' : 'unknown'
  if (ordersKnowledge === 'unknown') dataGaps.push('未确认完整托管/待确认订单范围')
  const strategy = getTradeStrategyRuntimeConfig('live').activeStrategy
  const facts = {
    instrument: { ticker, currency, lotSize: /^\d+$/.test(ticker) ? market.lotSize ?? null : 1 },
    account, risk: productionAccountRisk(broker, input.account, pendingRisk), marketData: market,
    trendContext: input.trendContext ?? null,
    position: { known, quantity, availableToClose: known && direct.every(p => p.availableToClose !== null) ? direct.reduce((sum, p) => sum + p.availableToClose!, 0) : null },
    ordersKnowledge,
    orders: [...(input.managedOpenOrders ?? []).map(o => ({ ticker: normalizedTicker(o.ticker), status: o.status, remainingQuantity: o.remainingQuantity, sourceAt: o.lastCheckedAt ?? null })),
      ...(input.pendingOrders ?? []).map(o => ({ ticker: normalizedTicker(o.ticker), status: 'PENDING_CONFIRMATION', sourceAt: null }))],
    policy: { id: strategy.id, riskControls: strategy.riskControls, trendFilters: strategy.trendFilters },
    costs: { source: 'unavailable', reason: '数量尚未确定，不将固定每股成本当成真实费用；融资借券成本未知。' },
  }
  return {
    broker, role: 'single', scope: input.scope ?? input.account.selectedAccountId ?? input.account.summary.accountId,
    facts, dataGaps, sourceValidUntil: validUntil([account.sourceAt, market.updatedAt]),
    evidence: [{ id: 'E1', path: 'account' }, { id: 'E2', path: 'risk' }, { id: 'E3', path: 'marketData', ticker }, { id: 'E4', path: 'trendContext', ticker }, { id: 'E5', path: 'orders' }, { id: 'E6', path: 'position', ticker }],
  }
}

export function candidateProductionEvidence(input: {
  ticker: string; decision: LlmTradingDecision; marketData?: Market; trendContext?: TrendContextSummary
}): CandidateMarketEvidence {
  const ticker = normalizedTicker(input.ticker), m = marketSnapshot(input.marketData)
  const currency = currencyForTicker(ticker)
  const raw = input.decision.promptAudit?.output
  const invalidation = typeof raw?.invalidationPrice === 'number' ? raw.invalidationPrice : null
  const riskPlanId = hash([ticker, input.decision.action, input.decision.orderQuantity, input.decision.limitPrice, invalidation, m?.updatedAt])
  const fee = currency === 'USD' && input.decision.orderQuantity > 0 && input.decision.limitPrice > 0
    ? estimatePreTradeFee(input.decision.orderQuantity, input.decision.limitPrice, currency) : null
  return {
    ticker, sourceAt: m?.updatedAt ?? null, valid: !!m && m.ticker === ticker && fresh(m.updatedAt),
    market: m, trend: input.trendContext?.ticker === ticker ? input.trendContext : null, currency,
    plan: { riskPlanId, action: input.decision.action, quantity: input.decision.orderQuantity, limitPrice: input.decision.limitPrice, invalidationPrice: invalidation, exitCondition: typeof raw?.exitCondition === 'string' ? raw.exitCondition : null },
    costs: { source: fee ? 'estimated_pre_trade' : 'unavailable', feeAmount: fee?.feeAmount ?? null, currency, warning: '已有USD费用模型估算，非券商确认费用；HKD模型与融资借券成本不可用，不填0。' },
  }
}

export function buildPortfolioProductionContext(broker: TradingPromptBroker, input: {
  account: LiveAccountDashboardResponse; candidates: Array<{ candidateId: string; ticker: string; action: string; firstSeenAt: string; marketEvidence?: CandidateMarketEvidence; [key: string]: any }>
  positions?: LiveAccountDashboardResponse['positions']
  pendingOrders: Array<{ ticker: string; [key: string]: any }>; constraints: Record<string, any>
}, scope?: string): ProductionPromptContext {
  const candidatePool = input.candidates.map((c, i) => {
    const e = c.marketEvidence
    const owned = !!e && e.ticker === c.ticker && e.market?.ticker === c.ticker
    const directQuantity = (input.positions ?? input.account.positions)
      .filter(p => ['STOCK', 'ETF'].includes(p.assetType) && normalizedTicker(p.ticker) === normalizedTicker(c.ticker))
      .reduce((sum, p) => sum + (parseMoney(p.quantity) ?? 0), 0)
    const positionEffect = c.action === 'SELL_TO_CLOSE' ? 'REDUCE_LONG'
      : c.action === 'BUY' && directQuantity < 0 ? 'COVER_SHORT'
        : 'OPEN'
    const opening = positionEffect === 'OPEN'
    const riskBudgetUsed = !opening ? 0 : owned && e.plan.invalidationPrice !== null
      ? Math.abs(e.plan.limitPrice - e.plan.invalidationPrice) * e.plan.quantity + (e.costs.feeAmount ?? 0) * 2
      : null
    return {
      ...c, evidenceId: `C${i + 1}`, marketEvidence: owned ? { ...e, valid: e.valid && fresh(e.sourceAt) } : null,
      positionEffect,
      riskPlanId: owned ? e.plan.riskPlanId : `unavailable-${i + 1}`,
      riskBudgetUsed,
      rankingMetrics: riskBudgetUsed === null ? null : {
        netRewardRiskBps: null,
        riskBudgetUsed,
        absPriceDriftBps: Math.round(Math.abs(Number(c.priceDriftPct) || 0) * 100),
        firstSeenAt: c.firstSeenAt,
        ticker: c.ticker,
        candidateId: c.candidateId,
      },
      missing: ['目标价格和融资借券成本未结构化，收益风险比不计算'],
    }
  })
  const account = accountFacts(input.account)
  return {
    broker, role: 'portfolio', scope: scope ?? input.account.selectedAccountId ?? input.account.summary.accountId,
    facts: {
      candidatePool, account, risk: productionAccountRisk(broker, input.account, input.pendingOrders.length ? Number.POSITIVE_INFINITY : 0),
      orders: input.pendingOrders.map(o => ({ ticker: normalizedTicker(o.ticker), side: o.side, createdAt: o.createdAt })),
      constraints: input.constraints,
      rankingPolicy: ['netRewardRiskBps DESC', 'riskBudgetUsed ASC', 'absPriceDriftBps ASC', 'firstSeenAt ASC', 'ticker ASCII ASC', 'candidateId ASCII ASC'],
    },
    dataGaps: [...(input.pendingOrders.length ? ['存在未终态订单，风险释放前禁止新增开仓晋级'] : []), ...(financingOpeningStatus(broker, input.account.summary) === 'UNKNOWN' ? ['融资风险字段未知'] : []),
      ...candidatePool.filter(c => !c.marketEvidence?.valid).map(c => `${c.ticker}候选行情缺失或过期`)],
    sourceValidUntil: validUntil([account.sourceAt, ...candidatePool.map(c => c.marketEvidence?.sourceAt)]),
    evidence: [{ id: 'E1', path: 'account' }, { id: 'E2', path: 'risk' }, { id: 'E3', path: 'orders' },
      ...candidatePool.map((c, i) => ({ id: c.evidenceId, path: `candidatePool.${i}.marketEvidence`, ticker: c.ticker }))],
  }
}

function reservedPendingRisk(orders: Array<Record<string, any>>): number {
  let total = 0
  for (const order of orders) {
    const intent = order.intent
    const output = order.llmDecision?.promptAudit?.output
    if (!intent || !output || typeof output.invalidationPrice !== 'number') return Number.POSITIVE_INFINITY
    const quantity = Number(intent.quantity)
    const price = Number(intent.limitPrice)
    if (!(quantity > 0) || !(price > 0)) return Number.POSITIVE_INFINITY
    total += Math.abs(price - output.invalidationPrice) * quantity
  }
  return total
}

export function buildManagedProductionContext(broker: TradingPromptBroker, orders: Array<{
  order: ManagedOrder; account: Record<string, any>; marketData: unknown; accountSnapshot?: LiveAccountDashboardResponse
}>, scope?: string): ProductionPromptContext {
  return {
    broker, role: 'managed',
    scope: scope ?? orders[0]?.accountSnapshot?.selectedAccountId ?? 'unavailable',
    facts: { orders: orders.map(c => ({
      order: {
        orderId: c.order.orderId, ticker: c.order.ticker, status: c.order.status, canCancel: c.order.canCancel,
        ownershipVerified: c.order.ownershipVerified, remainingQuantity: c.order.remainingQuantity,
        executedQuantity: c.order.executedQuantity, side: c.order.side, lastCheckedAt: c.order.lastCheckedAt ?? null,
      },
      positionEffect: c.order.positionEffect ?? 'UNKNOWN',
      orderFresh: fresh(c.order.lastCheckedAt),
      account: c.accountSnapshot ? accountFacts(c.accountSnapshot) : c.account,
      risk: c.accountSnapshot ? productionAccountRisk(broker, c.accountSnapshot) : { openingRiskStatus: 'UNKNOWN' },
      marketData: marketSnapshot(c.marketData as Market),
    })) },
    dataGaps: ['原订单开平仓效果尚未持久化，不能仅从BUY/SELL推断', '组合风险预留未知'],
    sourceValidUntil: validUntil(orders.flatMap(c => [c.order.lastCheckedAt, c.accountSnapshot?.summary.source?.timestamp])),
    evidence: orders.map((c, i) => ({ id: `O${i + 1}`, path: `orders.${i}`, ticker: c.order.ticker })),
  }
}
