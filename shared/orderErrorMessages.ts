const LONGBRIDGE_ORDER_ERROR_TRANSLATIONS: Array<{
  matches: (message: string) => boolean
  translated: string
}> = [
  {
    matches: (message) => message.includes('602035') || /wrong bid size/i.test(message),
    translated: '委托价格不符合该证券的最小报价单位，请调整价格（长桥错误码 602035）。',
  },
  {
    matches: (message) =>
      message.includes('602065')
      || /has not confirmed the risk disclaimer of US short-sell/i.test(message),
    translated: '账户尚未确认美股卖空风险声明，请先在长桥应用中完成确认（长桥错误码 602065）。',
  },
  {
    matches: (message) => /order amount exceeds the maximum buying power/i.test(message),
    translated: '订单金额超过账户最大购买力。',
  },
]

export function localizeLongbridgeOrderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '').trim()
  if (!message) return '长桥未返回具体失败原因。'

  const matched = LONGBRIDGE_ORDER_ERROR_TRANSLATIONS.find((item) => item.matches(message))
  if (matched) return matched.translated

  return message
    .replace(/^Longbridge SDK order failed:\s*/i, '长桥订单提交失败：')
    .replace(/^openapi error:\s*/i, '长桥开放接口错误：')
}
