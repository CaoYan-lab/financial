import type { RealtimeBar, RealtimeOrderBookLevel, RealtimePoint } from '../../shared/types.js'
import { normalizeLongbridgeSymbol } from './longbridgeMarketDataService.js'

export type LongbridgeRealtimeSource = 'longbridge-sdk-cache' | 'longbridge-cli'
export type LongbridgeBarPeriod = '1m' | '15m' | '30m' | '1d'
export type LongbridgeSubscriptionState = 'idle' | 'starting' | 'subscribed' | 'degraded' | 'error'

export type LongbridgeQuoteCache = {
  symbol: string
  ticker: string
  lastPrice: number
  marketState?: string
  updatedAt: string
  source: LongbridgeRealtimeSource
}

export type LongbridgeRealtimeSnapshot = {
  symbol: string
  ticker: string
  quote?: LongbridgeQuoteCache
  bars: Partial<Record<LongbridgeBarPeriod, RealtimeBar[]>>
  tickerPoints: RealtimePoint[]
  asks: RealtimeOrderBookLevel[]
  bids: RealtimeOrderBookLevel[]
  updatedAt?: string
  subscribedAt?: string
  lastError?: string
}

export type LongbridgeRealtimeStatus = {
  state: LongbridgeSubscriptionState
  subscribedSymbols: string[]
  lastStartedAt?: string
  lastUpdatedAt?: string
  lastError?: string
  sdkAvailable: boolean
}

const MAX_BARS_PER_PERIOD = 1_200
const MAX_TICKER_POINTS = 500
const snapshots = new Map<string, LongbridgeRealtimeSnapshot>()
let status: LongbridgeRealtimeStatus = {
  state: 'idle',
  subscribedSymbols: [],
  sdkAvailable: false,
}

export const longbridgeRealtimeStore = {
  markStarting(symbols: string[]) {
    status = {
      ...status,
      state: 'starting',
      subscribedSymbols: normalizeSymbols(symbols),
      lastStartedAt: new Date().toISOString(),
      lastError: undefined,
    }
  },

  markSubscribed(symbols: string[], sdkAvailable = true) {
    const now = new Date().toISOString()
    const normalized = normalizeSymbols(symbols)
    for (const symbol of normalized) ensureSnapshot(symbol).subscribedAt = now
    status = {
      ...status,
      state: 'subscribed',
      subscribedSymbols: normalized,
      sdkAvailable,
      lastUpdatedAt: now,
      lastError: undefined,
    }
  },

  markDegraded(reason: string, symbols: string[] = status.subscribedSymbols) {
    status = {
      ...status,
      state: 'degraded',
      subscribedSymbols: normalizeSymbols(symbols),
      sdkAvailable: false,
      lastUpdatedAt: new Date().toISOString(),
      lastError: reason,
    }
  },

  markError(reason: string, symbols: string[] = status.subscribedSymbols) {
    status = {
      ...status,
      state: 'error',
      subscribedSymbols: normalizeSymbols(symbols),
      sdkAvailable: false,
      lastUpdatedAt: new Date().toISOString(),
      lastError: reason,
    }
  },

  upsertQuote(input: {
    symbol: string
    lastPrice: number
    marketState?: string
    updatedAt?: string
    source?: LongbridgeRealtimeSource
  }) {
    if (!Number.isFinite(input.lastPrice) || input.lastPrice <= 0) return
    const symbol = normalizeLongbridgeSymbol(input.symbol)
    const now = input.updatedAt ?? new Date().toISOString()
    const snapshot = ensureSnapshot(symbol)
    snapshot.quote = {
      symbol,
      ticker: tickerFromSymbol(symbol),
      lastPrice: input.lastPrice,
      marketState: input.marketState,
      updatedAt: now,
      source: input.source ?? 'longbridge-sdk-cache',
    }
    snapshot.updatedAt = now
    status = { ...status, lastUpdatedAt: now }
  },

  upsertBars(symbolInput: string, period: LongbridgeBarPeriod, bars: RealtimeBar[]) {
    const normalized = normalizeBars(bars)
    if (!normalized.length) return
    const symbol = normalizeLongbridgeSymbol(symbolInput)
    const snapshot = ensureSnapshot(symbol)
    const merged = mergeBars(snapshot.bars[period] ?? [], normalized)
    snapshot.bars[period] = merged.slice(-MAX_BARS_PER_PERIOD)
    snapshot.updatedAt = new Date().toISOString()
    status = { ...status, lastUpdatedAt: snapshot.updatedAt }
  },

  upsertDepth(symbolInput: string, input: { asks: RealtimeOrderBookLevel[]; bids: RealtimeOrderBookLevel[] }) {
    const symbol = normalizeLongbridgeSymbol(symbolInput)
    const snapshot = ensureSnapshot(symbol)
    snapshot.asks = input.asks
    snapshot.bids = input.bids
    snapshot.updatedAt = new Date().toISOString()
    status = { ...status, lastUpdatedAt: snapshot.updatedAt }
  },

  appendTrades(symbolInput: string, points: RealtimePoint[]) {
    const normalized = normalizePoints(points)
    if (!normalized.length) return
    const symbol = normalizeLongbridgeSymbol(symbolInput)
    const snapshot = ensureSnapshot(symbol)
    snapshot.tickerPoints = [...snapshot.tickerPoints, ...normalized]
      .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
      .slice(-MAX_TICKER_POINTS)
    snapshot.updatedAt = new Date().toISOString()
    status = { ...status, lastUpdatedAt: snapshot.updatedAt }
  },

  getSnapshot(symbolInput: string): LongbridgeRealtimeSnapshot | undefined {
    const snapshot = snapshots.get(normalizeLongbridgeSymbol(symbolInput))
    return snapshot ? cloneSnapshot(snapshot) : undefined
  },

  getStatus(): LongbridgeRealtimeStatus {
    return { ...status, subscribedSymbols: [...status.subscribedSymbols] }
  },

  clearForTests() {
    snapshots.clear()
    status = { state: 'idle', subscribedSymbols: [], sdkAvailable: false }
  },
}

