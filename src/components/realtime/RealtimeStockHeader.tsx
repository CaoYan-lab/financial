import { ArrowLeft, BadgeCheck, Eye, RotateCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import Badge from '@/components/common/Badge'
import ProfitValue from '@/components/common/ProfitValue'
import type { UiLanguage } from '@/stores/uiStore'
import type { RealtimeStockMock } from '@/mocks/realtimeStockMock'
import type { RealtimeStockResponse } from '../../../shared/types'

export default function RealtimeStockHeader({
  stock,
  language,
  realtime,
  loading,
  error,
  onRefresh,
  onSubscribe,
}: {
  stock: RealtimeStockMock
  language: UiLanguage
  realtime?: RealtimeStockResponse
  loading: boolean
  error?: string
  onRefresh: () => void
  onSubscribe: () => void
}) {
  const hasRealtime = realtime?.source === 'futu-callback'

  return (
    <section className="rounded-[2rem] border border-amber-100 bg-white/90 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={hasRealtime ? 'emerald' : 'amber'}>{hasRealtime ? (language === 'zh' ? 'Futu 实时回调' : 'Futu Realtime') : language === 'zh' ? '等待回调 / Mock 兜底' : 'Waiting / Mock Fallback'}</Badge>
            <Badge tone={realtime?.subscribed ? 'cyan' : 'slate'}>{realtime?.subscribed ? (language === 'zh' ? '已订阅 Top30' : 'Top30 Subscribed') : language === 'zh' ? '待订阅' : 'Not Subscribed'}</Badge>
          </div>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-stone-950">
            {stock.ticker} · {stock.companyName}
          </h1>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <span className="font-mono text-4xl font-bold text-stone-950">{stock.price}</span>
            <ProfitValue value={stock.change} language={language} />
            <ProfitValue value={stock.changePercent} language={language} />
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-600">
            {language === 'zh'
              ? '本页优先展示 Futu 实时报价、分时、K 线和摆盘回调；回调未到达时保留视觉兜底，避免空屏。'
              : 'This page prioritizes Futu quote, ticker, K-line and order-book callbacks; mock visuals remain only as fallback before callbacks arrive.'}
          </p>
          {error ? <p className="mt-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p> : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Link className="inline-flex items-center rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50" to="/futu">
            <ArrowLeft className="mr-2" size={16} />
            {language === 'zh' ? '返回工作台' : 'Workbench'}
          </Link>
          <Link className="inline-flex items-center rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50" to="/reports">
            <Eye className="mr-2" size={16} />
            {language === 'zh' ? '返回报告' : 'Report'}
          </Link>
          <button className="inline-flex items-center rounded-2xl border border-amber-200 bg-white px-4 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-50" onClick={onSubscribe} disabled={loading}>
            <RadioIcon />
            {loading ? (language === 'zh' ? '订阅中' : 'Subscribing') : language === 'zh' ? '订阅 Top30' : 'Subscribe Top30'}
          </button>
          <button className="inline-flex items-center rounded-2xl bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 shadow-sm hover:bg-amber-500" onClick={onRefresh}>
            <RotateCw className="mr-2" size={16} />
            {language === 'zh' ? '刷新实时缓存' : 'Refresh Cache'}
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-4">
        {[
          [language === 'zh' ? '实时报价回调' : 'Quote Callback', stock.quoteUpdatedAt],
          [language === 'zh' ? '实时分时回调' : 'Ticker Callback', stock.intradayUpdatedAt],
          [language === 'zh' ? '实时 K 线回调' : 'K-line Callback', stock.klineUpdatedAt],
          [language === 'zh' ? '实时摆盘回调' : 'Order Book Callback', stock.orderBookUpdatedAt],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-stone-500">
              <BadgeCheck size={14} className="text-amber-600" />
              {label}
            </p>
            <p className="mt-2 font-mono text-sm font-semibold text-stone-950">{value}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function RadioIcon() {
  return <span className="mr-2 h-2.5 w-2.5 rounded-full bg-amber-500 shadow-sm shadow-amber-500/40" />
}
