import type { LongbridgeStrategyMarketData } from '../../shared/longbridgeTypes.js'
import type { RealtimeBar, RealtimeOrderBookLevel, RealtimePoint, TrendContextSummary } from '../../shared/types.js'
import { buildTrendContextSummary } from '../simulation/trendContextService.js'
import { parseJsonOutput, runLongbridgeCli } from './longbridgeCli.js'

const MIN_TREND_BARS = 10

export async function loadLongbridgeStrategyMarketData(symbolInput: string, options: { klineCount?: number; includeDepth?: boolean; includeTrades?: boolean } = {}): Promise<LongbridgeStrategyMarketData> {
  const symbol = normalizeLongbridgeSymbol(symbolInput)
  const warnings: string[] = []
  const quote = await runLongbridgeCli(['quote', symbol, '--format', 'json'], { timeoutMs: 15_000 })
  if (!quote.ok) {
    return { ok: false, ticker: tickerFromSymbol(symbol), symbol, source: 'longbridge-cli', reason: quote.stderr || quote.error || 'Longbridge quote failed', warnings }
  }

  const quoteRecord = firstRecord(parseJsonOutput<unknown>(quote))
  const marketState = stringValue(quoteRecord, ['trade_status', 'tradeStatus', 'market_state'])
  const requiredKlineCount = options.klineCount ?? 120
  let bars = latestSessionBars(await loadLongbridgeKlineBars(symbol, '1m', requiredKlineCount, warnings), marketState, requiredKlineCount, symbol)
  if (bars.length < requiredKlineCount) {
    const backfilledBars = latestSessionBars(await loadLongbridgeKlineBars(symbol, '1m', Math.max(requiredKlineCount * 3, requiredKlineCount + 120), warnings), marketState, requiredKlineCount, symbol)
    if (backfilledBars.length > bars.length) {
      bars = backfilledBars
      warnings.push(`Longbridge 1m K 线已补足：当前 ${bars.length} / 要求 ${requiredKlineCount}`)
    }
  }

  const depth = options.includeDepth === false ? undefined : await runLongbridgeCli(['depth', symbol, '--format', 'json'], { timeoutMs: 15_000 })
  if (depth && !depth.ok) warnings.push(`Longbridge depth 读取失败：${depth.stderr || depth.error || 'unknown error'}`)

  const trades = options.includeTrades === false ? undefined : await runLongbridgeCli(['trades', symbol, '--format', 'json'], { timeoutMs: 15_000 })
  if (trades && !trades.ok) warnings.push(`Longbridge trades 读取失败：${trades.stderr || trades.error || 'unknown error'}`)

  const rawTickerPoints = latestSessionPoints(normalizeTickerPoints(parseJsonOutput<unknown>(trades), quoteRecord), marketState, symbol)
  const tickerPoints = supplementTickerPointsFromBars(rawTickerPoints, bars)
  const { asks, bids } = normalizeDepth(parseJsonOutput<unknown>(depth ?? { ok: false, stdout: '', stderr: '' }))
  const lastPrice = latestQuotePrice(quoteRecord, symbol)
    ?? bars.at(-1)?.close
    ?? tickerPoints.at(-1)?.price

  if (lastPrice === undefined) {
    return { ok: false, ticker: tickerFromSymbol(symbol), symbol, source: 'longbridge-cli', reason: 'Longbridge quote 缺少可解析最新价', warnings }
  }

  if (!bars.length) warnings.push('Longbridge 1m K 线为空，LLM 数据窗口会降级。')
  if (!tickerPoints.length) warnings.push('Longbridge trades 为空，分时点使用 quote 最新价兜底。')

  return {
    ok: true,
    ticker: tickerFromSymbol(symbol),
    symbol,
    source: 'longbridge-cli',
    lastPrice,
    bars,
    tickerPoints: tickerPoints.length ? tickerPoints : [{ time: new Date().toISOString(), price: lastPrice }],
    asks,
    bids,
    bestAsk: parseLevelPrice(asks[0]),
    bestBid: parseLevelPrice(bids[0]),
    marketState,
    updatedAt: new Date().toISOString(),
    warnings,
  }
}

