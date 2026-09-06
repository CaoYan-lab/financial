import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { LiveOrderResult, LivePendingOrder } from '../../shared/types.js'
import type { LongbridgeOrderDetailResponse } from '../../shared/longbridgeTypes.js'
import type { ManagedCancelBrokerResponse } from '../../shared/managedOrderTypes.js'
import { normalizeLongbridgeSymbol } from './longbridgeMarketDataService.js'

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
  const proxyUrl = process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim()
  if (!proxyUrl) {
    return {
      ok: false,
      accepted: false,
      platform: 'longbridge',
      orderId,
      error: '长桥订单代理未配置。',
    }
  }
  const encoded = Buffer.from(JSON.stringify({ orderId })).toString('base64url')
  try {
    const result = await execFileAsync(process.execPath, [ORDER_CANCEL_CHILD_PATH, encoded], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        NO_PROXY: '',
      },
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
  const proxyUrl = process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim()
  if (!proxyUrl) {
    return { ok: false, error: '长桥订单代理未配置：缺少 LONGBRIDGE_ORDER_PROXY_URL。' }
  }

  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url')
  try {
    const result = await execFileAsync(process.execPath, [ORDER_DETAIL_CHILD_PATH, encoded], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        NO_PROXY: '',
      },
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

export async function submitLongbridgeLiveOrder(input: SubmitInput): Promise<LiveOrderResult> {
  if (process.env.LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true') {
    return blockedLongbridgeOrder(input, 'LONGBRIDGE_LIVE_TRADING_ENABLED=true 时才允许提交长桥真实订单。')
  }

  const proxyUrl = process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim()
  if (!proxyUrl) {
    return blockedLongbridgeOrder(input, '长桥订单代理未配置：缺少 LONGBRIDGE_ORDER_PROXY_URL。')
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
      env: {
        ...process.env,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        NO_PROXY: '',
      },
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
      `Longbridge SDK order failed: ${childResponse?.error || 'response missing order id'}`,
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
