import type { LiveOrderFeeContext, LiveOrderFeeDetail, LiveOrderIntent } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'
import { estimateRoundTripFee } from '../simulation/feeContextService.js'

type FeeBridgeResponse = {
  ok: boolean
  fees: LiveOrderFeeContext[]
  warnings: string[]
}

const CACHE_TTL_MS = 10_000
const cache = new Map<string, { expiresAt: number; fee: LiveOrderFeeContext }>()

export function estimatePreTradeFee(quantity: number, price: number, currency = 'USD'): LiveOrderFeeContext {
  const feeAmount = estimateRoundTripFee(quantity, price)
  return {
    source: 'estimated_pre_trade',
    currency,
    feeAmount,
    feeDetails: [{ item: 'estimated_round_trip', amount: feeAmount }],
    estimatedAmount: feeAmount,
    queriedAt: new Date().toISOString(),
  }
}

export async function loadActualOrderFees(orderIds: string[], accountId: string): Promise<Map<string, LiveOrderFeeContext>> {
  const result = new Map<string, LiveOrderFeeContext>()
  const missing: string[] = []
  for (const orderId of orderIds.filter(Boolean)) {
    const cached = cache.get(orderId)
    if (cached && cached.expiresAt > Date.now()) {
      result.set(orderId, cached.fee)
    } else {
      missing.push(orderId)
    }
  }
  for (const batch of chunk(missing, 400)) {
    if (!batch.length) continue
    const bridge = await runPythonBridge<FeeBridgeResponse>('futu_live_fee.py', {
      host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
      port: Number(process.env.FUTU_OPEND_PORT || 11111),
      accountId,
      orderIds: batch,
    })
    if (!bridge.ok || !bridge.data?.ok) {
      const warning = bridge.data?.warnings?.[0] ?? bridge.error ?? 'Futu REAL fee query failed.'
      for (const orderId of batch) {
        result.set(orderId, unavailableFee(orderId, warning))
      }
      continue
    }
    for (const fee of bridge.data.fees) {
      if (!fee.orderId) continue
      const normalized = normalizeFee(fee)
      cache.set(fee.orderId, { expiresAt: Date.now() + CACHE_TTL_MS, fee: normalized })
      result.set(fee.orderId, normalized)
    }
    for (const orderId of batch) {
      if (!result.has(orderId)) result.set(orderId, unavailableFee(orderId, bridge.data.warnings?.[0] ?? 'Futu REAL fee is not available yet.'))
    }
  }
  return result
}

export function mergeFeeContext(order: { orderId?: string; feeContext?: LiveOrderFeeContext }, estimatedFee?: LiveOrderFeeContext, actualFee?: LiveOrderFeeContext): LiveOrderFeeContext {
  if (actualFee && actualFee.source === 'actual_post_trade' && actualFee.feeAmount !== null) return actualFee
  if (estimatedFee) {
    return {
      ...estimatedFee,
      warning: actualFee?.warning ?? estimatedFee.warning,
    }
  }
  return unavailableFee(order.orderId ?? 'unavailable', actualFee?.warning ?? 'Fee context unavailable.')
}

export function feeContextForIntent(intent: Pick<LiveOrderIntent, 'quantity' | 'limitPrice'>): LiveOrderFeeContext {
  return estimatePreTradeFee(intent.quantity, intent.limitPrice)
}

function unavailableFee(orderId: string, warning: string): LiveOrderFeeContext {
  return {
    source: 'unavailable',
    orderId,
    currency: 'USD',
    feeAmount: null,
    feeDetails: [],
    queriedAt: new Date().toISOString(),
    warning,
  }
}

function normalizeFee(fee: LiveOrderFeeContext): LiveOrderFeeContext {
  return {
    source: 'actual_post_trade',
    orderId: fee.orderId,
    currency: fee.currency || 'USD',
    feeAmount: typeof fee.feeAmount === 'number' ? fee.feeAmount : null,
    feeDetails: normalizeDetails(fee.feeDetails),
    estimatedAmount: fee.estimatedAmount,
    queriedAt: fee.queriedAt ?? new Date().toISOString(),
    warning: fee.warning,
  }
}

function normalizeDetails(details: LiveOrderFeeDetail[] | undefined): LiveOrderFeeDetail[] {
  if (!Array.isArray(details)) return []
  return details.map((detail) => ({
    item: String(detail.item),
    amount: Number.isFinite(Number(detail.amount)) ? Number(detail.amount) : 0,
  }))
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}
