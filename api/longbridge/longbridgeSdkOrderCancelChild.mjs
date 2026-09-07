import { Config, TradeContext } from 'longbridge'

const CANCELLABLE_STATUSES = new Set([1, 6, 7, 11])

function fail(orderId, message) {
  process.stdout.write(JSON.stringify({
    ok: false,
    accepted: false,
    orderId,
    error: message,
  }))
  process.exitCode = 1
}

async function main() {
  if (process.env.LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true') {
    fail('', '长桥真实交易门禁关闭。')
    return
  }
  const encoded = process.argv[2]
  if (!encoded) {
    fail('', '长桥撤单子进程缺少请求参数。')
    return
  }
  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  const orderId = String(input.orderId ?? '')
  if (!orderId) {
    fail(orderId, '缺少长桥订单号。')
    return
  }
  const config = Config.fromApikey(
    process.env.LONGBRIDGE_APP_KEY ?? '',
    process.env.LONGBRIDGE_APP_SECRET ?? '',
    process.env.LONGBRIDGE_ACCESS_TOKEN ?? '',
    { enablePrintQuotePackages: false },
  )
  const trade = TradeContext.new(config)
  const detail = await trade.orderDetail(orderId)
  if (!CANCELLABLE_STATUSES.has(detail.status)) {
    process.stdout.write(JSON.stringify({
      ok: true,
      accepted: false,
      orderId,
      brokerStatus: detail.status,
      reason: 'Order is not cancellable in its current broker status.',
      rawResponse: detail.toJSON(),
    }))
    return
  }
  await trade.cancelOrder(orderId)
  process.stdout.write(JSON.stringify({
    ok: true,
    accepted: true,
    orderId,
    brokerStatus: detail.status,
    rawResponse: detail.toJSON(),
  }))
}

main().catch((error) => {
  fail('', error instanceof Error ? error.message : String(error))
})
