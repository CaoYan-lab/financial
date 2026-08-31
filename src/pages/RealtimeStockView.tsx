import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import IntradayChartMock from '@/components/realtime/IntradayChartMock'
import OrderBookPanel from '@/components/realtime/OrderBookPanel'
import RealtimeKlineMock from '@/components/realtime/RealtimeKlineMock'
import RealtimeQuoteCards from '@/components/realtime/RealtimeQuoteCards'
import RealtimeStatusPanel from '@/components/realtime/RealtimeStatusPanel'
import RealtimeStockHeader from '@/components/realtime/RealtimeStockHeader'
import StockReportContextPanel from '@/components/realtime/StockReportContextPanel'
import { useRealtimeStock } from '@/hooks/useRealtimeStock'
import { getRealtimeStockMock, type RealtimeStockMock } from '@/mocks/realtimeStockMock'
import { useReportStore } from '@/stores/reportStore'
import { useUiStore } from '@/stores/uiStore'
import type { RealtimeStockResponse } from '../../shared/types'

export default function RealtimeStockView() {
  const { ticker } = useParams()
  const language = useUiStore((state) => state.language)
  const report = useReportStore((state) => state.report)
  const [activeChart, setActiveChart] = useState<'intraday' | 'kline'>('intraday')
  const fallbackStock = useMemo(() => getRealtimeStockMock(ticker), [ticker])
  const realtime = useRealtimeStock(fallbackStock.ticker)
  const stock = useMemo(() => mergeRealtimeStock(fallbackStock, realtime.data), [fallbackStock, realtime.data])
  const analysis = report?.analysis.companyAnalyses.find((item) => item.ticker === stock.ticker)
  const isRealtime = realtime.data?.source === 'futu-callback'

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <RealtimeStockHeader
          stock={stock}
          language={language}
          realtime={realtime.data}
          loading={realtime.loading}
          error={realtime.error}
          onRefresh={realtime.refresh}
          onSubscribe={realtime.subscribeTop30}
        />
        <RealtimeQuoteCards stock={stock} language={language} isRealtime={isRealtime} />

        <section className="rounded-[2rem] border border-stone-200 bg-white/70 p-3 shadow-sm">
          <div className="mb-3 flex gap-2">
            <button
              className={`rounded-2xl px-4 py-2 text-sm font-semibold ${activeChart === 'intraday' ? 'bg-white text-stone-950' : 'bg-white text-stone-600 hover:bg-stone-50'}`}
              onClick={() => setActiveChart('intraday')}
            >
              {language === 'zh' ? '分时' : 'Intraday'}
            </button>
            <button
              className={`rounded-2xl px-4 py-2 text-sm font-semibold ${activeChart === 'kline' ? 'bg-white text-stone-950' : 'bg-white text-stone-600 hover:bg-stone-50'}`}
              onClick={() => setActiveChart('kline')}
            >
              {language === 'zh' ? 'K 线' : 'K-line'}
            </button>
          </div>
          {activeChart === 'intraday' ? (
            <IntradayChartMock points={stock.intradayPoints} language={language} isRealtime={isRealtime && Boolean(realtime.data?.tickerPoints.length)} />
          ) : (
            <RealtimeKlineMock bars={stock.klineBars} language={language} isRealtime={isRealtime && Boolean(realtime.data?.klineBars.length)} />
          )}
        </section>

        <div className="grid gap-6 xl:grid-cols-[1fr_1.15fr]">
          <OrderBookPanel asks={stock.asks} bids={stock.bids} language={language} isRealtime={isRealtime && Boolean(realtime.data?.asks.length || realtime.data?.bids.length)} />
          <RealtimeStatusPanel stock={stock} language={language} realtime={realtime.data} />
        </div>

        <StockReportContextPanel analysis={analysis} language={language} />
      </div>
    </main>
  )
}

function mergeRealtimeStock(fallback: RealtimeStockMock, realtime?: RealtimeStockResponse): RealtimeStockMock {
  if (!realtime || realtime.source !== 'futu-callback') return fallback

  return {
    ...fallback,
    companyName: realtime.quote?.name ?? fallback.companyName,
    price: realtime.quote?.price ?? fallback.price,
    change: realtime.quote?.change ?? fallback.change,
    changePercent: realtime.quote?.changePercent ?? fallback.changePercent,
    open: realtime.quote?.open ?? fallback.open,
    high: realtime.quote?.high ?? fallback.high,
    low: realtime.quote?.low ?? fallback.low,
    volume: realtime.quote?.volume ?? fallback.volume,
    quoteUpdatedAt: realtime.callbackStatus.quote.updatedAt || fallback.quoteUpdatedAt,
    intradayUpdatedAt: realtime.callbackStatus.ticker.updatedAt || fallback.intradayUpdatedAt,
    klineUpdatedAt: realtime.callbackStatus.kline.updatedAt || fallback.klineUpdatedAt,
    orderBookUpdatedAt: realtime.callbackStatus.orderBook.updatedAt || fallback.orderBookUpdatedAt,
    intradayPoints: realtime.tickerPoints.length ? realtime.tickerPoints : fallback.intradayPoints,
    klineBars: realtime.klineBars.length ? realtime.klineBars : fallback.klineBars,
    asks: realtime.asks.length ? realtime.asks : fallback.asks,
    bids: realtime.bids.length ? realtime.bids : fallback.bids,
  }
}
