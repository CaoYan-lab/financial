import type { LiveOrderConfirmation, LiveOrderResult, LivePendingOrder } from '../../shared/types.js'
import { ensureLongbridgeEstimatedFee, ensureLongbridgeEstimatedFees } from './longbridgeFeeService.js'
import { submitLongbridgeLiveOrder } from './longbridgeLiveOrderService.js'
import { longbridgePersistence } from './longbridgePersistence.js'
import { registerSubmittedManagedOrder } from '../live/managedOrderSupervisor.js'
import { orderSubmissionSessionFailureReason } from '../simulation/usOvernightLlmGate.js'
import { getLongbridgeSdkContexts } from './longbridgeSdkGateway.js'
import {
  loadLongbridgeMarketStates,
  normalizeLongbridgeSymbol,
} from './longbridgeMarketSessionService.js'
import {
  loadLongbridgeLotSize,
  longbridgeOpeningLotSizeFailureReason,
} from './longbridgeLotSizeService.js'

class LongbridgeOrderQueueService {
  createPendingOrder(order: LivePendingOrder) {
    longbridgePersistence.appendPendingOrder(order)
    return order
  }

  activePendingOrders() {
    return ensureLongbridgeEstimatedFees(longbridgePersistence.activePendingOrders())
  }

  latestPendingOrders() {
    return ensureLongbridgeEstimatedFees(longbridgePersistence.latestPendingOrders())
  }

  findPendingOrder(id: string) {
    const order = longbridgePersistence.findPendingOrder(id)
    return order ? ensureLongbridgeEstimatedFee(order) : undefined
  }

  rejectPendingOrder(id: string): { ok: boolean; order?: LivePendingOrder; error?: string } {
    const order = this.findPendingOrder(id)
    if (!order || order.status !== 'PENDING_CONFIRMATION') {
      return { ok: false, order, error: '未找到可拒绝的长桥待确认订单。' }
    }
    const rejectedAt = new Date().toISOString()
    const next = {
      ...order,
      status: 'REJECTED_BY_USER' as const,
      updatedAt: rejectedAt,
      riskWarnings: [
        '该订单已由用户在确认弹窗中拒绝，不会提交长桥真实订单。',
        ...order.riskWarnings,
      ],
    }
    longbridgePersistence.replacePendingOrder(next)
    longbridgePersistence.appendRejectedOrder(next)
    return { ok: true, order: next }
  }

  expirePendingOrders(filters: { ticker?: string; side?: string; ids?: string[] } = {}): LivePendingOrder[] {
    const normalizedTicker = filters.ticker?.trim().toUpperCase()
    const normalizedSide = filters.side?.trim().toUpperCase()
    const ids = new Set((filters.ids ?? []).map((id) => id.trim()).filter(Boolean))
    const expiredAt = new Date().toISOString()
    const targets = this.activePendingOrders().filter((order) => {
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
      longbridgePersistence.replacePendingOrder(next)
      expired.push(next)
    }
    return expired
  }

  async confirmPendingOrder(id: string, input: { confirmedBy?: LiveOrderConfirmation['confirmedBy']; confirmationId?: string } = {}): Promise<{ ok: boolean; order?: LivePendingOrder; result?: LiveOrderResult; error?: string; blockedByGate: boolean }> {
    const order = this.findPendingOrder(id)
    if (process.env.LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true') {
      return {
        ok: false,
        order,
        error: '长桥真实提交门禁关闭：LONGBRIDGE_LIVE_TRADING_ENABLED 未开启。本次测试不会提交真实订单。',
        blockedByGate: true,
      }
    }
    if (!order || order.status !== 'PENDING_CONFIRMATION') {
      return {
        ok: false,
        order,
        error: '未找到可确认的长桥待确认订单。',
        blockedByGate: false,
      }
    }

    const symbol = normalizeLongbridgeSymbol(order.intent.ticker)
    const quote = getLongbridgeSdkContexts().quote
    const lotSize = await loadLongbridgeLotSize(quote, symbol)
    const lotSizeFailure = longbridgeOpeningLotSizeFailureReason({
      symbol,
      action: order.intent.side,
      quantity: order.intent.quantity,
      lotSize,
    })
    if (lotSizeFailure) {
      return {
        ok: false,
        order,
        error: `长桥真实提交已拦截：${lotSizeFailure}`,
        blockedByGate: true,
      }
    }
    const marketState = (await loadLongbridgeMarketStates(
      quote,
      [symbol],
    )).get(symbol)
    const sessionFailure = orderSubmissionSessionFailureReason({
      ticker: order.intent.ticker,
      marketState,
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

    const confirmedAt = new Date().toISOString()
    const confirmation: LiveOrderConfirmation = {
      confirmedAt,
      confirmationId: input.confirmationId || `longbridge-confirm-${Date.now()}`,
      confirmedBy: input.confirmedBy ?? 'user',
    }
    const submitting = {
      ...order,
      status: 'CONFIRMED_SUBMITTING' as const,
      updatedAt: confirmedAt,
      confirmation,
    }
    longbridgePersistence.replacePendingOrder(submitting)
    longbridgePersistence.appendConfirmation(confirmation)
    const result = await submitLongbridgeLiveOrder({
      pendingOrderId: order.id,
      confirmationId: confirmation.confirmationId,
      intent: order.intent,
    })
    const next = {
      ...submitting,
      status: result.ok ? ('SUBMITTED' as const) : ('SUBMIT_FAILED' as const),
      updatedAt: result.submittedAt,
      submittedOrder: result,
      riskWarnings: result.error ? [result.error, ...order.riskWarnings] : order.riskWarnings,
    }
    longbridgePersistence.replacePendingOrder(next)
    longbridgePersistence.appendSubmittedOrder(result)
    await registerSubmittedManagedOrder('longbridge', result, order.llmDecision)
    return {
      ok: result.ok,
      order: next,
      result,
      error: result.error,
      blockedByGate: false,
    }
  }

  resetForTests() {
    longbridgePersistence.clearForTests()
  }
}

export const longbridgeOrderQueueService = new LongbridgeOrderQueueService()
