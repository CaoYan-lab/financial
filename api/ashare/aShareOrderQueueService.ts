import type { LiveOrderConfirmation, LiveOrderFeeContext, LiveOrderResult, LivePendingOrder, LlmTradingDecision, QuantSignal, QuantStrategyName } from '../../shared/types.js'
import { aSharePersistence } from './aSharePersistence.js'
import { loadLiveAccountDashboard } from '../live/liveAccountService.js'
import { submitLiveOrder } from '../live/futuLiveOrderService.js'
import { validateAshareDecision } from './aShareRiskService.js'

const MAX_ITEMS = 500
const STRATEGY: QuantStrategyName = 'LLM_AUTONOMOUS_STOCK_TRADER'

class AShareOrderQueueService {
  private readonly signals: QuantSignal[] = aSharePersistence.readLatest('signals', MAX_ITEMS)
  private readonly pendingOrders: LivePendingOrder[] = hydrateActivePendingOrders()
  private readonly skipped = new Map<string, { ticker: string; reason: string; updatedAt: string; signalId?: string; side?: QuantSignal['side'] }>()
  private readonly submittedOrders: LiveOrderResult[] = aSharePersistence.readLatest('submitted_orders', MAX_ITEMS)

  addSignal(signal: QuantSignal) {
    this.signals.unshift(signal)
    this.signals.splice(MAX_ITEMS)
    aSharePersistence.appendSignal(signal)
  }

  createPendingOrder(signal: QuantSignal, decision: LlmTradingDecision, options: {
    decisionMode: LivePendingOrder['decisionMode']
    candidateId?: string
    portfolioDecisionId?: string
    portfolioRank?: number
    portfolioDecisionReason?: string
    riskWarnings?: string[]
  }): LivePendingOrder {
    const now = new Date().toISOString()
    const order: LivePendingOrder = {
      id: `ashare-pending-${signal.ticker}-${Date.now()}`,
      status: 'PENDING_CONFIRMATION',
      createdAt: now,
      updatedAt: now,
      intent: {
        ticker: signal.ticker,
        side: decision.action as Exclude<QuantSignal['side'], 'HOLD'>,
        quantity: Math.max(1, decision.orderQuantity),
        orderType: 'MARKETABLE_LIMIT',
        orderSession: 'RTH',
        limitPrice: decision.limitPrice,
        strategy: STRATEGY,
        signalId: signal.id,
        reason: decision.reason,
        sizingReason: typeof decision.finalAgentDecision?.sizingReason === 'string'
          ? decision.finalAgentDecision.sizingReason
          : 'A 股独立 LLM 决策生成；后端已按交易单位、资金/持仓和 A 股硬风控校验，真实提交前仍需人工确认。',
        estimatedNotional: `CNY ${(Math.max(1, decision.orderQuantity) * decision.limitPrice).toFixed(2)}`,
        feeContext: estimatedFeeContext(),
      },
      signal,
      llmDecision: decision,
      riskWarnings: options.riskWarnings ?? ['A 股第一版只多头；禁止 SELL_SHORT；只允许 RTH。'],
      decisionMode: options.decisionMode,
      candidateId: options.candidateId,
      portfolioDecisionId: options.portfolioDecisionId,
      portfolioRank: options.portfolioRank,
      portfolioDecisionReason: options.portfolioDecisionReason,
    }
    this.pendingOrders.unshift(order)
    this.pendingOrders.splice(MAX_ITEMS)
    aSharePersistence.appendPendingOrder(order)
    return order
  }

  recordSkipped(ticker: string, reason: string, metadata: { signalId?: string; side?: QuantSignal['side'] } = {}) {
    const skipped = { ticker: ticker.toUpperCase(), reason, updatedAt: new Date().toISOString(), ...metadata }
    this.skipped.set(skipped.ticker, skipped)
    aSharePersistence.appendSkipped(skipped)
  }

  rejectPendingOrder(id: string): LivePendingOrder | undefined {
    const order = this.findPendingOrder(id)
    if (!order || order.status !== 'PENDING_CONFIRMATION') return undefined
    const next = { ...order, status: 'REJECTED_BY_USER' as const, updatedAt: new Date().toISOString() }
    replacePending(this.pendingOrders, order.id, next, false)
    aSharePersistence.appendPendingOrder(next)
    aSharePersistence.appendRejectedOrder(next)
    return next
  }

