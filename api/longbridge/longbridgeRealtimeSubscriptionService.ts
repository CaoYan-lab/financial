import { AdjustType, Period, SubType, TradeSessions } from 'longbridge'
import type { RealtimeBar, RealtimeOrderBookLevel, RealtimePoint } from '../../shared/types.js'
import { latestQuotePrice, loadLongbridgeStrategyMarketData, normalizeLongbridgeSymbol } from './longbridgeMarketDataService.js'
import { longbridgeRealtimeStore, type LongbridgeBarPeriod } from './longbridgeRealtimeStore.js'
import { getLongbridgeSdkContexts } from './longbridgeSdkGateway.js'
import { logger } from '../utils/logger.js'

type QuoteContextLike = ReturnType<typeof getLongbridgeSdkContexts>['quote']

const SDK_ENV_KEYS = ['LONGBRIDGE_APP_KEY', 'LONGBRIDGE_APP_SECRET', 'LONGBRIDGE_ACCESS_TOKEN']
const DEFAULT_BACKFILL_CONCURRENCY = Math.max(1, Number(process.env.LONGBRIDGE_REALTIME_BACKFILL_CONCURRENCY || 2) || 2)
const DEFAULT_SEED_WAIT_MS = Math.max(0, Number(process.env.LONGBRIDGE_REALTIME_SEED_WAIT_MS || 2_000) || 2_000)
const DEFAULT_REQUIRED_KLINE_COUNT = Math.max(1, Number(process.env.LONGBRIDGE_REALTIME_REQUIRED_KLINE_COUNT || 120) || 120)
const DEFAULT_HISTORICAL_SEED_TTL_MS = Math.max(60_000, Number(process.env.LONGBRIDGE_REALTIME_HISTORICAL_SEED_TTL_MS || 10 * 60_000) || 10 * 60_000)
const DEFAULT_SUBSCRIPTION_PERIODS: LongbridgeBarPeriod[] = ['1m', '30m']

class LongbridgeRealtimeSubscriptionService {
  private ctx?: QuoteContextLike
  private subscribedSymbols = new Set<string>()
  private subscribedCandlesticks = new Set<string>()
  private historicalSeededAt = new Map<string, number>()
  private initializing?: Promise<void>

  async ensureSubscribed(symbolInputs: string[], options: { waitForSeed?: boolean; requiredKlineCount?: number } = {}): Promise<void> {
    const symbols = normalizeSymbols(symbolInputs)
    if (!symbols.length) return
    longbridgeRealtimeStore.markStarting(symbols)

    const missingEnv = SDK_ENV_KEYS.filter((key) => !process.env[key])
    if (missingEnv.length) {
      longbridgeRealtimeStore.markDegraded(`Longbridge SDK 订阅缺少环境变量：${missingEnv.join(', ')}。已降级为 CLI 补拉模式。`, symbols)
      return
    }

    try {
      await this.ensureContext()
      if (!this.ctx) throw new Error('Longbridge SDK QuoteContext 初始化失败。')
      const newSymbols = symbols.filter((symbol) => !this.subscribedSymbols.has(symbol))
      if (newSymbols.length) {
        await this.ctx.subscribe(newSymbols, [SubType.Quote, SubType.Depth, SubType.Trade])
        for (const symbol of newSymbols) this.subscribedSymbols.add(symbol)
      }
      await this.ensureCandlesticks(symbols, DEFAULT_SUBSCRIPTION_PERIODS)
      longbridgeRealtimeStore.markSubscribed([...this.subscribedSymbols])
      if (options.waitForSeed) {
        await this.seedSnapshots(symbols)
        await this.ensureHistoricalSeed(symbols, options.requiredKlineCount ?? DEFAULT_REQUIRED_KLINE_COUNT)
      }
      if (options.waitForSeed && DEFAULT_SEED_WAIT_MS > 0) await sleep(DEFAULT_SEED_WAIT_MS)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Longbridge SDK 订阅启动失败。'
      longbridgeRealtimeStore.markDegraded(`${message} 已降级为 CLI 补拉模式。`, symbols)
    }
  }

