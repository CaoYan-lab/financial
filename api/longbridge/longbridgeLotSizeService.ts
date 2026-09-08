export type LongbridgeStaticInfoContext = {
  staticInfo(symbols: string[]): Promise<Array<{
    symbol: string
    lotSize: number
  }>>
}

const lotSizes = new Map<string, number>()

export async function loadLongbridgeLotSize(
  quote: LongbridgeStaticInfoContext,
  symbolInput: string,
): Promise<number> {
  const symbol = normalizeSymbol(symbolInput)
  const cached = lotSizes.get(symbol)
  if (cached) return cached

  try {
    const info = await quote.staticInfo([symbol])
    const matched = info.find((item) => normalizeSymbol(item.symbol) === symbol) ?? info[0]
    const lotSize = normalizeLotSize(matched?.lotSize, symbol)
    lotSizes.set(symbol, lotSize)
    return lotSize
  } catch {
    return fallbackLotSize(symbol)
  }
}

export function openingLotSizeFailureReason(input: {
  symbol: string
  action: string
  quantity: number
  lotSize?: number
}): string | undefined {
  const symbol = normalizeSymbol(input.symbol)
  if (!symbol.endsWith('.HK')) return undefined
  if (input.action !== 'BUY' && input.action !== 'SELL_SHORT') return undefined

  const quantity = Math.floor(Number(input.quantity))
  const lotSize = normalizeLotSize(input.lotSize, symbol)
  if (quantity > 0 && quantity % lotSize === 0) return undefined
  return `港股开仓数量 ${quantity} 股不符合每手 ${lotSize} 股的交易单位。`
}

export function fallbackTradingLotSize(symbolInput: string): number {
  return normalizeSymbol(symbolInput).endsWith('.HK') ? 100 : 1
}

export const longbridgeOpeningLotSizeFailureReason = openingLotSizeFailureReason
export const fallbackLotSize = fallbackTradingLotSize

export function longbridgeTradingCurrency(symbolInput: string): 'USD' | 'HKD' {
  return normalizeSymbol(symbolInput).endsWith('.HK') ? 'HKD' : 'USD'
}

function normalizeLotSize(value: unknown, symbol: string): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackTradingLotSize(symbol)
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase()
  if (symbol.includes('.')) return symbol.replace(/^0+(\d+)\.HK$/, '$1.HK')
  if (/^\d{1,5}$/.test(symbol)) return `${String(Number(symbol))}.HK`
  return `${symbol}.US`
}
