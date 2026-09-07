import type {
  ManagedBroker,
  ManagedBrokerOrderSnapshot,
  ManagedCancelBrokerResponse,
  ManagedOrder,
  ManagedOrderStatus,
} from '../../shared/managedOrderTypes.js'
import { cancelLongbridgeLiveOrder, loadLongbridgeOrderDetail } from '../longbridge/longbridgeLiveOrderService.js'
import { cancelFutuLiveOrder, loadFutuLiveOrderDetail } from './futuLiveOrderService.js'

export interface ManagedOrderBrokerAdapter {
  getOrderSnapshot(input: {
    order: ManagedOrder
    accountId?: string
  }): Promise<ManagedBrokerOrderSnapshot>
  cancelOrder(input: {
    order: ManagedOrder
    accountId?: string
  }): Promise<ManagedCancelBrokerResponse>
}

export function managedOrderBrokerAdapter(
  platform: ManagedBroker,
): ManagedOrderBrokerAdapter {
  return platform === 'futu' ? futuAdapter : longbridgeAdapter
}

const futuAdapter: ManagedOrderBrokerAdapter = {
  async getOrderSnapshot({ order, accountId }) {
    if (!accountId) return snapshotError(order, 'Futu REAL accountId is unavailable.')
    const detail = await loadFutuLiveOrderDetail({
      accountId,
      orderId: order.orderId,
      ticker: order.ticker,
      submittedAt: order.submittedAt,
    })
    if (!detail.ok) return snapshotError(order, detail.error)
    const brokerStatus = detail.order.orderStatus.toUpperCase()
    const submittedQuantity = numeric(detail.order.quantity)
    const executedQuantity = numeric(detail.order.filledQuantity)
    return {
      ok: true,
      platform: 'futu',
      orderId: order.orderId,
      brokerStatus,
      status: futuManagedStatus(brokerStatus),
      canCancel: ['SUBMITTED', 'WAITING_SUBMIT', 'FILLED_PART'].includes(brokerStatus),
      submittedQuantity,
      executedQuantity,
      remainingQuantity: Math.max(0, submittedQuantity - executedQuantity),
      submittedPrice: numericOrNull(detail.order.price),
      executedPrice: numericOrNull(detail.order.filledAveragePrice),
      brokerUpdatedAt: detail.order.updatedTime,
      rawResponse: detail,
    }
  },
  async cancelOrder({ order, accountId }) {
    if (!accountId) {
      return {
        ok: false,
        accepted: false,
        platform: 'futu',
        orderId: order.orderId,
        error: 'Futu REAL accountId is unavailable.',
      }
    }
    return cancelFutuLiveOrder({
      accountId,
      orderId: order.orderId,
      ticker: order.ticker,
      submittedAt: order.submittedAt,
    })
  },
}

const longbridgeAdapter: ManagedOrderBrokerAdapter = {
  async getOrderSnapshot({ order }) {
    const detail = await loadLongbridgeOrderDetail({
      orderId: order.orderId,
      submittedAt: order.submittedAt,
    })
    if (!detail.ok) return snapshotError(order, detail.error)
    const submittedQuantity = numeric(detail.quantity)
    const executedQuantity = numeric(detail.executedQuantity)
    return {
      ok: true,
      platform: 'longbridge',
      orderId: order.orderId,
      brokerStatus: String(detail.status),
      status: longbridgeManagedStatus(detail.status),
      canCancel: [1, 6, 7, 11].includes(detail.status),
      submittedQuantity,
      executedQuantity,
      remainingQuantity: Math.max(0, submittedQuantity - executedQuantity),
      submittedPrice: numericOrNull(detail.price),
      executedPrice: numericOrNull(detail.executedPrice),
      brokerUpdatedAt: detail.updatedAt ?? undefined,
      rawResponse: detail,
    }
  },
  async cancelOrder({ order }) {
    return cancelLongbridgeLiveOrder(order.orderId)
  },
}

export function futuManagedStatus(status: string): ManagedOrderStatus {
  const normalized = status.toUpperCase()
  if (normalized === 'FILLED_ALL') return 'FILLED'
  if (normalized === 'FILLED_PART') return 'PARTIALLY_FILLED'
  if (normalized === 'CANCELLED_ALL') return 'CANCELED'
  if (normalized === 'CANCELLED_PART') return 'PARTIALLY_CANCELED'
  if (['FAILED', 'SUBMIT_FAILED'].includes(normalized)) return 'REJECTED'
  if (normalized === 'EXPIRED') return 'EXPIRED'
  if (['SUBMITTED', 'WAITING_SUBMIT', 'SUBMITTING'].includes(normalized)) return 'TRACKING'
  return 'UNKNOWN'
}

export function longbridgeManagedStatus(status: number): ManagedOrderStatus {
  if (status === 5) return 'FILLED'
  if (status === 11) return 'PARTIALLY_FILLED'
  if (status === 15) return 'CANCELED'
  if (status === 17) return 'PARTIALLY_CANCELED'
  if (status === 14) return 'REJECTED'
  if (status === 16) return 'EXPIRED'
  if ([1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 13].includes(status)) return 'TRACKING'
  return 'UNKNOWN'
}

function snapshotError(
  order: ManagedOrder,
  error: string,
): ManagedBrokerOrderSnapshot {
  return {
    ok: false,
    platform: order.platform,
    orderId: order.orderId,
    brokerStatus: order.brokerStatus,
    status: 'UNKNOWN',
    canCancel: false,
    submittedQuantity: order.submittedQuantity,
    executedQuantity: order.executedQuantity,
    remainingQuantity: order.remainingQuantity,
    submittedPrice: order.submittedPrice,
    executedPrice: order.executedPrice,
    error,
  }
}

function numeric(value: string | number | null | undefined): number {
  return numericOrNull(value) ?? 0
}

function numericOrNull(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(String(value).replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}
