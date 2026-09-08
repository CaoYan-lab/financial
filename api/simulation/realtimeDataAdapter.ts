import type { LlmDataWindowRecommendation, RealtimeBar, RealtimeOrderBookLevel, RealtimePoint, RealtimeStockResponse } from '../../shared/types.js'
import { realtimeStore } from '../realtime/realtimeStore.js'

type MarketDataRequirement =
  | number
  | (Pick<LlmDataWindowRecommendation, 'kline1mBars' | 'tickerPoints' | 'orderBookDepth'> & {
      maxCacheAgeMs?: number
      now?: Date
    })

export type StrategyMarketData =
  | {
      ok: true
      ticker: string
      lastPrice: number
      bars: RealtimeBar[]
      tickerPoints: RealtimePoint[]
      asks: RealtimeOrderBookLevel[]
      bids: RealtimeOrderBookLevel[]
      bestAsk?: number
      bestBid?: number
      lotSize?: number
      marketState?: string
      updatedAt: string
    }
  | {
      ok: false
      ticker: string
      reason: string
    }

export function loadStrategyMarketData(ticker: string, requirement: MarketDataRequirement = 30): StrategyMarketData {
  const required = normalizeRequirement(requirement)
  const snapshot = realtimeStore.snapshot(ticker)
  if (snapshot.source !== 'futu-callback') {
    return { ok: false, ticker: ticker.toUpperCase(), reason: '缺少 Futu 实时回调缓存' }
  }
  const session = sessionSeriesContext(snapshot.quote?.marketState)
  const klineBars = latestSessionSeries(snapshot.klineBars, session, required.kline1mBars)
  const rawTickerPoints = latestSessionSeries(snapshot.tickerPoints, session, required.tickerPoints)
  const tickerPoints = rawTickerPoints.length >= required.tickerPoints ? rawTickerPoints : supplementTickerPointsFromBars(rawTickerPoints, klineBars)

  const staleReason = realtimeCacheStaleReason(snapshot, required.maxCacheAgeMs, required.now)
  if (staleReason) {
    return { ok: false, ticker: ticker.toUpperCase(), reason: staleReason }
  }

  const lastPrice = latestPrice(snapshot, tickerPoints, klineBars)
  if (lastPrice === undefined) {
    return { ok: false, ticker: ticker.toUpperCase(), reason: '缺少可解析的实时价格' }
  }

  if (klineBars.length < required.kline1mBars) {
    const total = snapshot.klineBars.length
    const suffix = total > klineBars.length ? `，已剔除非当前会话旧 K 线 ${total - klineBars.length} 条` : ''
    return { ok: false, ticker: ticker.toUpperCase(), reason: `当前会话 1 分钟 K 线不足：当前 ${klineBars.length} / 要求 ${required.kline1mBars}${suffix}` }
  }

  if (tickerPoints.length < required.tickerPoints) {
    const total = snapshot.tickerPoints.length
    const suffix = total > tickerPoints.length ? `，已剔除跨交易日旧分时点 ${total - tickerPoints.length} 条` : ''
    return { ok: false, ticker: ticker.toUpperCase(), reason: `分时点不足：当前 ${tickerPoints.length} / 要求 ${required.tickerPoints}${suffix}` }
  }

  if (snapshot.asks.length < required.orderBookDepth || snapshot.bids.length < required.orderBookDepth) {
    return { ok: false, ticker: ticker.toUpperCase(), reason: `买卖盘深度不足：当前 ask ${snapshot.asks.length} / bid ${snapshot.bids.length} / 要求 ${required.orderBookDepth}` }
  }

  return {
    ok: true,
    ticker: snapshot.ticker,
    lastPrice,
    bars: klineBars,
    tickerPoints,
    asks: snapshot.asks,
    bids: snapshot.bids,
    bestAsk: parseMoney(snapshot.asks[0]?.price),
    bestBid: parseMoney(snapshot.bids[0]?.price),
    lotSize: snapshot.quote?.lotSize,
    marketState: snapshot.quote?.marketState,
    updatedAt: snapshot.updatedAt,
  }
}

function normalizeRequirement(requirement: MarketDataRequirement) {
  if (typeof requirement === 'number') {
    return {
      kline1mBars: requirement,
      tickerPoints: 0,
      orderBookDepth: 0,
    }
  }
  return requirement
}

function realtimeCacheStaleReason(snapshot: RealtimeStockResponse, maxCacheAgeMs: number | undefined, now: Date | undefined): string | undefined {
  if (!maxCacheAgeMs || maxCacheAgeMs <= 0) return undefined
  const updatedAt = latestSnapshotUpdatedAt(snapshot)
  const updatedAtMs = timestampMs(updatedAt)
  if (!updatedAt || updatedAtMs === undefined) return 'Futu 实时缓存缺少更新时间，已跳过本轮 LLM。'
  const ageMs = (now ?? new Date()).getTime() - updatedAtMs
  if (!Number.isFinite(ageMs) || ageMs <= maxCacheAgeMs) return undefined
  return `Futu 实时缓存已过期：最新回调 ${updatedAt}，距今 ${Math.round(ageMs / 1000)} 秒，已跳过本轮 LLM。`
}

