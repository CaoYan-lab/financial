import type { UiLanguage } from '@/stores/uiStore'
import type { RealtimeBar } from '@/mocks/realtimeStockMock'

export default function RealtimeKlineMock({ bars, language, isRealtime }: { bars: RealtimeBar[]; language: UiLanguage; isRealtime: boolean }) {
  const values = bars.flatMap((bar) => [bar.high, bar.low])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const scaleY = (value: number) => 220 - ((value - min) / Math.max(max - min, 0.01)) * 170

  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">{language === 'zh' ? '实时 K 线' : 'Realtime K-line'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? 'K 线回调走势' : 'K-line Callback Chart'}</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${isRealtime ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {isRealtime ? (language === 'zh' ? `真实 K 线 · ${bars.length} 根` : `Realtime · ${bars.length} bars`) : language === 'zh' ? 'Mock 蜡烛' : 'Mock Candles'}
        </span>
      </div>
      <svg className="mt-5 h-[260px] w-full rounded-2xl bg-stone-50" viewBox="0 0 600 260" role="img" aria-label={language === 'zh' ? 'K线视觉图' : 'K-line visual chart'}>
        {[50, 100, 150, 200].map((y) => (
          <line key={y} x1="24" x2="576" y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />
        ))}
        {bars.map((bar, index) => {
          const x = 24 + (index / Math.max(bars.length - 1, 1)) * 552
          const bodyWidth = Math.max(Math.min(420 / Math.max(bars.length, 1), 14), 4)
          const up = bar.close >= bar.open
          const color = up ? '#dc2626' : '#059669'
          const bodyTop = Math.min(scaleY(bar.open), scaleY(bar.close))
          const bodyHeight = Math.max(Math.abs(scaleY(bar.open) - scaleY(bar.close)), 4)
          return (
            <g key={`${bar.time}-${index}`}>
              <line x1={x} x2={x} y1={scaleY(bar.high)} y2={scaleY(bar.low)} stroke={color} strokeWidth="2" />
              <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} rx="2" fill={color} opacity="0.9" />
            </g>
          )
        })}
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
