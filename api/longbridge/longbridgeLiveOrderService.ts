import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { LiveOrderResult, LivePendingOrder } from '../../shared/types.js'
import type {
  LongbridgeBrokerOrderSideFilter,
  LongbridgeBrokerOrdersResponse,
  LongbridgeBrokerOrderStatusFilter,
  LongbridgeCombinedOrderDetailResponse,
  LongbridgeOrderDetailResponse,
} from '../../shared/longbridgeTypes.js'
import type { ManagedCancelBrokerResponse } from '../../shared/managedOrderTypes.js'
import { localizeLongbridgeOrderError } from '../../shared/orderErrorMessages.js'
import { getManagedOrder, listManagedOrderEvents } from '../cloud/state/managedOrderStore.js'
import { normalizeLongbridgeSymbol } from './longbridgeMarketDataService.js'
import { longbridgePersistence } from './longbridgePersistence.js'

const execFileAsync = promisify(execFile)
const ORDER_CHILD_PATH = resolve(
  process.cwd(),
  'api',
  'longbridge',
  'longbridgeSdkOrderChild.mjs',
)
const ORDER_DETAIL_CHILD_PATH = resolve(
  process.cwd(),
  'api',
  'longbridge',
  'longbridgeSdkOrderDetailChild.mjs',
)
const ORDERS_CHILD_PATH = resolve(
  process.cwd(),
  'api',
  'longbridge',
  'longbridgeSdkOrdersChild.mjs',
)
const ORDER_CANCEL_CHILD_PATH = resolve(
  process.cwd(),
  'api',
  'longbridge',
  'longbridgeSdkOrderCancelChild.mjs',
)

type SubmitInput = {
  pendingOrderId: string
  confirmationId: string
  intent: LivePendingOrder['intent']
}

export type LongbridgeSdkOrderPayload = {
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  orderType: 'LO' | 'MO'
  limitPrice: number
  orderSession?: string
  remark: string
}

export async function cancelLongbridgeLiveOrder(
  orderId: string,
): Promise<ManagedCancelBrokerResponse> {
  const childEnv = buildLongbridgeOrderChildEnv()
  if (!childEnv) {
    return {
      ok: false,
      accepted: false,
      platform: 'longbridge',
      orderId,
      error: '云端长桥订单代理未配置。',
    }
  }
  const encoded = Buffer.from(JSON.stringify({ orderId })).toString('base64url')
  try {
    const result = await execFileAsync(process.execPath, [ORDER_CANCEL_CHILD_PATH, encoded], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: childEnv,
    })
    return parseCancelChildResponse(result.stdout, orderId)
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const parsed = parseCancelChildResponse(failure.stdout, orderId)
    if (parsed.error !== '长桥撤单子进程未返回内容。') return parsed
    return {
      ok: false,
      accepted: false,
      platform: 'longbridge',
      orderId,
      error: failure.stderr?.trim() || failure.message || parsed.error,
    }
  }
}

export async function loadLongbridgeOrderDetail(input: {
  orderId: string
  submittedAt?: string
}): Promise<LongbridgeOrderDetailResponse> {
  const childEnv = buildLongbridgeOrderChildEnv()
  if (!childEnv) {
    return { ok: false, error: '云端长桥订单代理未配置：缺少 LONGBRIDGE_ORDER_PROXY_URL。' }
  }

  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url')
  try {
    const result = await execFileAsync(process.execPath, [ORDER_DETAIL_CHILD_PATH, encoded], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: childEnv,
    })
    return parseOrderDetailChildResponse(result.stdout)
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const response = parseOrderDetailChildResponse(failure.stdout)
    if (!response.ok && response.error !== '长桥订单详情子进程未返回内容。') return response
    return {
      ok: false,
      error: failure.stderr?.trim() || failure.message || '长桥 SDK 订单详情子进程失败。',
    }
  }
}

export async function loadLongbridgeBrokerOrders(input: {
  page?: number
  pageSize?: number
  startDate?: string
  endDate?: string
  ticker?: string
  status?: LongbridgeBrokerOrderStatusFilter
  side?: LongbridgeBrokerOrderSideFilter
}): Promise<LongbridgeBrokerOrdersResponse> {
  const page = clampInt(input.page, 1, 1_000_000, 1)
  const pageSize = clampInt(input.pageSize, 1, 100, 12)
  const childEnv = buildLongbridgeOrderChildEnv()
  if (!childEnv) return emptyBrokerOrders(page, pageSize, input, '云端长桥订单代理未配置。')
  const ticker = input.ticker?.trim().toUpperCase()

  const encoded = Buffer.from(JSON.stringify({
    ...input,
    symbol: ticker && ticker !== 'ALL' ? normalizeLongbridgeSymbol(ticker) : undefined,
    page,
    pageSize,
  })).toString('base64url')
  try {
    const result = await execFileAsync(process.execPath, [ORDERS_CHILD_PATH, encoded], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: childEnv,
    })
    return parseBrokerOrdersChildResponse(result.stdout, page, pageSize, input)
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const parsed = parseBrokerOrdersChildResponse(failure.stdout, page, pageSize, input)
    if (parsed.error !== '长桥订单清单子进程未返回内容。') return parsed
    return emptyBrokerOrders(
      page,
      pageSize,
      input,
      failure.stderr?.trim() || failure.message || parsed.error,
    )
  }
}

