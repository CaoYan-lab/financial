import type {
  BrokerExecutionSettings,
  ManagedOrder,
  ManagedOrderDecision,
} from '../../shared/managedOrderTypes.js'
import { isManagedOrderTerminal } from '../cloud/state/managedOrderStore.js'

export function hardRuleCancelDecision(
  order: ManagedOrder,
  settings: BrokerExecutionSettings,
  now = Date.now(),
): ManagedOrderDecision | undefined {
  if (isManagedOrderTerminal(order.status) || !order.canCancel) return undefined
  if (order.status === 'CANCEL_REQUESTED' || order.status === 'CANCEL_PENDING') return undefined
  const ageSeconds = Math.max(0, now - Date.parse(order.submittedAt)) / 1000
  const orderType = order.orderType.toUpperCase()
  const timeoutSeconds =
    orderType === 'MARKETABLE_LIMIT'
      ? settings.marketableLimitTimeoutSeconds
      : orderType === 'LIMIT'
        ? settings.limitTimeoutSeconds
        : undefined
  if (!timeoutSeconds || ageSeconds < timeoutSeconds) return undefined
  const decidedAt = new Date(now).toISOString()
  return {
    action: 'CANCEL',
    confidence: 'high',
    source: 'hard_rule',
    reason: `${orderType === 'MARKETABLE_LIMIT' ? '可成交限价单' : '限价单'}挂单已超过 ${timeoutSeconds} 秒。`,
    riskAssessment: '委托价格可能已经失效，撤销尚未成交的剩余数量。',
    decidedAt,
  }
}

export function hasManagedOrderConflict(
  orders: ManagedOrder[],
  ticker: string,
): ManagedOrder | undefined {
  const normalized = ticker.toUpperCase()
  return orders.find(
    (order) =>
      !isManagedOrderTerminal(order.status)
      && order.remainingQuantity > 0
      && order.ticker.toUpperCase() === normalized,
  )
}