function latestSnapshotUpdatedAt(snapshot: RealtimeStockResponse): string {
  return [
    snapshot.callbackStatus.quote.updatedAt,
    snapshot.callbackStatus.ticker.updatedAt,
    snapshot.callbackStatus.kline.updatedAt,
    snapshot.callbackStatus.orderBook.updatedAt,
    snapshot.quote?.updatedAt,
    snapshot.updatedAt,
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? ''
}

type PriceCandidate = { price: number | undefined; time?: string }
type ValidPriceCandidate = { price: number; time?: string }

function latestPrice(snapshot: RealtimeStockResponse, tickerPoints: RealtimePoint[], klineBars: RealtimeBar[]): number | undefined {
  const candidates = [
    { price: parseMoney(snapshot.quote?.price), time: snapshot.quote?.updatedAt },
    { price: tickerPoints.at(-1)?.price, time: tickerPoints.at(-1)?.time },
    { price: klineBars.at(-1)?.close, time: klineBars.at(-1)?.time },
  ].filter((candidate: PriceCandidate): candidate is ValidPriceCandidate => Number.isFinite(candidate.price))

  const timedCandidates: Array<ValidPriceCandidate & { timestamp: number }> = []
  for (const candidate of candidates) {
    const timestamp = timestampMs(candidate.time)
    if (timestamp !== undefined) timedCandidates.push({ ...candidate, timestamp })
  }
  if (timedCandidates.length) {
    return timedCandidates.sort((left, right) => right.timestamp - left.timestamp)[0].price
  }
  return candidates[0]?.price
}

function supplementTickerPointsFromBars(points: RealtimePoint[], bars: RealtimeBar[]): RealtimePoint[] {
  if (!bars.length) return points
  const byTime = new Map<string, RealtimePoint>()
  for (const bar of bars) byTime.set(bar.time, { time: bar.time, price: bar.close })
  for (const point of points) byTime.set(point.time, point)
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time))
}

type SessionSeriesContext = {
  marketState: string
}

function sessionSeriesContext(marketState?: string): SessionSeriesContext {
  return {
    marketState: String(marketState ?? '').toUpperCase(),
  }
}

function latestSessionSeries<T extends { time: string }>(items: T[], context: SessionSeriesContext, required: number): T[] {
  const sorted = [...items].sort((a, b) => a.time.localeCompare(b.time))
  const latest = sorted.at(-1)
  if (!latest) return []
  const latestDate = datePart(latest.time)
  if (!latestDate) return sorted
  if (isOvernightState(context.marketState)) {
    return latestOvernightSeries(sorted, latestDate)
  }
  if (isPreMarketState(context.marketState) || isEarlyMorningState(context.marketState, latest.time)) {
    return latestDateWithPreviousIfNeeded(sorted, latestDate, required)
  }
  return sorted.filter((item) => datePart(item.time) === latestDate)
}

function latestDateWithPreviousIfNeeded<T extends { time: string }>(items: T[], latestDate: string, required: number): T[] {
  const latestDateItems = items.filter((item) => datePart(item.time) === latestDate)
  if (latestDateItems.length >= required) return latestDateItems
  const previousDate = previousAvailableDate(items, latestDate)
  if (!previousDate) return latestDateItems
  return items.filter((item) => {
    const itemDate = datePart(item.time)
    return itemDate === latestDate || itemDate === previousDate
  })
}

function latestOvernightSeries<T extends { time: string }>(items: T[], latestDate: string): T[] {
  const latestTime = timePart(items.at(-1)?.time ?? '')
  const previousDate = previousAvailableDate(items, latestDate)
  if (latestTime && latestTime < '04:00:00' && previousDate) {
    return items.filter((item) => {
      const itemDate = datePart(item.time)
      const itemTime = timePart(item.time)
      return (itemDate === previousDate && itemTime >= '20:00:00') || (itemDate === latestDate && itemTime < '04:00:00')
    })
  }
  return items.filter((item) => datePart(item.time) === latestDate)
}

function previousAvailableDate<T extends { time: string }>(items: T[], latestDate: string): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const itemDate = datePart(items[index].time)
    if (itemDate && itemDate !== latestDate) return itemDate
  }
  return undefined
}

function isPreMarketState(state: string): boolean {
  return state === 'PRE_MARKET_BEGIN' || state === 'PRE_MARKET_END'
}

function isEarlyMorningState(state: string, latestTimeValue: string): boolean {
  if (timePart(latestTimeValue) >= '10:00:00') return false
  return state === 'MORNING' || state === 'NORMAL' || state === 'RTH'
}

function isOvernightState(state: string): boolean {
  return state === 'OVERNIGHT' || state === 'NIGHT' || state === 'NIGHT_OPEN'
}

function datePart(value: string): string {
  return value.slice(0, 10)
}

function timePart(value: string): string {
  const raw = value.includes('T') ? value.split('T')[1] : value.split(' ')[1]
  return (raw ?? '').slice(0, 8)
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined
  const numeric = Number(value.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(numeric) ? numeric : undefined
}
