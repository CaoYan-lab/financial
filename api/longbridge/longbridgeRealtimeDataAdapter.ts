import type { LongbridgeStrategyMarketData } from '../../shared/longbridgeTypes.js'
import type { RealtimeBar, TrendContextSummary } from '../../shared/types.js'
import { buildTrendContextSummary } from '../simulation/trendContextService.js'
import { loadLongbridgeStrategyMarketData, loadLongbridgeTrendContext, normalizeLongbridgeSymbol } from './longbridgeMarketDataService.js'
import { longbridgeRealtimeStore, type LongbridgeBarPeriod } from './longbridgeRealtimeStore.js'
import { longbridgeRealtimeSubscriptionService } from './longbridgeRealtimeSubscriptionService.js'

const CACHE_STALE_MS = Math.max(30_000, Number(process.env.LONGBRIDGE_REALTIME_CACHE_STALE_MS || 90_000) || 90_000)
const MIN_TREND_BARS = 10

export async function ensureLongbridgeRealtimeSubscriptions(symbols: string[], options: { waitForSeed?: boolean; requiredKlineCount?: number } = {}) {
  await longbridgeRealtimeSubscriptionService.ensureSubscribed(symbols, options)
}

export function getLongbridgeRealtimeSubscriptionStatus() {
  return longbridgeRealtimeSubscriptionService.getStatus()
}

export async function loadLongbridgeRealtimeStrategyMarketData(
  symbolInput: string,
  options: { klineCount?: number; includeDepth?: boolean; includeTrades?: boolean; allowFallback?: boolean } = {},
): Promise<LongbridgeStrategyMarketData> {
  const symbol = normalizeLongbridgeSymbol(symbolInput)
  const requiredKlineCount = options.klineCount ?? 120
  const cached = fromCache(symbol, requiredKlineCount, options)
  if (cached.ok) return cached
  if (options.allowFallback === false || process.env.CLOUD_MODE === '1') return cached

  const fallback = await loadLongbridgeStrategyMarketData(symbol, options)
  if (!fallback.ok) {
    return {
      ...fallback,
      warnings: [...cached.warnings, ...fallback.warnings],
    }
  }
  longbridgeRealtimeStore.upsertQuote({
    symbol,
    lastPrice: fallback.lastPrice,
    marketState: fallback.marketState,
    updatedAt: fallback.updatedAt,
    source: 'longbridge-cli',
  })
  longbridgeRealtimeStore.upsertBars(symbol, '1m', fallback.bars)
  longbridgeRealtimeStore.upsertDepth(symbol, { asks: fallback.asks, bids: fallback.bids })
  longbridgeRealtimeStore.appendTrades(symbol, fallback.tickerPoints)
  return {
    ...fallback,
    warnings: [...cached.warnings, ...fallback.warnings, 'Longbridge SDK cache 不足，本轮使用 CLI 补拉兜底。'],
  }
}

export function longbridgeRealtimeReadinessReason(
  symbolInput: string,
  requiredKlineCount = 120,
): string | undefined {
  const cached = fromCache(normalizeLongbridgeSymbol(symbolInput), requiredKlineCount, {
    includeDepth: false,
    includeTrades: false,
  })
  if (cached.ok) return undefined
  return 'reason' in cached ? cached.reason : 'Longbridge SDK 行情缓存未就绪'
}

export async function loadLongbridgeRealtimeTrendContext(
  symbolInput: string,
  input: {
    lookbackTradingDays: number
    barInterval: '15m' | '30m' | '1d'
    currentPrice: number
  },
): Promise<TrendContextSummary> {
  const symbol = normalizeLongbridgeSymbol(symbolInput)
  const ticker = tickerFromSymbol(symbol)
  const snapshot = longbridgeRealtimeStore.getSnapshot(symbol)
  const bars = trendBarsFromSnapshot(snapshot?.bars ?? {}, input.barInterval, trendBarCount(input.lookbackTradingDays, input.barInterval))
  if (bars.length >= MIN_TREND_BARS) {
    const summary = buildTrendContextSummary(ticker, input, bars, new Date().toISOString())
    return {
      ...summary,
      window: {
        ...summary.window,
        source: 'longbridge-sdk-cache',
      },
      summary: summary.window.available ? summary.summary.replace('趋势为', 'Longbridge SDK 缓存趋势为') : `Longbridge SDK 缓存 ${summary.summary}`,
    }
  }

  const fallback = await loadLongbridgeTrendContext(symbol, input)
  return {
    ...fallback,
    window: {
      ...fallback.window,
      reason: fallback.window.reason ?? `SDK cache 趋势 K 线不足：当前 ${bars.length} / 要求 ${MIN_TREND_BARS}`,
    },
  }
}