export async function loadLongbridgeTrendContext(
  symbolInput: string,
  input: {
    lookbackTradingDays: number
    barInterval: '15m' | '30m' | '1d'
    currentPrice: number
  },
): Promise<TrendContextSummary> {
  const symbol = normalizeLongbridgeSymbol(symbolInput)
  const ticker = tickerFromSymbol(symbol)
  const warnings: string[] = []
  const count = trendBarCount(input.lookbackTradingDays, input.barInterval)
  let bars = await loadLongbridgeKlineBars(symbol, input.barInterval, count, warnings)

  if (bars.length < MIN_TREND_BARS && input.barInterval !== '1d') {
    const oneMinuteBars = await loadLongbridgeKlineBars(symbol, '1m', Math.max(input.lookbackTradingDays * 420, 780), warnings)
    const aggregated = aggregateBars(oneMinuteBars, input.barInterval)
    if (aggregated.length > bars.length) bars = aggregated
  }

  const summary = buildTrendContextSummary(ticker, input, bars, new Date().toISOString())
  return {
    ...summary,
    window: {
      ...summary.window,
      source: 'longbridge-history-kline',
      reason: summary.window.reason ?? (warnings.length ? warnings.join('；') : undefined),
    },
    summary: summary.window.available ? summary.summary.replace('趋势为', 'Longbridge 趋势为') : `Longbridge ${summary.summary}`,
  }
}

export function normalizeLongbridgeSymbol(input: string): string {
  const trimmed = input.trim().toUpperCase()
  if (!trimmed) return 'AAPL.US'
  if (trimmed.includes('.')) return trimmed.replace(/^0+(\d+)\.HK$/, '$1.HK')
  if (/^\d{5}$/.test(trimmed)) return `${trimmed.replace(/^0+/, '')}.HK`
  return `${trimmed}.US`
}

function tickerFromSymbol(symbol: string): string {
  const [code, market] = symbol.toUpperCase().split('.')
  if (market === 'HK' && /^\d+$/.test(code)) return code.padStart(5, '0')
  return code
}

async function loadLongbridgeKlineBars(symbol: string, period: string, count: number, warnings: string[]): Promise<RealtimeBar[]> {
  const attempts = [
    ['kline', symbol, '--period', period, '--count', String(count), '--format', 'json'],
    ['kline', symbol, '--period', period, '--count', String(count), '--session', 'all', '--format', 'json'],
  ]
  const errors: string[] = []
  for (const args of attempts) {
    const kline = await runLongbridgeCli(args, { timeoutMs: 45_000 })
    if (!kline.ok) {
      errors.push(kline.stderr || kline.error || 'unknown error')
      continue
    }
    const bars = normalizeBars(parseJsonOutput<unknown>(kline))
    if (bars.length) return bars
    errors.push('返回空 K 线')
  }
  warnings.push(`Longbridge ${period} K 线读取失败：${errors.join('；')}`)
  return []
}

function trendBarCount(lookbackTradingDays: number, interval: '15m' | '30m' | '1d') {
  if (interval === '1d') return Math.max(MIN_TREND_BARS, lookbackTradingDays + 5)
  const barsPerDay = interval === '15m' ? 26 : 13
  return Math.max(MIN_TREND_BARS, lookbackTradingDays * barsPerDay + barsPerDay)
}

function aggregateBars(bars: RealtimeBar[], interval: '15m' | '30m' | '1d') {
  if (!bars.length) return []
  const bucketMs = interval === '15m' ? 15 * 60_000 : interval === '30m' ? 30 * 60_000 : 24 * 60 * 60_000
  const buckets = new Map<number, RealtimeBar[]>()
  for (const bar of bars) {
    const time = new Date(bar.time).getTime()
    if (!Number.isFinite(time)) continue
    const bucket = Math.floor(time / bucketMs) * bucketMs
    const group = buckets.get(bucket) ?? []
    group.push(bar)
    buckets.set(bucket, group)
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, group]) => ({
      time: new Date(bucket).toISOString(),
      open: group[0].open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group.at(-1)?.close ?? group[0].close,
    }))
}

