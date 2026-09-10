import { Config, TradeContext } from 'longbridge'
import { writeChildResult } from './longbridgeChildProcess.mjs'

const ORDER_STATUS_LABELS = {
  0: '未知',
  1: '未报',
  2: '改单未报',
  3: '保护单未报',
  4: '条件单未报',
  5: '已成交',
  6: '待报',
  7: '已委托',
  8: '待改单',
  9: '改单处理中',
  10: '已改单',
  11: '部分成交',
  12: '待撤单',
  13: '撤单处理中',
  14: '已拒绝',
  15: '已撤单',
  16: '已过期',
  17: '部分撤单',
}

const ORDER_SIDE_LABELS = {
  0: '未知',
  1: '买入',
  2: '卖出',
}

const ORDER_TYPE_LABELS = {
  0: '未知',
  1: '限价单',
  2: '增强限价单',
  3: '市价单',
  4: '竞价单',
  5: '竞价限价单',
  6: '碎股单',
  7: '触价限价单',
  8: '触价市价单',
  9: '跟踪限价单（金额）',
  10: '跟踪限价单（比例）',
  11: '跟踪市价单（金额）',
  12: '跟踪市价单（比例）',
  13: '特别限价单',
}

function fail(message) {
  writeChildResult({ ok: false, error: message }, 1)
}

function decimal(value) {
  return value === null || value === undefined ? null : value.toString()
}

function iso(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function timeInForceLabel(value) {
  if (value === 1) return '当日有效'
  if (value === 2) return '撤销前有效'
  if (value === 3) return '指定日期前有效'
  return '未知'
}

function outsideRthLabel(value) {
  if (value === 1) return '仅常规时段'
  if (value === 2) return '允许盘前盘后'
  if (value === 3) return '允许夜盘'
  return '未知'
}

function localizeMessage(value) {
  const message = String(value ?? '').trim()
  if (!message) return ''
  if (message.includes('602035') || /wrong bid size/i.test(message)) {
    return '委托价格不符合该证券的最小报价单位，请调整价格（长桥错误码 602035）。'
  }
  if (message.includes('602065') || /has not confirmed the risk disclaimer of US short-sell/i.test(message)) {
    return '账户尚未确认美股卖空风险声明，请先在长桥应用中完成确认（长桥错误码 602065）。'
  }
  if (/order amount exceeds the maximum buying power/i.test(message)) {
    return '订单金额超过账户最大购买力。'
  }
  return message
}

function flattenCharges(detail) {
  if (!detail?.items) return []
  return detail.items.flatMap((item) => item.fees.map((fee) => ({
    category: item.name || String(item.code),
    name: fee.name || fee.code,
    amount: decimal(fee.amount) ?? '0',
    currency: fee.currency,
  })))
}

async function main() {
  const encoded = process.argv[2]
  if (!encoded) {
    fail('长桥订单详情子进程缺少请求参数。')
    return
  }

  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (!input.orderId) {
    fail('缺少长桥订单号。')
    return
  }

  const config = Config.fromApikey(
    process.env.LONGBRIDGE_APP_KEY ?? '',
    process.env.LONGBRIDGE_APP_SECRET ?? '',
    process.env.LONGBRIDGE_ACCESS_TOKEN ?? '',
    { enablePrintQuotePackages: false },
  )
  const trade = TradeContext.new(config)
  const detail = await trade.orderDetail(String(input.orderId))

  let executions = await trade.todayExecutions({ orderId: String(input.orderId) })
  if (!executions.length && input.submittedAt) {
    const submittedAt = new Date(input.submittedAt)
    const startAt = new Date(submittedAt.getTime() - 24 * 60 * 60 * 1000)
    const endAt = new Date()
    const historyExecutions = await trade.historyExecutions({
      symbol: detail.symbol,
      startAt,
      endAt,
    })
    executions = historyExecutions.filter((item) => item.orderId === String(input.orderId))
  }

  const chargeDetail = detail.chargeDetail
  writeChildResult({
    ok: true,
    orderId: detail.orderId,
    symbol: detail.symbol,
    stockName: detail.stockName,
    status: detail.status,
    statusLabel: ORDER_STATUS_LABELS[detail.status] ?? '未知',
    side: detail.side,
    sideLabel: ORDER_SIDE_LABELS[detail.side] ?? '未知',
    orderType: detail.orderType,
    orderTypeLabel: ORDER_TYPE_LABELS[detail.orderType] ?? '未知',
    quantity: decimal(detail.quantity) ?? '0',
    executedQuantity: decimal(detail.executedQuantity) ?? '0',
    price: decimal(detail.price),
    executedPrice: decimal(detail.executedPrice),
    currency: detail.currency,
    submittedAt: iso(detail.submittedAt),
    updatedAt: iso(detail.updatedAt),
    message: localizeMessage(detail.msg),
    remark: detail.remark,
    timeInForceLabel: timeInForceLabel(detail.timeInForce),
    outsideRthLabel: outsideRthLabel(detail.outsideRth),
    totalCharge: decimal(chargeDetail?.totalAmount) ?? '0',
    chargeCurrency: chargeDetail?.currency ?? detail.currency,
    charges: flattenCharges(chargeDetail),
    executions: executions.map((item) => ({
      tradeId: item.tradeId,
      orderId: item.orderId,
      symbol: item.symbol,
      quantity: decimal(item.quantity) ?? '0',
      price: decimal(item.price) ?? '0',
      tradeDoneAt: iso(item.tradeDoneAt),
    })),
    history: detail.history.map((item) => ({
      status: item.status,
      statusLabel: ORDER_STATUS_LABELS[item.status] ?? '未知',
      quantity: decimal(item.quantity) ?? '0',
      price: decimal(item.price) ?? '0',
      message: localizeMessage(item.msg),
      time: iso(item.time),
    })),
    checkedAt: new Date().toISOString(),
  })
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
