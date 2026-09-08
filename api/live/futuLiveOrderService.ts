import type {
  FutuLiveOrder,
  FutuLiveOrderDetailResponse,
  FutuLiveOrdersResponse,
  LiveOrderResult,
} from '../../shared/types.js'
import type { ManagedCancelBrokerResponse } from '../../shared/managedOrderTypes.js'
import { realtimeStore } from '../realtime/realtimeStore.js'
import { llmUniverseItem } from '../simulation/simulationUniverse.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'
import { openingLotSizeFailureReason } from '../longbridge/longbridgeLotSizeService.js'
import { loadActualOrderFees, mergeFeeContext } from './liveFeeService.js'

type QueryInput = {
  accountId: string
  page?: number
  pageSize?: number
  startDate?: string
  endDate?: string
  ticker?: string
  status?: string
  side?: string
  bypassCache?: boolean
}

const CACHE_TTL_MS = 10_000
let cached: { key: string; expiresAt: number; response: FutuLiveOrdersResponse } | undefined

export async function cancelFutuLiveOrder(input: {
  accountId: string
  orderId: string
  ticker: string
  submittedAt?: string
}): Promise<ManagedCancelBrokerResponse> {
  const bridge = await runPythonBridge<{
    ok: boolean
    accepted: boolean
    orderId: string
    brokerStatus?: string
    order?: unknown
    rawResponse?: unknown
    error?: string
  }>('futu_live_cancel_order.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    ...input,
  })
  const response = bridge.data
  if (!bridge.ok || !response?.ok) {
    return {
      ok: false,
      accepted: false,
      platform: 'futu',
      orderId: input.orderId,
      error: response?.error ?? bridge.error ?? 'Futu REAL cancel bridge failed.',
    }
  }
  return {
    ok: true,
    accepted: response.accepted,
    platform: 'futu',
    orderId: input.orderId,
    rawResponse: response.rawResponse ?? response.order,
    error: response.accepted ? undefined : '订单当前状态不可撤。',
  }
}

export async function loadFutuLiveOrderDetail(input: {
  accountId: string
  orderId: string
  ticker?: string
  submittedAt?: string
}): Promise<FutuLiveOrderDetailResponse> {
  const bridge = await runPythonBridge<FutuLiveOrderDetailResponse>('futu_live_order_detail.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    accountId: input.accountId,
    orderId: input.orderId,
    ticker: input.ticker,
    submittedAt: input.submittedAt,
  })
  if (bridge.ok && bridge.data) return bridge.data
  return {
    ok: false,
    error: `Futu REAL order detail bridge failed: ${bridge.error ?? 'unknown error'}`,
    warnings: [bridge.stderr ?? ''].filter(Boolean),
  }
}

export async function loadFutuLiveOrders(input: QueryInput): Promise<FutuLiveOrdersResponse> {
  const page = clampInt(input.page, 1, 1_000_000, 1)
  const pageSize = clampInt(input.pageSize, 1, 100, 12)
  const key = JSON.stringify({ ...input, bypassCache: undefined, page, pageSize })
  if (!input.bypassCache && cached && cached.key === key && cached.expiresAt > Date.now()) return cached.response

  const bridge = await runPythonBridge<FutuLiveOrdersResponse>('futu_live_orders.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    accountId: input.accountId,
    page,
    pageSize,
    startDate: input.startDate,
    endDate: input.endDate,
    ticker: input.ticker,
    status: input.status,
    side: input.side,
  })

  const response =
    bridge.ok && bridge.data
      ? bridge.data
      : {
          ok: false,
          orders: [],
          page,
          pageSize,
          total: 0,
          totalPages: 1,
          startDate: input.startDate ?? '',
          endDate: input.endDate ?? '',
          accountId: input.accountId,
          warnings: [`Futu REAL order bridge failed: ${bridge.error ?? 'unknown error'}`],
        }

  const orderIds = response.orders.map((order) => order.orderId).filter((orderId) => orderId && orderId !== 'unavailable')
  if (orderIds.length) {
    const fees = await loadActualOrderFees(orderIds, input.accountId)
    response.orders = response.orders.map((order) => ({
      ...order,
      feeContext: mergeFeeContext(order, undefined, fees.get(order.orderId)),
    }))
  }

  cached = { key, expiresAt: Date.now() + CACHE_TTL_MS, response }
  return response
}