  getStatus() {
    return longbridgeRealtimeStore.getStatus()
  }

  resetForTests() {
    this.ctx = undefined
    this.subscribedSymbols.clear()
    this.subscribedCandlesticks.clear()
    this.historicalSeededAt.clear()
    this.initializing = undefined
    longbridgeRealtimeStore.clearForTests()
  }

  private async ensureContext() {
    if (this.ctx) return
    if (this.initializing) return this.initializing
    this.initializing = Promise.resolve().then(() => {
      const ctx = getLongbridgeSdkContexts().quote
      ctx.setOnQuote((err, event) => {
        if (err) {
          longbridgeRealtimeStore.markError(`Longbridge quote push 错误：${err.message}`)
          return
        }
        longbridgeRealtimeStore.upsertQuote(normalizeQuoteEvent(event))
      })
      ctx.setOnDepth((err, event) => {
        if (err) {
          longbridgeRealtimeStore.markError(`Longbridge depth push 错误：${err.message}`)
          return
        }
        const normalized = normalizeDepthEvent(event)
        longbridgeRealtimeStore.upsertDepth(normalized.symbol, normalized)
      })
      ctx.setOnTrades((err, event) => {
        if (err) {
          longbridgeRealtimeStore.markError(`Longbridge trades push 错误：${err.message}`)
          return
        }
        const normalized = normalizeTradesEvent(event)
        longbridgeRealtimeStore.appendTrades(normalized.symbol, normalized.points)
      })
      ctx.setOnCandlestick((err, event) => {
        if (err) {
          longbridgeRealtimeStore.markError(`Longbridge candlestick push 错误：${err.message}`)
          return
        }
        const normalized = normalizeCandlestickEvent(event)
        if (normalized) longbridgeRealtimeStore.upsertBars(normalized.symbol, normalized.period, [normalized.bar])
      })
      this.ctx = ctx
    }).finally(() => {
      this.initializing = undefined
    })
    return this.initializing
  }

  private async ensureCandlesticks(symbols: string[], periods: LongbridgeBarPeriod[]) {
    if (!this.ctx) return
    for (const symbol of symbols) {
      for (const period of periods) {
        const key = `${symbol}:${period}`
        if (this.subscribedCandlesticks.has(key)) continue
        const initial = await this.ctx.subscribeCandlesticks(symbol, sdkPeriod(period), TradeSessions.All)
        longbridgeRealtimeStore.upsertBars(symbol, period, normalizeCandlesticks(initial))
        this.subscribedCandlesticks.add(key)
      }
    }
  }

  private async seedSnapshots(symbols: string[]) {
    if (!this.ctx) return
    await mapLimit(symbols, DEFAULT_BACKFILL_CONCURRENCY, async (symbol) => {
      await Promise.allSettled([
        this.ctx?.realtimeQuote([symbol]).then((quotes) => {
          for (const quote of quotes ?? []) longbridgeRealtimeStore.upsertQuote(normalizeRealtimeQuote(quote))
        }),
        this.ctx?.realtimeDepth(symbol).then((depth) => longbridgeRealtimeStore.upsertDepth(symbol, normalizeDepth(depth))),
        this.ctx?.realtimeTrades(symbol, 120).then((trades) => longbridgeRealtimeStore.appendTrades(symbol, normalizeTrades(trades))),
        this.ctx?.realtimeCandlesticks(symbol, Period.Min_1, 180).then((bars) => longbridgeRealtimeStore.upsertBars(symbol, '1m', normalizeCandlesticks(bars))),
        this.ctx?.realtimeCandlesticks(symbol, Period.Min_30, 120).then((bars) => longbridgeRealtimeStore.upsertBars(symbol, '30m', normalizeCandlesticks(bars))),
      ])
    })
  }

