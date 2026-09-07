import { Config, TradeContext } from 'longbridge'

const ORDER_STATUS_LABELS = {
  0: '未知',
  1: '未报',
  2: '改单未报',
  3: '保护单未报',
  4: '条件单未报',
  5: '全部成交',
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
  17: '部分成交后撤单',
}

const ORDER_SIDE_LABELS = { 0: '未知', 1: '买入', 2: '卖出' }
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
const ORDER_STATUS_FILTERS = {
  PENDING: new Set([1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 13]),
  FILLED: new Set([5]),
  PARTIALLY_FILLED: new Set([11]),
  CANCELED: new Set([15, 17]),
  REJECTED: new Set([14]),
  EXPIRED: new Set([16]),
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }))
  process.exitCode = 1
}

function decimal(value) {
  return value === null || value === undefined ? null : value.toString()
}

function iso(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function outsideRthLabel(value) {
  if (value === 1) return '仅盘中'
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

async function withRetry(operation) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

function normalizeOrder(order) {
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status] ?? '未知',
    side: order.side,
    sideLabel: ORDER_SIDE_LABELS[order.side] ?? '未知',
    orderType: order.orderType,
    orderTypeLabel: ORDER_TYPE_LABELS[order.orderType] ?? '未知',
    quantity: decimal(order.quantity) ?? '0',
    executedQuantity: decimal(order.executedQuantity) ?? '0',
    price: decimal(order.price),
    executedPrice: decimal(order.executedPrice),
    currency: order.currency,
    submittedAt: iso(order.submittedAt),
    updatedAt: iso(order.updatedAt),
    outsideRthLabel: outsideRthLabel(order.outsideRth),
    message: localizeMessage(order.msg),
    remark: order.remark,
  }
}

async function main() {
  const encoded = process.argv[2]
  const input = encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : {}
  const page = Math.max(1, Number(input.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 12))
  const symbol = String(input.symbol ?? '').trim().toUpperCase()
  const requestedStatus = String(input.status ?? 'ALL').trim().toUpperCase()
  const status = requestedStatus === 'ALL' || ORDER_STATUS_FILTERS[requestedStatus]
    ? requestedStatus
    : 'ALL'
  const requestedSide = String(input.side ?? 'ALL').trim().toUpperCase()
  const side = requestedSide === 'BUY' || requestedSide === 'SELL' ? requestedSide : 'ALL'
  const startAt = input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : new Date(Date.now() - 7 * 86400000)
  const endAt = input.endDate ? new Date(`${input.endDate}T23:59:59.999Z`) : new Date()

  const config = Config.fromApikey(
    process.env.LONGBRIDGE_APP_KEY ?? '',
    process.env.LONGBRIDGE_APP_SECRET ?? '',
    process.env.LONGBRIDGE_ACCESS_TOKEN ?? '',
    { enablePrintQuotePackages: false },
  )
  const trade = TradeContext.new(config)
  const today = await withRetry(() => trade.todayOrders(symbol ? { symbol } : undefined))
  const history = await withRetry(() => trade.historyOrders({
    ...(symbol ? { symbol } : {}),
    startAt,
    endAt,
  }))
  const byId = new Map([...history, ...today].map((order) => [order.orderId, normalizeOrder(order)]))
  const orders = [...byId.values()]
    .filter((order) => {
      if (status !== 'ALL' && !ORDER_STATUS_FILTERS[status]?.has(order.status)) return false
      if (side === 'BUY' && order.side !== 1) return false
      if (side === 'SELL' && order.side !== 2) return false
      return true
    })
    .sort((left, right) =>
      String(right.updatedAt ?? right.submittedAt).localeCompare(String(left.updatedAt ?? left.submittedAt)),
    )
  const total = orders.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  process.stdout.write(JSON.stringify({
    ok: true,
    orders: orders.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    total,
    totalPages,
    startDate: startAt.toISOString().slice(0, 10),
    endDate: endAt.toISOString().slice(0, 10),
    warnings: [],
  }))
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
