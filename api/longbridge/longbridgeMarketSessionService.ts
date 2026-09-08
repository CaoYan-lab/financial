import type {
  Market as LongbridgeMarketEnum,
  NaiveDate as LongbridgeNaiveDate,
} from 'longbridge'

type LongbridgeMarket = 'US' | 'HK'

type LongbridgeQuoteCalendar = {
  tradingDays(
    market: LongbridgeMarketEnum,
    start: LongbridgeNaiveDate,
    end: LongbridgeNaiveDate,
  ): Promise<{ tradingDays: Array<{ year?: number; month?: number; day?: number; toString(): string }> }>
}

export async function loadLongbridgeMarketStates(
  quote: LongbridgeQuoteCalendar,
  symbols: string[],
  now = new Date(),
): Promise<Map<string, string>> {
  const normalizedSymbols = [...new Set(symbols.map(normalizeLongbridgeSymbol))]
  const markets = new Set(normalizedSymbols.map(marketFromSymbol))
  const tradingDates = new Map<LongbridgeMarket, Set<string>>()
  try {
    const sdk = await import('longbridge')
    await Promise.all([...markets].map(async (market) => {
      const local = zonedDateTime(now, marketTimeZone(market))
      const endDate = addCalendarDays(local.date, 1)
      const response = await quote.tradingDays(
        market === 'HK' ? sdk.Market.HK : sdk.Market.US,
        naiveDate(sdk.NaiveDate, local.date),
        naiveDate(sdk.NaiveDate, endDate),
      )
      tradingDates.set(market, new Set(response.tradingDays.map(naiveDateKey)))
    }))
  } catch {
    return new Map(normalizedSymbols.map((symbol) => [symbol, 'UNAVAILABLE']))
  }
  return new Map(normalizedSymbols.map((symbol) => {
    const market = marketFromSymbol(symbol)
    return [symbol, marketStateAt(market, tradingDates.get(market) ?? new Set(), now)]
  }))
}

export function normalizeLongbridgeSymbol(ticker: string): string {
  const normalized = ticker.trim().toUpperCase()
  const hk = normalized.match(/^(?:HK\.)?(\d{1,5})(?:\.HK)?$/)
  if (hk) return `${String(Number(hk[1]))}.HK`
  if (normalized.includes('.')) return normalized
  return `${normalized}.US`
}

function marketStateAt(market: LongbridgeMarket, tradingDates: Set<string>, now: Date): string {
  const local = zonedDateTime(now, marketTimeZone(market))
  if (market === 'HK') {
    if (!tradingDates.has(local.date)) return 'CLOSED'
    if (local.minutes < 540) return 'WAITING_OPEN'
    if (local.minutes < 570) return 'AUCTION'
    if (local.minutes < 720) return 'MORNING'
    if (local.minutes < 780) return 'REST'
    if (local.minutes < 960) return 'AFTERNOON'
    if (local.minutes < 970) return 'TRADE_AT_LAST'
    return 'CLOSED'
  }
  const sessionDate = local.minutes >= 1200 ? addCalendarDays(local.date, 1) : local.date
  if (!tradingDates.has(sessionDate)) return 'CLOSED'
  if (local.minutes < 240 || local.minutes >= 1200) return 'OVERNIGHT'
  if (local.minutes < 570) return 'PRE_MARKET_BEGIN'
  if (local.minutes < 960) return 'RTH'
  return 'AFTER_HOURS_BEGIN'
}

function zonedDateTime(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  }
}

function addCalendarDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

function naiveDate(
  Constructor: new (year: number, month: number, day: number) => LongbridgeNaiveDate,
  date: string,
): LongbridgeNaiveDate {
  const [year, month, day] = date.split('-').map(Number)
  return new Constructor(year, month, day)
}

function naiveDateKey(value: { year?: number; month?: number; day?: number; toString(): string }): string {
  if (Number.isFinite(value.year) && Number.isFinite(value.month) && Number.isFinite(value.day)) {
    return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`
  }
  return String(value).slice(0, 10)
}

function marketFromSymbol(symbol: string): LongbridgeMarket {
  return symbol.toUpperCase().endsWith('.HK') ? 'HK' : 'US'
}

function marketTimeZone(market: LongbridgeMarket): string {
  return market === 'HK' ? 'Asia/Hong_Kong' : 'America/New_York'
}
