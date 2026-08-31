export type RealtimePoint = {
  time: string
  price: number
}

export type RealtimeBar = {
  time: string
  open: number
  high: number
  low: number
  close: number
}

export type OrderBookLevel = {
  price: string
  size: string
  depth: number
}

export type RealtimeStockMock = {
  ticker: string
  companyName: string
  price: string
  change: string
  changePercent: string
  open: string
  high: string
  low: string
  volume: string
  quoteUpdatedAt: string
  intradayUpdatedAt: string
  klineUpdatedAt: string
  orderBookUpdatedAt: string
  intradayPoints: RealtimePoint[]
  klineBars: RealtimeBar[]
  asks: OrderBookLevel[]
  bids: OrderBookLevel[]
}

const companyNames: Record<string, string> = {
  AAPL: 'Apple',
  AMZN: 'Amazon',
  GOOG: 'Alphabet',
  META: 'Meta Platforms',
  MSFT: 'Microsoft',
  MU: 'Micron Technology',
  NVDA: 'NVIDIA',
  TSLA: 'Tesla',
  TSM: 'TSMC',
}

export function getRealtimeStockMock(tickerInput: string | undefined): RealtimeStockMock {
  const ticker = (tickerInput || 'GOOG').toUpperCase()
  const seed = [...ticker].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const base = 80 + (seed % 180)
  const down = seed % 2 === 0
  const change = Number(((seed % 45) / 10 + 0.18).toFixed(2)) * (down ? -1 : 1)
  const price = base + change
  const points = buildIntradayPoints(base, seed, down)
  const bars = buildKlineBars(base, seed)

  return {
    ticker,
    companyName: companyNames[ticker] ?? ticker,
    price: formatMoney(price),
    change: formatSignedMoney(change),
    changePercent: `${change >= 0 ? '+' : ''}${((change / base) * 100).toFixed(2)}%`,
    open: formatMoney(base - change * 0.4),
    high: formatMoney(Math.max(...points.map((point) => point.price)) + 0.45),
    low: formatMoney(Math.min(...points.map((point) => point.price)) - 0.35),
    volume: `${(12 + (seed % 80)).toLocaleString('en-US')}万`,
    quoteUpdatedAt: '视觉稿 09:45:18',
    intradayUpdatedAt: '视觉稿 09:45:18',
    klineUpdatedAt: '视觉稿 09:45',
    orderBookUpdatedAt: '视觉稿 09:45:18',
    intradayPoints: points,
    klineBars: bars,
    asks: buildBook(price, 1),
    bids: buildBook(price, -1),
  }
}

function buildIntradayPoints(base: number, seed: number, down: boolean): RealtimePoint[] {
  return Array.from({ length: 28 }, (_, index) => {
    const drift = (index / 27) * (down ? -1.8 : 1.8)
    const wave = Math.sin(index / 2.2 + seed) * 0.85
    return {
      time: `${9 + Math.floor(index / 6)}:${String((index % 6) * 10).padStart(2, '0')}`,
      price: Number((base + drift + wave).toFixed(2)),
    }
  })
}

function buildKlineBars(base: number, seed: number): RealtimeBar[] {
  return Array.from({ length: 18 }, (_, index) => {
    const open = base + Math.sin(index + seed) * 4 + index * 0.12
    const close = open + Math.cos(index * 1.3 + seed) * 2
    return {
      time: `T-${18 - index}`,
      open: Number(open.toFixed(2)),
      high: Number((Math.max(open, close) + 1.4).toFixed(2)),
      low: Number((Math.min(open, close) - 1.2).toFixed(2)),
      close: Number(close.toFixed(2)),
    }
  })
}

function buildBook(price: number, direction: 1 | -1): OrderBookLevel[] {
  return Array.from({ length: 5 }, (_, index) => ({
    price: formatMoney(price + direction * (index + 1) * 0.08),
    size: `${(index + 2) * 100}`,
    depth: 94 - index * 14,
  }))
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`
}
