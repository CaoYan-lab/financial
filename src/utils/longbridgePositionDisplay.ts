export type LongbridgePnlTone = 'profit' | 'loss' | 'neutral'

const unavailableValues = new Set(['', 'unavailable', '不可用', '暂无', 'null', 'undefined', '--'])

export function parseLongbridgeDisplayNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined

  const text = String(value).trim()
  if (unavailableValues.has(text.toLowerCase())) return undefined

  const negativeByParentheses = /^\(.*\)$/.test(text)
  const normalized = text
    .replace(/,/g, '')
    .replace(/[()]/g, '')
    .replace(/[^\d.+-]/g, '')
  const parsed = Number(normalized)

  if (!Number.isFinite(parsed)) return undefined
  return negativeByParentheses ? -Math.abs(parsed) : parsed
}

export function formatLongbridgePrice(value: unknown, currency: string): string {
  const parsed = parseLongbridgeDisplayNumber(value)
  if (parsed === undefined) return '不可用'

  const prefix = currencyPrefix(currency)
  return `${prefix}${parsed.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function formatLongbridgePnl(value: unknown): {
  label: string
  tone: LongbridgePnlTone
} {
  const parsed = parseLongbridgeDisplayNumber(value)
  if (parsed === undefined) return { label: '不可用', tone: 'neutral' }
  if (parsed === 0) return { label: '0.00', tone: 'neutral' }

  return {
    label: `${parsed > 0 ? '+' : ''}${parsed.toFixed(2)}`,
    tone: parsed > 0 ? 'profit' : 'loss',
  }
}

export function formatLongbridgeAccountPnl(value: unknown): {
  label: string
  tone: LongbridgePnlTone
} {
  const parsed = parseLongbridgeDisplayNumber(value)
  if (parsed === undefined) return { label: '不可用', tone: 'neutral' }

  const currencyPrefix = String(value).match(/HK\$|S\$|\$|¥/)?.[0] ?? ''
  if (parsed === 0) return { label: `${currencyPrefix}0.00`, tone: 'neutral' }

  return {
    label: `${parsed > 0 ? '+' : '-'}${currencyPrefix}${Math.abs(parsed).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`,
    tone: parsed > 0 ? 'profit' : 'loss',
  }
}

function currencyPrefix(currency: string): string {
  switch (currency.trim().toUpperCase()) {
    case 'USD':
      return '$'
    case 'HKD':
      return 'HK$'
    case 'CNY':
    case 'CNH':
      return '¥'
    case 'SGD':
      return 'S$'
    default:
      return ''
  }
}