  private async ensureHistoricalSeed(symbols: string[], requiredKlineCount: number) {
    const now = Date.now()
    await mapLimit(symbols, DEFAULT_BACKFILL_CONCURRENCY, async (symbol) => {
      const snapshot = longbridgeRealtimeStore.getSnapshot(symbol)
      const existingBars = snapshot?.bars['1m']?.length ?? 0
      const lastSeededAt = this.historicalSeededAt.get(symbol) ?? 0
      if (existingBars >= requiredKlineCount && now - lastSeededAt < DEFAULT_HISTORICAL_SEED_TTL_MS) return

      logger.info(
        { event: 'longbridge.realtime.seed.backfill_started', symbol, existingBars, requiredKlineCount, lastSeededAt: lastSeededAt ? new Date(lastSeededAt).toISOString() : undefined },
        'Longbridge realtime seed K-line backfill started',
      )
      try {
        if (!this.ctx) throw new Error('Longbridge SDK QuoteContext 不可用。')
        const bars = await fetchLongbridgeHistoricalSeed(this.ctx, symbol, requiredKlineCount)
        longbridgeRealtimeStore.upsertBars(symbol, '1m', bars)
        const updatedBars = longbridgeRealtimeStore.getSnapshot(symbol)?.bars['1m']?.length ?? 0
        if (updatedBars >= requiredKlineCount) {
          this.historicalSeededAt.set(symbol, Date.now())
          logger.info(
            { event: 'longbridge.realtime.seed.backfill_completed', symbol, existingBars, updatedBars, requiredKlineCount, source: 'sdk' },
            'Longbridge realtime seed K-line backfill completed',
          )
          return
        }
        logger.warn(
          { event: 'longbridge.realtime.seed.sdk_insufficient', symbol, existingBars, updatedBars, requiredKlineCount },
          'Longbridge SDK historical seed returned insufficient K-line bars',
        )
      } catch (error) {
        logger.warn(
          { event: 'longbridge.realtime.seed.sdk_failed', symbol, existingBars, requiredKlineCount, error: error instanceof Error ? error.message : String(error) },
          'Longbridge SDK historical seed failed',
        )
      }

      if (process.env.CLOUD_MODE === '1') return
      const marketData = await loadLongbridgeStrategyMarketData(symbol, {
        klineCount: requiredKlineCount,
        includeDepth: false,
        includeTrades: false,
      })
      if (!marketData.ok) {
        const reason = 'reason' in marketData ? marketData.reason : 'Longbridge historical seed market data unavailable'
        logger.warn(
          { event: 'longbridge.realtime.seed.backfill_failed', symbol, existingBars, requiredKlineCount, reason, warnings: marketData.warnings },
          'Longbridge realtime seed K-line backfill failed',
        )
        return
      }

      longbridgeRealtimeStore.upsertQuote({
        symbol,
        lastPrice: marketData.lastPrice,
        marketState: marketData.marketState,
        updatedAt: marketData.updatedAt,
        source: 'longbridge-cli',
      })
      longbridgeRealtimeStore.upsertBars(symbol, '1m', marketData.bars)
      this.historicalSeededAt.set(symbol, Date.now())
      const updatedBars = longbridgeRealtimeStore.getSnapshot(symbol)?.bars['1m']?.length ?? 0
      logger.info(
        { event: 'longbridge.realtime.seed.backfill_completed', symbol, existingBars, updatedBars, requiredKlineCount, warnings: marketData.warnings },
        'Longbridge realtime seed K-line backfill completed',
      )
    })
  }
}

export const longbridgeRealtimeSubscriptionService = new LongbridgeRealtimeSubscriptionService()

export async function fetchLongbridgeHistoricalSeed(
  context: Pick<QuoteContextLike, 'candlesticks'>,
  symbol: string,
  requiredKlineCount: number,
): Promise<RealtimeBar[]> {
  const requestedCount = Math.min(1_000, Math.max(requiredKlineCount * 3, requiredKlineCount + 120))
  return normalizeCandlesticks(await context.candlesticks(
    symbol,
    Period.Min_1,
    requestedCount,
    AdjustType.NoAdjust,
    TradeSessions.All,
  ))
}

function normalizeSymbols(symbols: string[]) {
  return [...new Set(symbols.map(normalizeLongbridgeSymbol))]
}