function fromCache(symbol: string, requiredKlineCount: number, options: { includeDepth?: boolean; includeTrades?: boolean }): LongbridgeStrategyMarketData {
  const warnings: string[] = []
  const snapshot = longbridgeRealtimeStore.getSnapshot(symbol)
  const ticker = tickerFromSymbol(symbol)
  const status = longbridgeRealtimeStore.getStatus()
  if (status.state === 'degraded' || status.state === 'error') warnings.push(status.lastError ?? 'Longbridge SDK cache 当前不可用。')
  if (!snapshot?.quote) {
    warnings.push('Longbridge SDK cache 缺少 quote。')
    return { ok: false, ticker, symbol, source: 'longbridge-sdk-cache', reason: 'Longbridge SDK cache 缺少 quote', warnings }
  }
  if (isStale(snapshot.quote.updatedAt)) warnings.push(`Longbridge SDK quote cache 已超过 ${Math.round(CACHE_STALE_MS / 1000)} 秒未更新。`)

  const bars = latestSessionBars(snapshot.bars['1m'] ?? [], snapshot.quote.marketState, requiredKlineCount, symbol).slice(-requiredKlineCount)
  if (bars.length < requiredKlineCount) {
    warnings.push(`Longbridge SDK cache 1m K 线不足：当前 ${bars.length} / 要求 ${requiredKlineCount}。`)
    return { ok: false, ticker, symbol, source: 'longbridge-sdk-cache', reason: 'Longbridge SDK cache 1m K 线不足', warnings }
  }

  const rawTickerPoints = latestSessionPoints(snapshot.tickerPoints, snapshot.quote.marketState, symbol)
  const tickerPoints = rawTickerPoints.length
    ? supplementTickerPointsFromBars(rawTickerPoints, bars)
    : [{ time: snapshot.quote.updatedAt, price: snapshot.quote.lastPrice }]
  const lastPrice = tickerPoints.at(-1)?.price ?? snapshot.quote.lastPrice
  if (options.includeDepth !== false && (!snapshot.asks.length || !snapshot.bids.length)) warnings.push('Longbridge SDK cache 盘口为空，本轮盘口信息降级。')
  if (options.includeTrades !== false && !snapshot.tickerPoints.length) warnings.push('Longbridge SDK cache 成交 ticks 为空，分时点使用 quote 最新价兜底。')

  return {
    ok: true,
    ticker,
    symbol,
    source: 'longbridge-sdk-cache',
    lastPrice,
    bars,
    tickerPoints,
    asks: options.includeDepth === false ? [] : snapshot.asks,
    bids: options.includeDepth === false ? [] : snapshot.bids,
    bestAsk: parseLevelPrice(snapshot.asks[0]),
    bestBid: parseLevelPrice(snapshot.bids[0]),
    marketState: snapshot.quote.marketState,
    updatedAt: snapshot.quote.updatedAt,
    warnings,
  }
}

function latestSessionBars(bars: RealtimeBar[], marketState: string | undefined, required: number, symbol: string): RealtimeBar[] {
  return latestSessionItems(bars, marketState, required, symbol)
}

function latestSessionPoints(points: { time: string; price: number }[], marketState: string | undefined, symbol: string) {
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

function supplementTickerPointsFromBars(points: { time: string; price: number }[], bars: RealtimeBar[]) {
  const byTime = new Map<string, { time: string; price: number }>()
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

function trendBarsFromSnapshot(barsByPeriod: Partial<Record<LongbridgeBarPeriod, RealtimeBar[]>>, interval: '15m' | '30m' | '1d', count: number) {
  const direct = barsByPeriod[interval]
  if (direct?.length) return direct.slice(-count)
  const oneMinute = barsByPeriod['1m'] ?? []
  if (oneMinute.length && interval !== '1d') return aggregateBars(oneMinute, interval).slice(-count)
  return []
}

function trendBarCount(lookbackTradingDays: number, interval: '15m' | '30m' | '1d') {
  if (interval === '1d') return Math.max(MIN_TREND_BARS, lookbackTradingDays + 5)
  const barsPerDay = interval === '15m' ? 26 : 13
  return Math.max(MIN_TREND_BARS, lookbackTradingDays * barsPerDay + barsPerDay)
}

function aggregateBars(bars: RealtimeBar[], interval: '15m' | '30m') {
  const bucketMs = interval === '15m' ? 15 * 60_000 : 30 * 60_000
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

function tickerFromSymbol(symbol: string): string {
  const [code, market] = symbol.toUpperCase().split('.')
  if (market === 'HK' && /^\d+$/.test(code)) return code.padStart(5, '0')
  return code
}

function parseLevelPrice(level: { price: string } | undefined): number | undefined {
  if (!level) return undefined
  const parsed = Number(level.price.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function isStale(updatedAt: string) {
  const timestamp = new Date(updatedAt).getTime()
  return !Number.isFinite(timestamp) || Date.now() - timestamp > CACHE_STALE_MS
}
