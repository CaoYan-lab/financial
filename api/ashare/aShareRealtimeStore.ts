import type { RealtimeBar, RealtimeCallbackKind, RealtimeCallbackStatus, RealtimeOrderBookLevel, RealtimePoint, RealtimeQuote } from '../../shared/types.js'

export type AShareRealtimeSnapshot = {
  ok: true
  ticker: string
  subscribed: boolean
  source: 'futu-callback' | 'empty'
  quote?: RealtimeQuote
  tickerPoints: RealtimePoint[]
  klineBars: RealtimeBar[]
  asks: RealtimeOrderBookLevel[]
  bids: RealtimeOrderBookLevel[]
  callbackStatus: RealtimeCallbackStatus
  updatedAt: string
}

type RealtimeEvent =
  | { kind: 'quote'; ticker: string; quote: RealtimeQuote; updatedAt: string }
  | { kind: 'ticker'; ticker: string; points: RealtimePoint[]; updatedAt: string }
  | { kind: 'kline'; ticker: string; bars: RealtimeBar[]; updatedAt: string }
  | { kind: 'orderBook'; ticker: string; asks: RealtimeOrderBookLevel[]; bids: RealtimeOrderBookLevel[]; updatedAt: string }

const callbackKinds: RealtimeCallbackKind[] = ['quote', 'ticker', 'kline', 'orderBook']
const MAX_TICKER_POINTS = 720
const MAX_KLINE_BARS = 240

class AShareRealtimeStore {
  private readonly quoteByTicker = new Map<string, RealtimeQuote>()
  private readonly tickerByTicker = new Map<string, RealtimePoint[]>()
  private readonly klineByTicker = new Map<string, RealtimeBar[]>()
  private readonly orderBookByTicker = new Map<string, { asks: RealtimeOrderBookLevel[]; bids: RealtimeOrderBookLevel[] }>()
  private readonly statusByTicker = new Map<string, RealtimeCallbackStatus>()
  private subscribedTickers: string[] = []

  setSubscribedTickers(tickers: string[]) {
    this.subscribedTickers = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))]
  }

  getSubscribedTickers(): string[] {
    return this.subscribedTickers
  }

  applyEvent(event: RealtimeEvent) {
    const ticker = event.ticker.toUpperCase()
    if (event.kind === 'quote') this.quoteByTicker.set(ticker, event.quote)
    if (event.kind === 'ticker') this.tickerByTicker.set(ticker, mergeTickerPoints(this.tickerByTicker.get(ticker) ?? [], event.points))
    if (event.kind === 'kline') this.klineByTicker.set(ticker, mergeKlineBars(this.klineByTicker.get(ticker) ?? [], event.bars))
    if (event.kind === 'orderBook') this.orderBookByTicker.set(ticker, { asks: event.asks, bids: event.bids })

    const status = this.statusByTicker.get(ticker) ?? emptyCallbackStatus()
    status[event.kind] = {
      updatedAt: event.updatedAt,
      count: status[event.kind].count + 1,
    }
    this.statusByTicker.set(ticker, status)
  }

  snapshot(tickerInput: string): AShareRealtimeSnapshot {
    const ticker = tickerInput.toUpperCase()
    const orderBook = this.orderBookByTicker.get(ticker)
    const quote = this.quoteByTicker.get(ticker)
    const tickerPoints = this.tickerByTicker.get(ticker) ?? []
    const klineBars = this.klineByTicker.get(ticker) ?? []
    const hasRealtime = Boolean(quote || tickerPoints.length || klineBars.length || orderBook)
    return {
      ok: true,
      ticker,
      subscribed: this.subscribedTickers.includes(ticker),
      source: hasRealtime ? 'futu-callback' : 'empty',
      quote,
      tickerPoints,
      klineBars,
      asks: orderBook?.asks ?? [],
      bids: orderBook?.bids ?? [],
      callbackStatus: this.statusByTicker.get(ticker) ?? emptyCallbackStatus(),
      updatedAt: latestUpdatedAt(this.statusByTicker.get(ticker)),
    }
  }

  eventCounts(): RealtimeCallbackStatus {
    const aggregate = emptyCallbackStatus()
    for (const status of this.statusByTicker.values()) {
      for (const kind of callbackKinds) {
        aggregate[kind].count += status[kind].count
        if (status[kind].updatedAt > aggregate[kind].updatedAt) aggregate[kind].updatedAt = status[kind].updatedAt
      }
    }
    return aggregate
  }
}

export const aShareRealtimeStore = new AShareRealtimeStore()

export function emptyCallbackStatus(): RealtimeCallbackStatus {
  return {
    quote: { updatedAt: '', count: 0 },
    ticker: { updatedAt: '', count: 0 },
    kline: { updatedAt: '', count: 0 },
    orderBook: { updatedAt: '', count: 0 },
  }
}

function latestUpdatedAt(status?: RealtimeCallbackStatus): string {
  if (!status) return ''
  return callbackKinds.map((kind) => status[kind].updatedAt).sort().at(-1) ?? ''
}

function mergeTickerPoints(existing: RealtimePoint[], incoming: RealtimePoint[]): RealtimePoint[] {
  const byKey = new Map(existing.map((point) => [`${point.time}:${point.price}`, point]))
  for (const point of incoming) byKey.set(`${point.time}:${point.price}`, point)
  return [...byKey.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-MAX_TICKER_POINTS)
}

function mergeKlineBars(existing: RealtimeBar[], incoming: RealtimeBar[]): RealtimeBar[] {
  const byTime = new Map<string, RealtimeBar>()
  for (const bar of existing) byTime.set(bar.time, bar)
  for (const bar of incoming) byTime.set(bar.time, bar)
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-MAX_KLINE_BARS)
}
