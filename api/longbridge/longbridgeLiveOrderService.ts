import type { LiveOrderResult, LivePendingOrder } from '../../shared/types.js'
import { parseJsonOutput, runLongbridgeCli } from './longbridgeCli.js'
import { normalizeLongbridgeSymbol } from './longbridgeMarketDataService.js'

type SubmitInput = {
  pendingOrderId: string
  confirmationId: string
  intent: LivePendingOrder['intent']
}

export async function submitLongbridgeLiveOrder(input: SubmitInput): Promise<LiveOrderResult> {
  if (process.env.LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true') {
    return blockedLongbridgeOrder(input, 'LONGBRIDGE_LIVE_TRADING_ENABLED=true 时才允许提交长桥真实订单。')
  }

  const command = buildLongbridgeLiveOrderCommand(input)
  const result = await runLongbridgeCli(command, { timeoutMs: 30_000 })
  const payload = parseJsonOutput<unknown>(result)
  if (!result.ok) {
    return blockedLongbridgeOrder(input, `Longbridge order CLI failed: ${result.stderr || result.error || 'unknown error'}`, payload)
  }
  const record = firstRecord(payload)
  const orderId = stringValue(record, ['order_id', 'orderId', 'id']) ?? stringValue(firstRecord(record.data), ['order_id', 'orderId', 'id']) ?? 'unavailable'
  return {
    ok: orderId !== 'unavailable',
    orderId,
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
    rawResponse: payload,
    error: orderId === 'unavailable' ? 'Longbridge order response missing order id.' : undefined,
  }
}

export function buildLongbridgeLiveOrderCommand(input: SubmitInput): string[] {
  const intent = input.intent
  const verb = intent.side === 'BUY' ? 'buy' : 'sell'
  const command = ['order', verb, normalizeLongbridgeSymbol(intent.ticker), String(intent.quantity)]
  const orderType = longbridgeOrderType(intent.orderType)
  command.push('--order-type', orderType)
  if (orderType !== 'MO') command.push('--price', intent.limitPrice.toFixed(2))
  const outsideRth = outsideRthForSession(intent.orderSession)
  if (outsideRth) command.push('--outside-rth', outsideRth)
  command.push('--tif', 'day')
  command.push('--remark', `FinancialWorkbench Longbridge ${intent.strategy} ${intent.signalId} ${input.confirmationId}`.slice(0, 255))
  command.push('--yes', '--format', 'json')
  return command
}

function longbridgeOrderType(orderType: string) {
  if (orderType === 'MARKET') return 'MO'
  return 'LO'
}

function outsideRthForSession(orderSession?: string) {
  if (orderSession === 'ETH') return 'ANY_TIME'
  if (orderSession === 'OVERNIGHT') return 'OVERNIGHT'
  if (orderSession === 'RTH') return 'RTH_ONLY'
  return undefined
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

function records(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['data', 'items', 'orders', 'order']) {
      if (Array.isArray(record[key])) return records(record[key])
      if (record[key] && typeof record[key] === 'object') return records(record[key])
    }
    return [record]
  }
  return []
}

function firstRecord(payload: unknown): Record<string, unknown> {
  return records(payload)[0] ?? {}
}

function stringValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}
