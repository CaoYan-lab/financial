import type { LongbridgePosition } from '../../shared/longbridgeTypes.js'

export function sumLongbridgePositionTodayPnl(
  positions: LongbridgePosition[],
  currency: string,
): number | undefined {
  const normalizedCurrency = currency.trim().toUpperCase()
  const matchingPositions = positions.filter((position) =>
    position.currency.trim().toUpperCase() === normalizedCurrency)

  if (!matchingPositions.length) {
    const hasUnknownCurrency = positions.some((position) =>
      !position.currency.trim() || position.currency === 'unavailable')
    return hasUnknownCurrency ? undefined : 0
  }

  const values = matchingPositions.map((position) => parseMoney(position.todayPnL))
  if (values.some((value) => value === undefined)) return undefined

  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function parseMoney(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  if (!text || ['unavailable', '不可用', '暂无'].includes(text.toLowerCase())) return undefined

  const negativeByParentheses = /^\(.*\)$/.test(text)
  const numeric = Number(
    text
      .replace(/,/g, '')
      .replace(/[()]/g, '')
      .replace(/[^\d.+-]/g, ''),
  )
  if (!Number.isFinite(numeric)) return undefined
  return negativeByParentheses ? -Math.abs(numeric) : numeric
}
