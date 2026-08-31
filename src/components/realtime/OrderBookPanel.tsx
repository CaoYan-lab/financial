import type { UiLanguage } from '@/stores/uiStore'
import type { OrderBookLevel } from '@/mocks/realtimeStockMock'

export default function OrderBookPanel({ asks, bids, language, isRealtime }: { asks: OrderBookLevel[]; bids: OrderBookLevel[]; language: UiLanguage; isRealtime: boolean }) {
  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '实时摆盘' : 'Order Book'}</p>
      <h2 className="mt-2 text-2xl font-semibold text-stone-950">
        {isRealtime ? (language === 'zh' ? '实时五档买卖盘' : 'Realtime Level 2') : language === 'zh' ? '五档买卖盘占位' : 'Level 2 Fallback'}
      </h2>
      <div className="mt-5 overflow-hidden rounded-2xl border border-stone-200">
        <BookSide levels={[...asks].reverse()} side="ask" label={language === 'zh' ? '卖盘' : 'Ask'} />
        <div className="bg-stone-100 px-4 py-3 text-center font-mono text-sm font-semibold text-stone-950">{language === 'zh' ? '买卖盘中线' : 'Spread Midline'}</div>
        <BookSide levels={bids} side="bid" label={language === 'zh' ? '买盘' : 'Bid'} />
      </div>
    </section>
  )
}

function BookSide({ levels, side, label }: { levels: OrderBookLevel[]; side: 'ask' | 'bid'; label: string }) {
  const depthClass = side === 'ask' ? 'bg-rose-100' : 'bg-amber-100'
  return (
    <div className="divide-y divide-stone-100 bg-white">
      {levels.map((level, index) => (
        <div key={`${side}-${level.price}-${index}`} className="relative grid grid-cols-[64px_1fr_80px] items-center gap-3 px-4 py-2 text-sm">
          <div className={`absolute inset-y-1 right-2 rounded-xl ${depthClass}`} style={{ width: `${level.depth}%`, opacity: 0.55 }} />
          <span className={`relative z-10 font-semibold ${side === 'ask' ? 'text-rose-700' : 'text-amber-700'}`}>
            {label}{levels.length - index}
          </span>
          <span className={`relative z-10 font-mono font-semibold ${side === 'ask' ? 'text-rose-700' : 'text-amber-700'}`}>{level.price}</span>
          <span className="relative z-10 text-right font-mono text-stone-700">{level.size}</span>
        </div>
      ))}
    </div>
  )
}
