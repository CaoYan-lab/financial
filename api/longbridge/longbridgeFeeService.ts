import type { LiveOrderFeeContext, LivePendingOrder } from '../../shared/types.js'
import { estimatePreTradeFee } from '../live/liveFeeService.js'

export function estimateLongbridgePreTradeFee(quantity: number, price: number, symbolOrTicker: string): LiveOrderFeeContext {
  return {
    ...estimatePreTradeFee(quantity, price, currencyForSymbol(symbolOrTicker)),
    warning: '长桥待确认阶段显示提交前估算费用；真实券商费用以订单成交后的长桥记录为准。',
  }
}

export function ensureLongbridgeEstimatedFee(order: LivePendingOrder): LivePendingOrder {
  const fee = order.intent.feeContext
  if (fee && fee.source !== 'unavailable' && fee.feeAmount !== null) return order
  return {
    ...order,
    intent: {
      ...order.intent,
      feeContext: estimateLongbridgePreTradeFee(order.intent.quantity, order.intent.limitPrice, order.intent.ticker),
    },
  }
}

export function ensureLongbridgeEstimatedFees(orders: LivePendingOrder[]): LivePendingOrder[] {
  return orders.map(ensureLongbridgeEstimatedFee)
}

function currencyForSymbol(symbolOrTicker: string) {
  const value = symbolOrTicker.toUpperCase()
  if (value.endsWith('.HK') || /^\d{4,5}$/.test(value)) return 'HKD'
  return 'USD'
}
