import { Activity, BarChart3, BookOpen, Radio } from 'lucide-react'
import Badge from '@/components/common/Badge'
import type { UiLanguage } from '@/stores/uiStore'
import type { RealtimeStockMock } from '@/mocks/realtimeStockMock'
import type { RealtimeCallbackKind, RealtimeStockResponse } from '../../../shared/types'

export default function RealtimeStatusPanel({ stock, language, realtime }: { stock: RealtimeStockMock; language: UiLanguage; realtime?: RealtimeStockResponse }) {
  const items = [
    { icon: Radio, kind: 'quote' as const, zh: '实时报价回调', en: 'Realtime Quote', time: stock.quoteUpdatedAt },
    { icon: Activity, kind: 'ticker' as const, zh: '实时分时回调', en: 'Realtime Ticker', time: stock.intradayUpdatedAt },
    { icon: BarChart3, kind: 'kline' as const, zh: '实时 K 线回调', en: 'Realtime K-line', time: stock.klineUpdatedAt },
    { icon: BookOpen, kind: 'orderBook' as const, zh: '实时摆盘回调', en: 'Realtime Order Book', time: stock.orderBookUpdatedAt },
  ]

  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '回调状态' : 'Callback Status'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '实时数据缓存状态' : 'Realtime Cache Status'}</h2>
        </div>
        <Badge tone={realtime?.source === 'futu-callback' ? 'emerald' : 'amber'}>
          {realtime?.source === 'futu-callback' ? (language === 'zh' ? '真实回调' : 'Live Callback') : language === 'zh' ? 'Mock 兜底' : 'Mock Fallback'}
        </Badge>
      </div>
      <div className="mt-5 grid gap-3">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <div key={item.zh} className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="rounded-2xl bg-amber-50 p-2 text-amber-700">
                    <Icon size={18} />
                  </span>
                  <div>
                    <p className="font-semibold text-stone-950">{language === 'zh' ? item.zh : item.en}</p>
                    <p className="mt-1 text-xs text-stone-500">{statusLine(realtime, item.kind, language)}</p>
                  </div>
                </div>
                <span className="font-mono text-xs font-semibold text-stone-600">{item.time}</span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function statusLine(realtime: RealtimeStockResponse | undefined, kind: RealtimeCallbackKind, language: UiLanguage): string {
  const status = realtime?.callbackStatus[kind]
  if (status?.count) {
    return language === 'zh' ? `已覆盖刷新 ${status.count} 次` : `Overwritten ${status.count} times`
  }
  return language === 'zh' ? '等待 Futu 回调，当前使用视觉兜底' : 'Waiting for Futu callback; visual fallback is active'
}
