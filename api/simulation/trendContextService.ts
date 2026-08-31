import type { RealtimeBar, TrendContextSummary } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'

type TrendBarInterval = '15m' | '30m' | '1d'

type FutuHistoryKlineResponse = {
  ok: boolean
  ticker: string
  interval: TrendBarInterval
  startDate: string
  endDate: string
  bars: Array<RealtimeBar & { volume?: number }>
  updatedAt: string
  warnings: string[]
}

type CacheEntry = {
  expiresAt: number
  value: TrendContextSummary
}

const CACHE_TTL_MS = 5 * 60_000
const MIN_TREND_BARS = 10
const cache = new Map<string, CacheEntry>()

export async function loadTrendContext(
  ticker: string,
  input: {
    lookbackTradingDays: number
    barInterval: TrendBarInterval
    currentPrice: number
  },
): Promise<TrendContextSummary> {
  const normalizedTicker = ticker.toUpperCase()
  const key = `${normalizedTicker}:${input.lookbackTradingDays}:${input.barInterval}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, currentPrice: input.currentPrice, updatedAt: new Date().toISOString() }
  }

  const range = dateRangeForLookback(input.lookbackTradingDays)
  const bridge = await runPythonBridge<FutuHistoryKlineResponse>('futu_history_kline.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    ticker: normalizedTicker,
    interval: input.barInterval,
    startDate: range.startDate,
    endDate: range.endDate,
    session: 'ALL',
  })

  const timestamp = new Date().toISOString()
  if (!bridge.ok || !bridge.data?.ok) {
    return unavailableTrendContext(normalizedTicker, input, bridge.data?.warnings?.[0] ?? bridge.error ?? 'Futu 历史 K 线不可用。', timestamp)
  }

  const summary = buildTrendContextSummary(normalizedTicker, input, bridge.data.bars, timestamp)
  cache.set(key, { value: summary, expiresAt: Date.now() + CACHE_TTL_MS })
  return summary
}

export function buildTrendContextSummary(
  ticker: string,
  input: {
    lookbackTradingDays: number
    barInterval: TrendBarInterval
    currentPrice: number
  },
  bars: RealtimeBar[],
  updatedAt = new Date().toISOString(),
): TrendContextSummary {
  const validBars = bars.filter((bar) => finite(bar.open) && finite(bar.high) && finite(bar.low) && finite(bar.close))
  if (validBars.length < MIN_TREND_BARS) {
    return unavailableTrendContext(ticker, input, `趋势 K 线不足：当前 ${validBars.length} / 要求 ${MIN_TREND_BARS}`, updatedAt)
  }

  const highs = validBars.map((bar) => bar.high)
  const lows = validBars.map((bar) => bar.low)
  const closes = validBars.map((bar) => bar.close)
  const sevenDayHigh = Math.max(...highs)
  const sevenDayLow = Math.min(...lows)
  const currentPrice = input.currentPrice
  const pricePositionInRange = sevenDayHigh > sevenDayLow ? clamp((currentPrice - sevenDayLow) / (sevenDayHigh - sevenDayLow), 0, 1) : 0.5
  const movingAverages = {
    short: average(closes.slice(-6)),
    medium: average(closes.slice(-13)),
    long: average(closes.slice(-26)),
  }
  const latestClose = closes.at(-1) ?? currentPrice
  const trendDirection = classifyTrendDirection(movingAverages, latestClose)
  const trendStrength = classifyTrendStrength(movingAverages, currentPrice)
  const volatilityLevel = classifyVolatility(validBars, currentPrice)
  const supportLevels = priceLevels([...lows].filter((level) => level <= currentPrice), 'support')
  const resistanceLevels = priceLevels([...highs].filter((level) => level >= currentPrice), 'resistance')
  const summary = `${ticker} 过去 ${input.lookbackTradingDays} 个交易日 ${input.barInterval} 趋势为 ${trendDirection}，强度 ${trendStrength}，波动 ${volatilityLevel}；当前价位于区间 ${formatPercent(pricePositionInRange)}，7日低点 ${formatNumber(sevenDayLow)}，7日高点 ${formatNumber(sevenDayHigh)}。`

  return {
    ticker,
    window: {
      lookbackTradingDays: input.lookbackTradingDays,
      barInterval: input.barInterval,
      source: 'futu-history-kline',
      available: true,
    },
    currentPrice,
    previousClose: closes.at(-2),
    sevenDayHigh,
    sevenDayLow,
    pricePositionInRange,
    trendDirection,
    trendStrength,
    volatilityLevel,
    movingAverages,
    supportLevels,
    resistanceLevels,
    summary,
    updatedAt,
  }
}

export function clearTrendContextCacheForTests() {
  cache.clear()
}

function unavailableTrendContext(
  ticker: string,
  input: {
    lookbackTradingDays: number
    barInterval: TrendBarInterval
    currentPrice: number
  },
  reason: string,
  updatedAt: string,
): TrendContextSummary {
  return {
    ticker,
    window: {
      lookbackTradingDays: input.lookbackTradingDays,
      barInterval: input.barInterval,
      source: 'futu-history-kline',
      available: false,
      reason,
    },
    currentPrice: input.currentPrice,
    trendDirection: 'UNKNOWN',
    trendStrength: 'UNKNOWN',
    volatilityLevel: 'UNKNOWN',
    movingAverages: {},
    supportLevels: [],
    resistanceLevels: [],
    summary: `趋势上下文不可用：${reason}`,
    updatedAt,
  }
}

function classifyTrendDirection(movingAverages: TrendContextSummary['movingAverages'], latestClose: number): TrendContextSummary['trendDirection'] {
  const { short, medium, long } = movingAverages
  if (!finite(short) || !finite(medium) || !finite(long)) return 'UNKNOWN'
  if (short > medium && medium > long && latestClose > medium) return 'UP'
  if (short < medium && medium < long && latestClose < medium) return 'DOWN'
  return 'SIDEWAYS'
}

function classifyTrendStrength(movingAverages: TrendContextSummary['movingAverages'], currentPrice: number): TrendContextSummary['trendStrength'] {
  const { short, long } = movingAverages
  if (!finite(short) || !finite(long) || currentPrice <= 0) return 'UNKNOWN'
  const spread = Math.abs(short - long) / currentPrice
  if (spread < 0.005) return 'WEAK'
  if (spread < 0.015) return 'MEDIUM'
  return 'STRONG'
}

function classifyVolatility(bars: RealtimeBar[], currentPrice: number): TrendContextSummary['volatilityLevel'] {
  if (!bars.length || currentPrice <= 0) return 'UNKNOWN'
  const recentBars = bars.slice(-26)
  const averageRange = average(recentBars.map((bar) => Math.max(0, bar.high - bar.low)))
  if (!finite(averageRange)) return 'UNKNOWN'
  const ratio = averageRange / currentPrice
  if (ratio < 0.01) return 'LOW'
  if (ratio < 0.03) return 'MEDIUM'
  return 'HIGH'
}

function priceLevels(levels: number[], mode: 'support' | 'resistance'): number[] {
  const unique = Array.from(new Set(levels.map((level) => roundPrice(level)))).sort((a, b) => (mode === 'support' ? b - a : a - b))
  return unique.slice(0, 3)
}

function dateRangeForLookback(lookbackTradingDays: number): { startDate: string; endDate: string } {
  const end = new Date()
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - Math.max(lookbackTradingDays + 3, lookbackTradingDays))
  return { startDate: isoDate(start), endDate: isoDate(end) }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function average(values: number[]): number | undefined {
  const valid = values.filter(finite)
  if (!valid.length) return undefined
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100
}

function formatNumber(value: number | undefined): string {
  return finite(value) ? value.toFixed(2) : 'N/A'
}

function formatPercent(value: number | undefined): string {
  return finite(value) ? `${(value * 100).toFixed(1)}%` : 'N/A'
}