function normalizeQuoteEvent(event: any) {
  const data = event.data
  const symbol = normalizeLongbridgeSymbol(event.symbol)
  return {
    symbol,
    lastPrice: latestQuotePrice(data ?? {}, symbol) ?? decimalNumber(data.lastDone),
    marketState: enumLabel(data.tradeStatus),
    updatedAt: dateIso(data.timestamp),
    source: 'longbridge-sdk-cache' as const,
  }
}

function normalizeRealtimeQuote(quote: any) {
  const symbol = normalizeLongbridgeSymbol(quote.symbol)
  return {
    symbol,
    lastPrice: latestQuotePrice(quote ?? {}, symbol) ?? decimalNumber(quote.lastDone),
    marketState: enumLabel(quote.tradeStatus),
    updatedAt: dateIso(quote.timestamp),
    source: 'longbridge-sdk-cache' as const,
  }
}

function normalizeDepthEvent(event: any) {
  return {
    symbol: normalizeLongbridgeSymbol(event.symbol),
    ...normalizeDepth(event.data),
  }
}

function normalizeDepth(depth: any): { asks: RealtimeOrderBookLevel[]; bids: RealtimeOrderBookLevel[] } {
  return {
    asks: normalizeLevels(depth?.asks),
    bids: normalizeLevels(depth?.bids),
  }
}

function normalizeLevels(levels: any): RealtimeOrderBookLevel[] {
  return Array.isArray(levels)
    ? levels.map((level, index) => ({
      price: formatPrice(decimalNumber(level.price)),
      size: String(level.volume ?? ''),
      depth: Number(level.position) || index + 1,
    })).filter((level) => level.price !== 'unavailable')
    : []
}

function normalizeTradesEvent(event: any) {
  return {
    symbol: normalizeLongbridgeSymbol(event.symbol),
    points: normalizeTrades(event.data?.trades),
  }
}

function normalizeTrades(trades: any): RealtimePoint[] {
  return Array.isArray(trades)
    ? trades.map((trade) => ({
      time: dateIso(trade.timestamp),
      price: decimalNumber(trade.price),
    })).filter((point) => Number.isFinite(point.price))
    : []
}

function normalizeCandlestickEvent(event: any): { symbol: string; period: LongbridgeBarPeriod; bar: RealtimeBar } | undefined {
  const data = event.data
  const bar = normalizeCandlesticks([data?.candlestick])[0]
  if (!bar) return undefined
  return {
    symbol: normalizeLongbridgeSymbol(event.symbol),
    period: storePeriod(data.period),
    bar,
  }
}

function normalizeCandlesticks(candlesticks: any): RealtimeBar[] {
  return Array.isArray(candlesticks)
    ? candlesticks.map((bar) => {
      const close = decimalNumber(bar.close)
      const open = decimalNumber(bar.open)
      const high = decimalNumber(bar.high)
      const low = decimalNumber(bar.low)
      if (![open, high, low, close].every(Number.isFinite)) return undefined
      return {
        time: dateIso(bar.timestamp),
        open,
        high,
        low,
        close,
      }
    }).filter((bar): bar is RealtimeBar => Boolean(bar))
    : []
}

function sdkPeriod(period: LongbridgeBarPeriod): Period {
  if (period === '15m') return Period.Min_15
  if (period === '30m') return Period.Min_30
  if (period === '1d') return Period.Day
  return Period.Min_1
}

function storePeriod(period: Period): LongbridgeBarPeriod {
  if (period === Period.Min_15) return '15m'
  if (period === Period.Min_30) return '30m'
  if (period === Period.Day) return '1d'
  return '1m'
}

function decimalNumber(value: any): number {
  if (value && typeof value.toNumber === 'function') return value.toNumber()
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[$,%\s,]/g, ''))
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

function dateIso(value: any): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

function enumLabel(value: any): string | undefined {
  if (value === undefined || value === null) return undefined
  return String(value)
}

function formatPrice(value: number) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : 'unavailable'
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const workerCount = Math.max(1, Math.min(limit, items.length || 1))
  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index
      index += 1
      results[currentIndex] = await worker(items[currentIndex])
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return results
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
