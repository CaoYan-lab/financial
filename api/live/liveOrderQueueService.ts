import type { LiveOrderConfirmation, LiveOrderResult, LivePendingOrder, LiveSkippedTicker, QuantSignal, QuantStrategyName } from '../../shared/types.js'
import { livePersistence } from './livePersistence.js'
import { loadLiveAccountDashboard } from './liveAccountService.js'
import { submitLiveOrder } from './futuLiveOrderService.js'
import { registerSubmittedManagedOrder } from './managedOrderSupervisor.js'
import { loadMarketSessions } from '../simulation/marketSessionService.js'
import { orderSubmissionSessionFailureReason } from '../simulation/usOvernightLlmGate.js'

const MAX_ITEMS = 500
const ORDER_COOLDOWN_MS = 15 * 60 * 1000
const STRATEGY: QuantStrategyName = 'LLM_AUTONOMOUS_STOCK_TRADER'

class LiveOrderQueueService {
  private readonly signals: QuantSignal[] = livePersistence.readLatest('signals', MAX_ITEMS)
  private readonly pendingOrders: LivePendingOrder[] = livePersistence
    .readLatest('pending_orders', MAX_ITEMS)
    .filter((order) => order.status === 'PENDING_CONFIRMATION' || order.status === 'CONFIRMED_SUBMITTING')
  private readonly submittedOrders: LiveOrderResult[] = livePersistence.readLatest('submitted_orders', MAX_ITEMS)
  private readonly skipped = new Map<string, LiveSkippedTicker>()
  private readonly lastOrderAt = new Map<string, number>()

  constructor() {
    for (const skipped of livePersistence.readLatest('skipped', MAX_ITEMS)) {
      if (!this.skipped.has(skipped.ticker.toUpperCase())) this.skipped.set(skipped.ticker.toUpperCase(), skipped)
    }
    for (const order of this.submittedOrders) {
      if (order.ok) this.lastOrderAt.set(orderKey(order.ticker, order.side, order.strategy), Date.parse(order.submittedAt) || Date.now())
    }
    for (const order of this.pendingOrders) {
      this.lastOrderAt.set(orderKey(order.intent.ticker, order.intent.side, order.intent.strategy), Date.parse(order.createdAt) || Date.now())
    }
  }

  addSignal(signal: QuantSignal) {
    this.signals.unshift(signal)
    this.signals.splice(MAX_ITEMS)
    livePersistence.appendSignal(signal)
  }

  createPendingOrder(order: LivePendingOrder) {
    this.pendingOrders.unshift(order)
    this.pendingOrders.splice(MAX_ITEMS)
    this.lastOrderAt.set(orderKey(order.intent.ticker, order.intent.side, order.intent.strategy), Date.now())
    livePersistence.appendPendingOrder(order)
  }

  recordFailedPendingOrder(order: LivePendingOrder, result: LiveOrderResult): LivePendingOrder {
    const failed = {
      ...order,
      status: 'SUBMIT_FAILED' as const,
      updatedAt: result.submittedAt,
      submittedOrder: result,
      riskWarnings: [
        ...(result.error ? [result.error] : []),
        ...order.riskWarnings,
      ],
    }
    this.submittedOrders.unshift(result)
    this.submittedOrders.splice(MAX_ITEMS)
    livePersistence.appendPendingOrder(failed)
    livePersistence.appendSubmittedOrder(result)
    return failed
  }

  rejectPendingOrder(id: string): LivePendingOrder | undefined {
    const order = this.findPendingOrder(id)
    if (!order) return undefined
    const next = {
      ...order,
      status: 'REJECTED_BY_USER' as const,
      updatedAt: new Date().toISOString(),
    }
    this.replacePending(order.id, next, false)
    livePersistence.appendPendingOrder(next)
    livePersistence.appendRejectedOrder(next)
    return next
  }

  expirePendingOrders(filters: { ticker?: string; side?: string; ids?: string[] } = {}): LivePendingOrder[] {
    const normalizedTicker = filters.ticker?.trim().toUpperCase()
    const normalizedSide = filters.side?.trim().toUpperCase()
    const ids = new Set((filters.ids ?? []).map((id) => id.trim()).filter(Boolean))
    const expiredAt = new Date().toISOString()
    const targets = this.pendingOrders.filter((order) => {
      if (order.status !== 'PENDING_CONFIRMATION') return false
      if (ids.size && !ids.has(order.id)) return false
      if (normalizedTicker && normalizedTicker !== 'ALL' && order.intent.ticker.toUpperCase() !== normalizedTicker) return false
      if (normalizedSide && normalizedSide !== 'ALL' && order.intent.side !== normalizedSide) return false
      return true
    })

    const expired: LivePendingOrder[] = []
    for (const order of targets) {
      const next = {
        ...order,
        status: 'EXPIRED' as const,
        updatedAt: expiredAt,
        riskWarnings: [
          '该订单已由用户批量过期，不再展示为活跃待确认订单。',
          ...order.riskWarnings,
        ],
      }
      this.replacePending(order.id, next, false)
      livePersistence.appendPendingOrder(next)
      expired.push(next)
    }
    if (expired.length) this.rebuildOrderCooldowns()
    return expired
  }

  markSubmitting(id: string, confirmation: LiveOrderConfirmation): LivePendingOrder | undefined {
    const order = this.findPendingOrder(id)
    if (!order) return undefined
    const next = {
      ...order,
      status: 'CONFIRMED_SUBMITTING' as const,
      updatedAt: confirmation.confirmedAt,
      confirmation,
    }
    this.replacePending(order.id, next, true)
    livePersistence.appendPendingOrder(next)
    livePersistence.appendConfirmation(confirmation)
    return next
  }

