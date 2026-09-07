export function displaySide(side: string, language: 'zh' | 'en'): string {
  if (language === 'en') return side
  const normalized = side.toUpperCase()
  if (normalized === 'BUY' || normalized === 'BUY_BACK') return normalized === 'BUY_BACK' ? '买入平仓' : '买入'
  if (normalized === 'SELL_SHORT' || normalized === 'SELL') return normalized === 'SELL_SHORT' ? '卖空' : '卖出'
  if (normalized === 'SELL_TO_CLOSE') return '平仓卖出'
  if (normalized && normalized !== 'HOLD') return side
  return '观望'
}

export function displaySignalModel(modelLabel: string | undefined, model: string | undefined, language: 'zh' | 'en'): string {
  return modelLabel || model || (language === 'zh' ? '历史未记录' : 'Not recorded')
}

export function displayOrderType(orderType: string, language: 'zh' | 'en'): string {
  const normalized = orderType.toUpperCase()
  if (normalized === 'MARKET') return language === 'zh' ? '市价单' : 'Market'
  if (normalized === 'MARKETABLE_LIMIT') return language === 'zh' ? '主动限价单' : 'Marketable Limit'
  if (normalized === 'LIMIT' || normalized === 'NORMAL') return language === 'zh' ? '限价单' : 'Limit'
  if (normalized === 'ABSOLUTE_LIMIT') return language === 'zh' ? '竞价限价单' : 'Absolute Limit'
  if (normalized === 'AUCTION') return language === 'zh' ? '竞价市价单' : 'Auction'
  if (normalized === 'AUCTION_LIMIT') return language === 'zh' ? '竞价限价单' : 'Auction Limit'
  if (normalized === 'SPECIAL_LIMIT') return language === 'zh' ? '特别限价单' : 'Special Limit'
  if (normalized === 'SPECIAL_LIMIT_ALL') return language === 'zh' ? '特别限价全成单' : 'Special Limit All'
  return orderType
}

export function displayOrderPriceWithType(price: string, orderType: string | undefined, language: 'zh' | 'en'): string {
  const normalizedType = String(orderType ?? '').toUpperCase()
  if (normalizedType === 'MARKET') return language === 'zh' ? '市价' : 'Market'

  const safePrice = price || 'unavailable'
  if (!normalizedType) return safePrice

  const typeLabel = displayOrderType(normalizedType, language)
  return language === 'zh' ? `${safePrice}（${typeLabel}）` : `${safePrice} (${typeLabel})`
}

export function displayOrderSession(orderSession: string | undefined, language: 'zh' | 'en'): string {
  if (orderSession === 'RTH') return language === 'zh' ? '盘中' : 'RTH'
  if (orderSession === 'ETH') return language === 'zh' ? '盘前/盘后' : 'ETH'
  if (orderSession === 'OVERNIGHT') return language === 'zh' ? '夜盘' : 'Overnight'
  return language === 'zh' ? '不可用' : 'Unavailable'
}

export function displayPendingOrderStatus(status: string): string {
  return ({
    PENDING_CONFIRMATION: '待确认',
    CONFIRMED_SUBMITTING: '提交中',
    SUBMITTED: '已提交',
    REJECTED_BY_USER: '已拒绝',
    EXPIRED: '已过期',
    BLOCKED_BY_RISK: '风控拦截',
    SUBMIT_FAILED: '提交失败',
  } as Record<string, string>)[status] ?? status
}

export function displayManagedOrderEventDetail(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '无补充说明'
  const labels: Record<string, string> = {
    action: '决策',
    brokerStatus: '券商状态',
    confidence: '置信度',
    error: '错误',
    reason: '原因',
    remainingQuantity: '剩余数量',
    requestId: '请求编号',
    status: '状态',
  }
  const values: Record<string, string> = {
    KEEP: '继续等待',
    CANCEL: '建议撤单',
    TRACKING: '挂单中',
    PARTIALLY_FILLED: '部分成交',
    CANCEL_RECOMMENDED: '建议撤单',
    CANCEL_REQUESTED: '撤单已请求',
    CANCEL_PENDING: '撤单处理中',
    FILLED: '全部成交',
    CANCELED: '已撤单',
    PARTIALLY_CANCELED: '部分成交后撤单',
    REJECTED: '已拒绝',
    EXPIRED: '已过期',
  }
  const rows = Object.entries(detail as Record<string, unknown>)
    .filter(([key, value]) => labels[key] && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${labels[key]}：${values[String(value)] ?? String(value)}`)
  return rows.join('；') || '已记录券商状态变化'
}