  async confirmPendingOrder(id: string, input: { confirmedBy?: LiveOrderConfirmation['confirmedBy']; confirmationId?: string; accountId?: string } = {}): Promise<{ ok: boolean; order?: LivePendingOrder; result?: LiveOrderResult; error?: string; blockedByGate: boolean }> {
    const order = this.findPendingOrder(id)
    if (!order || order.status !== 'PENDING_CONFIRMATION') {
      return { ok: false, order, error: '未找到可确认的 A 股待确认订单。', blockedByGate: false }
    }

    const account = await loadLiveAccountDashboard(input.accountId)
    if (!account.ok || account.selectedAccountId === 'unavailable') {
      return { ok: false, order, error: account.warnings[0] ?? '真实账户不可用，无法提交 A 股订单。', blockedByGate: false }
    }

    const risk = validateAshareDecision(order.intent.side as 'BUY' | 'SELL_TO_CLOSE' | 'SELL_SHORT', order.intent.orderSession ?? 'RTH', {
      ticker: order.intent.ticker,
      orderQuantity: order.intent.quantity,
      limitPrice: order.intent.limitPrice,
      positions: account.positions,
      accountSummary: account.summary,
    })
    if (!risk.ok) {
      const rejected = {
        ...order,
        status: 'SUBMIT_FAILED' as const,
        updatedAt: new Date().toISOString(),
        riskWarnings: [risk.blockedReason ?? 'A 股确认前硬风控拦截。', ...order.riskWarnings],
      }
      replacePending(this.pendingOrders, order.id, rejected, false)
      aSharePersistence.appendPendingOrder(rejected)
      return { ok: false, order: rejected, error: risk.blockedReason, blockedByGate: false }
    }

    if (process.env.LIVE_TRADING_ENABLED !== 'true' || process.env.FUTU_LIVE_TRD_ENV !== 'REAL') {
      return {
        ok: false,
        order,
        error: '实盘提交门禁未开启：需要 LIVE_TRADING_ENABLED=true 且 FUTU_LIVE_TRD_ENV=REAL。',
        blockedByGate: true,
      }
    }

    const confirmedAt = new Date().toISOString()
    const confirmation: LiveOrderConfirmation = {
      confirmedAt,
      confirmationId: input.confirmationId || `ASHARE-CONF-${Date.now()}`,
      confirmedBy: input.confirmedBy ?? 'user',
    }
    const submitting = { ...order, status: 'CONFIRMED_SUBMITTING' as const, updatedAt: confirmedAt, confirmation }
    replacePending(this.pendingOrders, order.id, submitting, true)
    aSharePersistence.appendPendingOrder(submitting)
    aSharePersistence.appendConfirmation(confirmation)
    const result = await submitLiveOrder(account.selectedAccountId, order.id, confirmation.confirmationId, order.intent)
    const submitted = { ...submitting, status: result.ok ? ('SUBMITTED' as const) : ('SUBMIT_FAILED' as const), updatedAt: result.submittedAt, submittedOrder: result }
    replacePending(this.pendingOrders, order.id, submitted, false)
    this.submittedOrders.unshift(result)
    this.submittedOrders.splice(MAX_ITEMS)
    aSharePersistence.appendPendingOrder(submitted)
    aSharePersistence.appendSubmittedOrder(result)
    return { ok: result.ok, order: submitted, result, error: result.error, blockedByGate: false }
  }

  latestSignals(): QuantSignal[] {
    return [...this.signals]
  }

  activePendingOrders(): LivePendingOrder[] {
    return [...this.pendingOrders]
  }

  findPendingOrder(id: string): LivePendingOrder | undefined {
    return this.pendingOrders.find((order) => order.id === id)
  }

  skippedTickers() {
    return [...this.skipped.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}

export const aShareOrderQueueService = new AShareOrderQueueService()

function estimatedFeeContext(): LiveOrderFeeContext {
  return {
    source: 'estimated_pre_trade',
    currency: 'CNY',
    feeAmount: null,
    feeDetails: [],
    estimatedAmount: null,
    warning: 'A 股费用估算未接入，真实提交前需由确认弹窗复核。',
  }
}

function replacePending(orders: LivePendingOrder[], id: string, next: LivePendingOrder, keepActive: boolean) {
  const index = orders.findIndex((order) => order.id === id)
  if (keepActive) {
    if (index >= 0) orders[index] = next
    else orders.unshift(next)
    return
  }
  if (index >= 0) orders.splice(index, 1)
}

function hydrateActivePendingOrders(): LivePendingOrder[] {
  const pending = aSharePersistence.paginatePendingOrders(1, MAX_ITEMS, 'PENDING_CONFIRMATION', 'ALL', 'ALL').items
  const submitting = aSharePersistence.paginatePendingOrders(1, MAX_ITEMS, 'CONFIRMED_SUBMITTING', 'ALL', 'ALL').items
  return [...pending, ...submitting]
    .sort((left, right) => orderTime(right) - orderTime(left))
    .slice(0, MAX_ITEMS)
}

function orderTime(order: LivePendingOrder): number {
  return Date.parse(order.updatedAt || order.createdAt) || 0
}