function latestSessionBars(bars: RealtimeBar[], marketState: string | undefined, required: number, symbol: string): RealtimeBar[] {
  return latestSessionItems(bars, marketState, required, symbol)
}

function latestSessionPoints(points: RealtimePoint[], marketState: string | undefined, symbol: string): RealtimePoint[] {
  return latestSessionItems(points, marketState, 0, symbol)
}

function latestSessionItems<T extends { time: string }>(items: T[], marketState: string | undefined, required: number, symbol: string): T[] {
  const sorted = [...items].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
  const latest = sorted.at(-1)
  if (!latest) return []
  const latestDate = marketDatePart(latest.time, symbol)
  if (isOvernightState(marketState)) return latestOvernightItems(sorted, latestDate, symbol)
  if (isPreMarketState(marketState) || isEarlyMorningState(marketState, latest.time, symbol)) return latestDateWithPreviousIfNeeded(sorted, latestDate, required, symbol)
  return sorted.filter((item) => marketDatePart(item.time, symbol) === latestDate)
}

function latestDateWithPreviousIfNeeded<T extends { time: string }>(items: T[], latestDate: string, required: number, symbol: string): T[] {
  const latestDateItems = items.filter((item) => marketDatePart(item.time, symbol) === latestDate)
  if (required > 0 && latestDateItems.length >= required) return latestDateItems
  const previousDate = previousAvailableDate(items, latestDate, symbol)
  if (!previousDate) return latestDateItems
  return items.filter((item) => {
    const itemDate = marketDatePart(item.time, symbol)
    return itemDate === latestDate || itemDate === previousDate
  })
}

function latestOvernightItems<T extends { time: string }>(items: T[], latestDate: string, symbol: string): T[] {
  const latestTime = marketTimePart(items.at(-1)?.time ?? '', symbol)
  const previousDate = previousAvailableDate(items, latestDate, symbol)
  if (latestTime && latestTime < '04:00:00' && previousDate) {
    return items.filter((item) => {
      const itemDate = marketDatePart(item.time, symbol)
      const itemTime = marketTimePart(item.time, symbol)
      return (itemDate === previousDate && itemTime >= '20:00:00') || (itemDate === latestDate && itemTime < '04:00:00')
    })
  }
  return items.filter((item) => marketDatePart(item.time, symbol) === latestDate)
}

function previousAvailableDate<T extends { time: string }>(items: T[], latestDate: string, symbol: string): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const itemDate = marketDatePart(items[index].time, symbol)
    if (itemDate && itemDate !== latestDate) return itemDate
  }
  return undefined
}

function supplementTickerPointsFromBars(points: RealtimePoint[], bars: RealtimeBar[]): RealtimePoint[] {
  const byTime = new Map<string, RealtimePoint>()
  for (const bar of bars) byTime.set(bar.time, { time: bar.time, price: bar.close })
  for (const point of points) byTime.set(point.time, point)
  return [...byTime.values()].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
}

function isPreMarketState(state: string | undefined) {
  return /PRE[_\s-]?MARKET/i.test(state ?? '')
}

function isEarlyMorningState(state: string | undefined, latestTimeValue: string, symbol: string) {
  const marketTime = marketTimePart(latestTimeValue, symbol)
  if (!marketTime || marketTime >= '10:00:00') return false
  return /MORNING|NORMAL/i.test(state ?? '') || isHongKongSymbol(symbol)
}

function isOvernightState(state: string | undefined) {
  return /OVERNIGHT|NIGHT/i.test(state ?? '')
}

function marketDatePart(value: string, symbol: string) {
  return formatMarketDateTime(value, symbol).date
}

function marketTimePart(value: string, symbol: string) {
  return formatMarketDateTime(value, symbol).time
}

