export function displaySide(side: string, language: 'zh' | 'en'): string {
  if (language === 'en') return side
  if (side === 'BUY') return '买入'
  if (side === 'SELL_SHORT') return '卖空'
  if (side === 'SELL_TO_CLOSE') return '平仓卖出'
  return '观望'
}

export function displaySignalModel(modelLabel: string | undefined, model: string | undefined, language: 'zh' | 'en'): string {
  return modelLabel || model || (language === 'zh' ? '历史未记录' : 'Not recorded')
}

export function displayOrderType(orderType: string, language: 'zh' | 'en'): string {
  if (orderType === 'MARKET') return language === 'zh' ? '市价' : 'Market'
  if (orderType === 'MARKETABLE_LIMIT') return language === 'zh' ? '主动限价' : 'Marketable Limit'
  if (orderType === 'LIMIT') return language === 'zh' ? '限价' : 'Limit'
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
  return 'unavailable'
}