export async function submitLiveOrder(accountId: string, pendingOrderId: string, confirmationId: string, intent: LiveOrderResultInput): Promise<LiveOrderResult> {
  if (process.env.LIVE_TRADING_ENABLED !== 'true' || process.env.FUTU_LIVE_TRD_ENV !== 'REAL') {
    return blockedLiveOrder(pendingOrderId, intent, 'LIVE_TRADING_ENABLED=true 且 FUTU_LIVE_TRD_ENV=REAL 时才允许提交真实订单。')
  }
  const isHongKong = llmUniverseItem(intent.ticker)?.market === 'HK'
  const lotSize = realtimeStore.snapshot(intent.ticker).quote?.lotSize
  if (isHongKong && (!Number.isFinite(lotSize) || Number(lotSize) <= 0)) {
    return blockedLiveOrder(pendingOrderId, intent, 'Futu REAL order blocked: 无法确认港股每手股数。')
  }
  const lotSizeFailure = openingLotSizeFailureReason({
    symbol: intent.ticker,
    action: intent.side,
    quantity: intent.quantity,
    lotSize,
  })
  if (lotSizeFailure) {
    return blockedLiveOrder(pendingOrderId, intent, `Futu REAL order blocked: ${lotSizeFailure}`)
  }
  const submittedAt = new Date().toISOString()
  const bridge = await runPythonBridge<LiveOrderResult>('futu_live_order.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    accountId,
    pendingOrderId,
    confirmationId,
    ...intent,
  })
  const baseResult = bridge.ok && bridge.data ? bridge.data : blockedLiveOrder(pendingOrderId, intent, `Futu REAL order bridge failed: ${bridge.error ?? 'unknown error'}`)
  const enhancedResult = await enhanceWithFutuOrderStatus(baseResult, accountId, confirmationId, intent, submittedAt)
  if (enhancedResult.orderId !== 'unavailable') {
    const fees = await loadActualOrderFees([enhancedResult.orderId], accountId)
    return {
      ...enhancedResult,
      feeContext: mergeFeeContext(enhancedResult, intent.feeContext, fees.get(enhancedResult.orderId)),
    }
  }
  return {
    ...enhancedResult,
    feeContext: mergeFeeContext(enhancedResult, intent.feeContext, undefined),
  }
}

type LiveOrderResultInput = {
  ticker: string
  side: LiveOrderResult['side']
  quantity: number
  orderType: string
  orderSession?: string
  limitPrice: number
  strategy: LiveOrderResult['strategy']
  signalId: string
  feeContext?: LiveOrderResult['feeContext']
}

function blockedLiveOrder(pendingOrderId: string, intent: LiveOrderResultInput, error: string): LiveOrderResult {
  return {
    ok: false,
    orderId: 'blocked-by-live-gate',
    ticker: intent.ticker,
    side: intent.side,
    quantity: String(intent.quantity),
    orderType: intent.orderType,
    orderSession: intent.orderSession,
    limitPrice: intent.orderType === 'MARKET' ? 'MARKET' : `$${intent.limitPrice.toFixed(2)}`,
    submittedAt: new Date().toISOString(),
    strategy: intent.strategy,
    signalId: intent.signalId,
    pendingOrderId,
    feeContext: intent.feeContext,
    error,
  }
}

async function enhanceWithFutuOrderStatus(result: LiveOrderResult, accountId: string, confirmationId: string, intent: LiveOrderResultInput, submittedAt: string): Promise<LiveOrderResult> {
  await delay(750)
  const response = await loadFutuLiveOrders({
    accountId,
    page: 1,
    pageSize: 20,
    ticker: intent.ticker,
    bypassCache: true,
  })
  if (!response.ok || !response.orders.length) return result

  const matchedOrder = matchSubmittedFutuOrder(response.orders, result, confirmationId, intent, submittedAt)
  if (!matchedOrder) return result

  const rawFutuOrder = asRecord(matchedOrder.rawResponse)
  const failureMessage = typeof rawFutuOrder.last_err_msg === 'string' && rawFutuOrder.last_err_msg ? rawFutuOrder.last_err_msg : result.error
  const isFailed = ['FAILED', 'SUBMIT_FAILED'].includes(matchedOrder.orderStatus.toUpperCase())
  return {
    ...result,
    ok: isFailed ? false : result.ok,
    orderId: matchedOrder.orderId || result.orderId,
    rawResponse: {
      ...(typeof result.rawResponse === 'object' && result.rawResponse !== null ? result.rawResponse : {}),
      futuOrder: matchedOrder.rawResponse ?? matchedOrder,
      orderStatus: matchedOrder.orderStatus,
      orderStatusLabel: matchedOrder.orderStatusLabel,
    },
    error: isFailed ? failureMessage : result.error,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function matchSubmittedFutuOrder(orders: FutuLiveOrder[], result: LiveOrderResult, confirmationId: string, intent: LiveOrderResultInput, submittedAt: string): FutuLiveOrder | undefined {
  const normalizedTicker = intent.ticker.toUpperCase()
  const candidates = orders.filter((order) => order.ticker.toUpperCase() === normalizedTicker)
  if (!candidates.length) return undefined
  if (result.orderId && result.orderId !== 'unavailable') {
    const exact = candidates.find((order) => order.orderId === result.orderId)
    if (exact) return exact
  }

  const signalPrefix = intent.signalId.slice(0, 12)
  const remarkMatched = candidates.find((order) => {
    const remark = `${order.remark ?? ''} ${JSON.stringify(order.rawResponse ?? {})}`
    return remark.includes(confirmationId) || remark.includes(signalPrefix)
  })
  if (remarkMatched) return remarkMatched

  const submittedTime = Date.parse(submittedAt)
  if (!Number.isFinite(submittedTime)) return candidates[0]
  return candidates.find((order) => {
    const orderTime = parseFutuOrderTime(order.updatedTime) ?? parseFutuOrderTime(order.createTime)
    if (!orderTime) return false
    return Math.abs(orderTime - submittedTime) <= 120_000
  }) ?? candidates[0]
}

function parseFutuOrderTime(value: string): number | undefined {
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
  const normalized = value ? Date.parse(`${value.replace(' ', 'T')}Z`) : NaN
  return Number.isFinite(normalized) ? normalized : undefined
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampInt(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
}