export async function loadLongbridgeCombinedOrderDetail(input: {
  orderId: string
  pendingOrderId?: string
  submittedAt?: string
}): Promise<LongbridgeCombinedOrderDetailResponse> {
  const systemOrder = input.pendingOrderId
    ? longbridgePersistence.findPendingOrder(input.pendingOrderId)
    : longbridgePersistence.findPendingOrderByBrokerOrderId(input.orderId)
  const brokerOrderId = systemOrder?.submittedOrder?.orderId || input.orderId
  const shouldLoadBrokerOrder = Boolean(
    brokerOrderId
    && systemOrder?.submittedOrder?.ok !== false,
  )
  const [brokerResult, managedOrder, managedEvents] = await Promise.all([
    shouldLoadBrokerOrder
      ? loadLongbridgeOrderDetail({
          orderId: brokerOrderId,
          submittedAt: systemOrder?.submittedOrder?.submittedAt ?? input.submittedAt,
        })
      : Promise.resolve<LongbridgeOrderDetailResponse>({
          ok: false,
          error: systemOrder?.submittedOrder?.error ?? '券商未生成可查询的真实订单。',
        }),
    getManagedOrder('longbridge', brokerOrderId),
    listManagedOrderEvents('longbridge', brokerOrderId || undefined, 100),
  ])
  const brokerOrder = brokerResult.ok ? brokerResult : undefined
  const ok = Boolean(systemOrder || brokerOrder || managedOrder)
  return {
    ok,
    orderId: brokerOrderId,
    systemOrder,
    brokerOrder,
    managedOrder,
    managedEvents,
    error: brokerResult.ok ? undefined : brokerResult.error,
  }
}

export async function submitLongbridgeLiveOrder(input: SubmitInput): Promise<LiveOrderResult> {
  if (process.env.LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true') {
    return blockedLongbridgeOrder(input, 'LONGBRIDGE_LIVE_TRADING_ENABLED=true 时才允许提交长桥真实订单。')
  }

  const childEnv = buildLongbridgeOrderChildEnv()
  if (!childEnv) {
    return blockedLongbridgeOrder(input, '云端长桥订单代理未配置：缺少 LONGBRIDGE_ORDER_PROXY_URL。')
  }

  const payload = buildLongbridgeSdkOrderPayload(input)
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  let childResponse: {
    ok?: boolean
    orderId?: string
    rawResponse?: unknown
    error?: string
  }
  try {
    const result = await execFileAsync(process.execPath, [ORDER_CHILD_PATH, encoded], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: childEnv,
    })
    childResponse = parseChildResponse(result.stdout)
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    childResponse = parseChildResponse(failure.stdout) ?? {
      ok: false,
      error: failure.stderr?.trim() || failure.message || '长桥 SDK 订单子进程失败。',
    }
  }
  if (!childResponse?.ok || !childResponse.orderId) {
    return blockedLongbridgeOrder(
      input,
      `长桥订单提交失败：${localizeLongbridgeOrderError(childResponse?.error || '订单响应缺少订单编号。')}`,
      childResponse?.rawResponse,
    )
  }

  return {
    ok: true,
    orderId: childResponse.orderId,
    ticker: input.intent.ticker,
    side: input.intent.side,
    quantity: String(input.intent.quantity),
    orderType: input.intent.orderType,
    orderSession: input.intent.orderSession,
    limitPrice: input.intent.orderType === 'MARKET' ? 'MARKET' : `$${input.intent.limitPrice.toFixed(2)}`,
    submittedAt: new Date().toISOString(),
    strategy: input.intent.strategy,
    signalId: input.intent.signalId,
    pendingOrderId: input.pendingOrderId,
    feeContext: input.intent.feeContext,
    rawResponse: childResponse.rawResponse,
  }
}

