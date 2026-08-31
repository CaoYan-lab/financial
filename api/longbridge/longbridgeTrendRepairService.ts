import type { LiveSignalHistoryItem, SimulationHistoryPage, TrendContextSummary } from '../../shared/types.js'
import { loadLongbridgeTrendContext, normalizeLongbridgeSymbol } from './longbridgeMarketDataService.js'

export async function repairUnavailableTrendSignals(page: SimulationHistoryPage<LiveSignalHistoryItem>): Promise<SimulationHistoryPage<LiveSignalHistoryItem>> {
  const items = await mapLimit(page.items, 2, repairSignalTrend)
  return { ...page, items }
}

async function repairSignalTrend(signal: LiveSignalHistoryItem): Promise<LiveSignalHistoryItem> {
  if (signal.trendContext?.available !== false) return signal
  const currentPrice = parseMoney(signal.price) ?? parseMoney(signal.limitPrice)
  if (!currentPrice) return signal
  const barInterval = normalizeTrendBarInterval(signal.trendContext.barInterval)
  if (!barInterval) return signal
  try {
    const trendContext = await loadLongbridgeTrendContext(normalizeLongbridgeSymbol(signal.ticker), {
      lookbackTradingDays: signal.trendContext.lookbackTradingDays,
      barInterval,
      currentPrice,
    })
    if (!trendContext.window.available) return signal
    return {
      ...signal,
      reason: repairedReason(signal, trendContext),
      dataWindow: repairDataWindow(signal.dataWindow, trendContext),
      trendContext: {
        available: true,
        lookbackTradingDays: trendContext.window.lookbackTradingDays,
        barInterval: trendContext.window.barInterval,
        trendDirection: trendContext.trendDirection,
        trendStrength: trendContext.trendStrength,
        pricePositionInRange: trendContext.pricePositionInRange,
        summary: trendContext.summary,
      },
      trendAlignment: trendContext.trendDirection === 'SIDEWAYS' ? 'NO_TREND' : 'WITH_TREND',
    }
  } catch {
    return signal
  }
}

function normalizeTrendBarInterval(value: unknown): '15m' | '30m' | '1d' | undefined {
  return value === '15m' || value === '30m' || value === '1d' ? value : undefined
}

function repairedReason(signal: LiveSignalHistoryItem, trendContext: TrendContextSummary): string {
  return `历史信号趋势上下文已用 Longbridge K 线补算：${trendContext.summary} 原始模型动作为 ${signal.side}，本条历史记录不重新触发下单。`
}

function repairDataWindow(dataWindow: string, trendContext: TrendContextSummary): string {
  const trendText = `趋势: ${trendContext.window.lookbackTradingDays}日 ${trendContext.window.barInterval} Longbridge K线 / ${trendContext.trendDirection} / ${trendContext.trendStrength}`
  if (!dataWindow) return trendText
  if (dataWindow.includes('；趋势:')) return dataWindow.replace(/；趋势:.+$/, `；${trendText}`)
  return `${dataWindow}；${trendText}`
}

function parseMoney(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Number(value.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex])
    }
  }))
  return results
}