function ensureSnapshot(symbolInput: string): LongbridgeRealtimeSnapshot {
  const symbol = normalizeLongbridgeSymbol(symbolInput)
  const existing = snapshots.get(symbol)
  if (existing) return existing
  const created: LongbridgeRealtimeSnapshot = {
    symbol,
    ticker: tickerFromSymbol(symbol),
    bars: {},
    tickerPoints: [],
    asks: [],
    bids: [],
  }
  snapshots.set(symbol, created)
  return created
}

function normalizeSymbols(symbols: string[]) {
  return [...new Set(symbols.map(normalizeLongbridgeSymbol))]
}

function tickerFromSymbol(symbol: string): string {
  const [code, market] = symbol.toUpperCase().split('.')
  if (market === 'HK' && /^\d+$/.test(code)) return code.padStart(5, '0')
  return code
}

function normalizeBars(bars: RealtimeBar[]) {
  return bars
    .filter((bar) => Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close))
    .map((bar) => ({ ...bar, time: new Date(bar.time).toISOString() }))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
}

function mergeBars(existing: RealtimeBar[], incoming: RealtimeBar[]) {
  const byTime = new Map<string, RealtimeBar>()
  for (const bar of existing) byTime.set(bar.time, bar)
  for (const bar of incoming) byTime.set(bar.time, bar)
  return [...byTime.values()].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
}

function normalizePoints(points: RealtimePoint[]) {
  return points
    .filter((point) => Number.isFinite(point.price))
    .map((point) => ({ ...point, time: new Date(point.time).toISOString() }))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
}

function cloneSnapshot(snapshot: LongbridgeRealtimeSnapshot): LongbridgeRealtimeSnapshot {
  return {
    ...snapshot,
    quote: snapshot.quote ? { ...snapshot.quote } : undefined,
    bars: Object.fromEntries(Object.entries(snapshot.bars).map(([period, bars]) => [period, [...(bars ?? [])]])),
    tickerPoints: [...snapshot.tickerPoints],
    asks: [...snapshot.asks],
    bids: [...snapshot.bids],
  }
}