function formatMarketDateTime(value: string, symbol: string) {
  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: isHongKongSymbol(symbol) ? 'Asia/Hong_Kong' : 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` }
  }
  const rawTime = value.includes('T') ? value.split('T')[1] : value.split(' ')[1]
  return { date: value.slice(0, 10), time: (rawTime ?? '').slice(0, 8) }
}

function isHongKongSymbol(symbol: string) {
  return symbol.toUpperCase().endsWith('.HK')
}

function normalizeBars(payload: unknown): RealtimeBar[] {
  return records(payload).map((item) => {
    const record = item as Record<string, unknown>
    const close = numberValue(record.close)
    const open = numberValue(record.open) ?? close
    const high = numberValue(record.high) ?? close
    const low = numberValue(record.low) ?? close
    if (close === undefined || open === undefined || high === undefined || low === undefined) return undefined
    return {
      time: stringValue(record, ['timestamp', 'time', 'date']) ?? new Date().toISOString(),
      open,
      high,
      low,
      close,
    }
  }).filter((bar): bar is RealtimeBar => Boolean(bar))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
}

function normalizeTickerPoints(payload: unknown, quoteRecord: Record<string, unknown>): RealtimePoint[] {
  const points = records(payload).map((item) => {
    const record = item as Record<string, unknown>
    const price = firstNumber(record, ['price', 'trade_price', 'last_done'])
    return price === undefined ? undefined : {
      time: stringValue(record, ['timestamp', 'time', 'date']) ?? new Date().toISOString(),
      price,
    }
  }).filter((item): item is RealtimePoint => Boolean(item))
  if (points.length) return points
  const fallback = latestQuotePrice(quoteRecord, stringValue(quoteRecord, ['symbol']) ?? '')
  return fallback === undefined ? [] : [{ time: new Date().toISOString(), price: fallback }]
}

function normalizeDepth(payload: unknown): { asks: RealtimeOrderBookLevel[]; bids: RealtimeOrderBookLevel[] } {
  const record = firstRecord(payload)
  return {
    asks: normalizeLevels(record.asks ?? record.ask ?? record.sell),
    bids: normalizeLevels(record.bids ?? record.bid ?? record.buy),
  }
}

function normalizeLevels(value: unknown): RealtimeOrderBookLevel[] {
  return records(value).map((item, index) => {
    const record = item as Record<string, unknown>
    return {
      price: formatPrice(firstNumber(record, ['price', 'quote'])),
      size: String(record.volume ?? record.size ?? record.quantity ?? ''),
      depth: index + 1,
    }
  }).filter((level) => level.price !== 'unavailable')
}

function records(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['data', 'items', 'list', 'quotes', 'candles', 'klines', 'trades']) {
      if (Array.isArray(record[key])) return records(record[key])
    }
    return [record]
  }
  return []
}

function firstRecord(payload: unknown): Record<string, unknown> {
  return records(payload)[0] ?? {}
}

export function latestQuotePrice(record: Record<string, unknown>, symbol: string, now = new Date()): number | undefined {
  const upperSymbol = symbol.toUpperCase()
  if (upperSymbol.endsWith('.US')) {
    const session = currentUsExtendedSession(now)
    const sessionRecord = session === 'pre'
      ? nestedRecord(record, ['pre_market', 'preMarket'])
      : session === 'post'
        ? nestedRecord(record, ['post_market', 'postMarket'])
        : session === 'overnight'
          ? nestedRecord(record, ['overnight'])
          : undefined
    const sessionPrice = sessionRecord ? firstNumber(sessionRecord, ['last_done', 'lastDone', 'last', 'price', 'current_price', 'currentPrice']) : undefined
    if (sessionPrice !== undefined) return sessionPrice
  }
  return firstNumber(record, ['last_done', 'lastDone', 'last', 'price', 'close', 'current_price', 'currentPrice'])
}

function nestedRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  }
  return undefined
}

function currentUsExtendedSession(now: Date): 'pre' | 'regular' | 'post' | 'overnight' {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
  if (seconds >= 4 * 3600 && seconds < 9 * 3600 + 30 * 60) return 'pre'
  if (seconds >= 9 * 3600 + 30 * 60 && seconds < 16 * 3600) return 'regular'
  if (seconds >= 16 * 3600 && seconds < 20 * 3600) return 'post'
  return 'overnight'
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = numberValue(record[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[$,%\s,]/g, ''))
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function stringValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function formatPrice(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `$${value.toFixed(2)}`
}

function parseLevelPrice(level: RealtimeOrderBookLevel | undefined): number | undefined {
  if (!level) return undefined
  return numberValue(level.price)
}
