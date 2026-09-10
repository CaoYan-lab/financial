import {
  Config,
  Decimal,
  OrderSide,
  OrderType,
  OutsideRTH,
  TimeInForceType,
  TradeContext,
} from 'longbridge'
import { writeChildResult } from './longbridgeChildProcess.mjs'

function fail(message) {
  writeChildResult({ ok: false, error: message }, 1)
}

async function main() {
  if (process.env.LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true') {
    fail('长桥真实提交门禁关闭。')
    return
  }

  const encoded = process.argv[2]
  if (!encoded) {
    fail('长桥订单子进程缺少请求参数。')
    return
  }

  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  const config = Config.fromApikey(
    process.env.LONGBRIDGE_APP_KEY ?? '',
    process.env.LONGBRIDGE_APP_SECRET ?? '',
    process.env.LONGBRIDGE_ACCESS_TOKEN ?? '',
    { enablePrintQuotePackages: false },
  )
  const trade = TradeContext.new(config)
  const response = await trade.submitOrder({
    symbol: input.symbol,
    orderType: input.orderType === 'MO' ? OrderType.MO : OrderType.LO,
    side: input.side === 'BUY' ? OrderSide.Buy : OrderSide.Sell,
    timeInForce: TimeInForceType.Day,
    submittedQuantity: new Decimal(String(input.quantity)),
    ...(input.orderType === 'MO'
      ? {}
      : { submittedPrice: new Decimal(String(input.limitPrice)) }),
    outsideRth: outsideRth(input.orderSession),
    remark: String(input.remark ?? '').slice(0, 64),
  })

  writeChildResult({
    ok: true,
    orderId: response.orderId,
    rawResponse: response.toJSON(),
  })
}

function outsideRth(orderSession) {
  if (orderSession === 'ETH') return OutsideRTH.AnyTime
  if (orderSession === 'OVERNIGHT') return OutsideRTH.Overnight
  return OutsideRTH.RTHOnly
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
