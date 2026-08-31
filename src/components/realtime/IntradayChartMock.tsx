import type { UiLanguage } from '@/stores/uiStore'
import type { RealtimePoint } from '@/mocks/realtimeStockMock'

export default function IntradayChartMock({ points, language, isRealtime }: { points: RealtimePoint[]; language: UiLanguage; isRealtime: boolean }) {
  const prices = points.map((point) => point.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const first = prices[0] ?? 0
  const last = prices.at(-1) ?? first
  const lineColor = last >= first ? '#dc2626' : '#059669'
  const path = points
    .map((point, index) => {
      const x = 24 + (index / Math.max(points.length - 1, 1)) * 552
      const y = 220 - ((point.price - min) / Math.max(max - min, 0.01)) * 170
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '实时分时' : 'Intraday'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '分时回调走势' : 'Ticker Callback Chart'}</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${isRealtime ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {isRealtime ? (language === 'zh' ? `真实分时 · ${points.length} 点` : `Realtime · ${points.length} points`) : language === 'zh' ? 'Mock 折线' : 'Mock Line'}
        </span>
      </div>
      <svg className="mt-5 h-[260px] w-full rounded-2xl bg-stone-50" viewBox="0 0 600 260" role="img" aria-label={language === 'zh' ? '分时视觉图' : 'Intraday visual chart'}>
        {[50, 100, 150, 200].map((y) => (
          <line key={y} x1="24" x2="576" y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />
        ))}
        <line x1="24" x2="576" y1="135" y2="135" stroke="#94a3b8" strokeDasharray="5 5" strokeWidth="1" />
        <path d={`${path} L 576 232 L 24 232 Z`} fill={lineColor} opacity="0.08" />
        <path d={path} fill="none" stroke={lineColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
        {points.filter((_, index) => index % 6 === 0).map((point, index) => (
          <text key={point.time} x={24 + index * 120} y="248" fill="#64748b" fontSize="11">
            {point.time}
          </text>
        ))}
        <text x="26" y="24" fill="#334155" fontSize="12">
          {max.toFixed(2)}
        </text>
        <text x="26" y="226" fill="#334155" fontSize="12">
          {min.toFixed(2)}
        </text>
      </svg>
    </section>
  )
}