  markSubmitted(id: string, result: LiveOrderResult): LivePendingOrder | undefined {
    const order = this.findPendingOrder(id)
    if (!order) return undefined
    const next = {
      ...order,
      status: result.ok ? ('SUBMITTED' as const) : ('SUBMIT_FAILED' as const),
      updatedAt: result.submittedAt,
      submittedOrder: result,
    }
    this.replacePending(order.id, next, false)
    this.submittedOrders.unshift(result)
    this.submittedOrders.splice(MAX_ITEMS)
    if (result.ok) this.lastOrderAt.set(orderKey(result.ticker, result.side, result.strategy), Date.now())
    livePersistence.appendPendingOrder(next)
    livePersistence.appendSubmittedOrder(result)
    return next
  }

  async confirmPendingOrder(id: string, input: { confirmedBy?: LiveOrderConfirmation['confirmedBy']; confirmationId?: string; accountId?: string } = {}): Promise<{ ok: boolean; order?: LivePendingOrder; result?: LiveOrderResult; error?: string; blockedByGate: boolean }> {
    const order = this.findPendingOrder(id)
    if (process.env.LIVE_TRADING_ENABLED !== 'true' || process.env.FUTU_LIVE_TRD_ENV !== 'REAL') {
      return {
        ok: false,
        order,
        error: '实盘提交门禁未开启：需要 LIVE_TRADING_ENABLED=true 且 FUTU_LIVE_TRD_ENV=REAL。',
        blockedByGate: true,
      }
    }
    if (!order || order.status !== 'PENDING_CONFIRMATION') {
      return {
        ok: false,
        order,
        error: '未找到可确认的待确认实盘订单。',
        blockedByGate: false,
      }
    }

    const marketSession = (await loadMarketSessions([order.intent.ticker]))[order.intent.ticker.toUpperCase()]
    const sessionFailure = orderSubmissionSessionFailureReason({
      ticker: order.intent.ticker,
      marketState: marketSession?.state,
      orderSession: order.intent.orderSession,
    })
    if (sessionFailure) {
      return {
        ok: false,
        order,
        error: sessionFailure,
        blockedByGate: true,
      }
    }

    const account = await loadLiveAccountDashboard(input.accountId)
    if (!account.ok || account.selectedAccountId === 'unavailable') {
      return {
        ok: false,
        order,
        error: account.warnings[0] ?? '真实账户不可用，无法提交。',
        blockedByGate: false,
      }
    }

    const confirmedAt = new Date().toISOString()
    const confirmation: LiveOrderConfirmation = {
      confirmedAt,
      confirmationId: input.confirmationId || `CONF-${Date.now()}`,
      confirmedBy: input.confirmedBy ?? 'user',
    }
    this.markSubmitting(order.id, confirmation)
    const result = await submitLiveOrder(account.selectedAccountId, order.id, confirmation.confirmationId, order.intent)
    const submitted = this.markSubmitted(order.id, result)
    await registerSubmittedManagedOrder('futu', result, order.llmDecision)
    return {
      ok: result.ok,
      order: submitted,
      result,
      error: result.error,
      blockedByGate: false,
    }
  }

  recordSkipped(ticker: string, reason: string, metadata: Pick<LiveSkippedTicker, 'signalId' | 'side'> = {}) {
    const skipped = {
      ticker: ticker.toUpperCase(),
      reason,
      updatedAt: new Date().toISOString(),
      ...metadata,
    }
    this.skipped.set(ticker.toUpperCase(), skipped)
    livePersistence.appendSkipped(skipped)
  }

  clearSkipped() {
    this.skipped.clear()
  }

  canCreatePending(ticker: string, side: string, strategy: QuantStrategyName = STRATEGY): boolean {
    const submittedAt = this.lastOrderAt.get(orderKey(ticker, side, strategy))
    return !submittedAt || Date.now() - submittedAt > ORDER_COOLDOWN_MS
  }

  findPendingOrder(id: string): LivePendingOrder | undefined {
    return this.pendingOrders.find((order) => order.id === id) ?? livePersistence.findPendingOrderById(id)
  }

  latestSignals(): QuantSignal[] {
    return [...this.signals]
  }

  activePendingOrders(): LivePendingOrder[] {
    return [...this.pendingOrders]
  }

  latestSubmittedOrders(): LiveOrderResult[] {
    return [...this.submittedOrders]
  }

  skippedTickers(): LiveSkippedTicker[] {
    return [...this.skipped.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_ITEMS)
  }

  resetForTests() {
    this.signals.splice(0)
    this.pendingOrders.splice(0)
    this.submittedOrders.splice(0)
    this.skipped.clear()
    this.lastOrderAt.clear()
    livePersistence.clearForTests()
  }

  private replacePending(id: string, next: LivePendingOrder, keepActive: boolean) {
    const index = this.pendingOrders.findIndex((order) => order.id === id)
    if (index >= 0) {
      if (keepActive) {
        this.pendingOrders[index] = next
      } else {
        this.pendingOrders.splice(index, 1)
      }
    } else if (keepActive) {
      this.pendingOrders.unshift(next)
    }
  }

  private rebuildOrderCooldowns() {
    this.lastOrderAt.clear()
    for (const order of this.submittedOrders) {
      if (order.ok) this.lastOrderAt.set(orderKey(order.ticker, order.side, order.strategy), Date.parse(order.submittedAt) || Date.now())
    }
    for (const order of this.pendingOrders) {
      this.lastOrderAt.set(orderKey(order.intent.ticker, order.intent.side, order.intent.strategy), Date.parse(order.createdAt) || Date.now())
    }
  }
}

export const liveOrderQueueService = new LiveOrderQueueService()

function orderKey(ticker: string, side: string, strategy: QuantStrategyName): string {
  return `${ticker.toUpperCase()}:${side}:${strategy}`
}