export function buildLongbridgeSdkOrderPayload(input: SubmitInput): LongbridgeSdkOrderPayload {
  const intent = input.intent
  return {
    symbol: normalizeLongbridgeSymbol(intent.ticker),
    side: intent.side === 'BUY' ? 'BUY' : 'SELL',
    quantity: intent.quantity,
    orderType: intent.orderType === 'MARKET' ? 'MO' : 'LO',
    limitPrice: intent.limitPrice,
    orderSession: intent.orderSession,
    remark: `FinancialWorkbench ${intent.strategy} ${intent.signalId} ${input.confirmationId}`.slice(0, 64),
  }
}

function blockedLongbridgeOrder(input: SubmitInput, error: string, rawResponse?: unknown): LiveOrderResult {
  return {
    ok: false,
    orderId: 'blocked-by-longbridge-live-gate',
    ticker: input.intent.ticker,
    side: input.intent.side,
    quantity: String(input.intent.quantity),
    orderType: input.intent.orderType,
    orderSession: input.intent.orderSession,
    limitPrice: input.intent.orderType === 'MARKET' ? 'MARKET' : `$${input.intent.limitPrice.toFixed(2)}`,
    submittedAt: new Date().toISOString(),
    strategy: input.intent.strategy,
    signalId: input.intent.signalId,
    pendingOrderId: input.pendingOrderId,
    feeContext: input.intent.feeContext,
    rawResponse,
    error,
  }
}

function parseChildResponse(stdout?: string): {
  ok?: boolean
  orderId?: string
  rawResponse?: unknown
  error?: string
} {
  if (!stdout?.trim()) return {}
  try {
    return JSON.parse(stdout.trim()) as {
      ok?: boolean
      orderId?: string
      rawResponse?: unknown
      error?: string
    }
  } catch {
    return { ok: false, error: `长桥订单子进程返回内容无法解析：${stdout.trim().slice(0, 300)}` }
  }
}

function parseOrderDetailChildResponse(stdout?: string): LongbridgeOrderDetailResponse {
  if (!stdout?.trim()) return { ok: false, error: '长桥订单详情子进程未返回内容。' }
  try {
    return JSON.parse(stdout.trim()) as LongbridgeOrderDetailResponse
  } catch {
    return {
      ok: false,
      error: `长桥订单详情子进程返回内容无法解析：${stdout.trim().slice(0, 300)}`,
    }
  }
}

function parseBrokerOrdersChildResponse(
  stdout: string | undefined,
  page: number,
  pageSize: number,
  input: { startDate?: string; endDate?: string },
): LongbridgeBrokerOrdersResponse {
  if (!stdout?.trim()) return emptyBrokerOrders(page, pageSize, input, '长桥订单清单子进程未返回内容。')
  try {
    return JSON.parse(stdout.trim()) as LongbridgeBrokerOrdersResponse
  } catch {
    return emptyBrokerOrders(page, pageSize, input, '长桥订单清单子进程返回内容无法解析。')
  }
}

function emptyBrokerOrders(
  page: number,
  pageSize: number,
  input: { startDate?: string; endDate?: string },
  error: string,
): LongbridgeBrokerOrdersResponse {
  return {
    ok: false,
    orders: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1,
    startDate: input.startDate ?? '',
    endDate: input.endDate ?? '',
    warnings: [error],
    error,
  }
}

function clampInt(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)))
}

function buildLongbridgeOrderChildEnv(): NodeJS.ProcessEnv | undefined {
  const env = { ...process.env }
  if (process.env.CLOUD_MODE === '1') {
    const proxyUrl = process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim()
    if (!proxyUrl) return undefined
    env.HTTPS_PROXY = proxyUrl
    env.HTTP_PROXY = proxyUrl
    env.NO_PROXY = ''
    return env
  }

  for (const name of [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
  ]) {
    delete env[name]
  }
  return env
}

function parseCancelChildResponse(
  stdout: string | undefined,
  orderId: string,
): ManagedCancelBrokerResponse {
  if (!stdout?.trim()) {
    return {
      ok: false,
      accepted: false,
      platform: 'longbridge',
      orderId,
      error: '长桥撤单子进程未返回内容。',
    }
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as Partial<ManagedCancelBrokerResponse>
    return {
      ok: parsed.ok === true,
      accepted: parsed.accepted === true,
      platform: 'longbridge',
      orderId: parsed.orderId || orderId,
      rawResponse: parsed.rawResponse,
      error: parsed.error,
    }
  } catch {
    return {
      ok: false,
      accepted: false,
      platform: 'longbridge',
      orderId,
      error: `长桥撤单子进程返回内容无法解析：${stdout.trim().slice(0, 300)}`,
    }
  }
}
