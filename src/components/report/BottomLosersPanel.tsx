import { Link } from 'react-router-dom'
import Badge, { verdictTone } from '@/components/common/Badge'
import { displayValue, displayVerdict } from '@/utils/displayText'
import type { CompanyAnalysis } from '../../../shared/types'
import type { ReportLanguage } from './ReportToolbar'

export default function BottomLosersPanel({ items, language }: { items: CompanyAnalysis[]; language: ReportLanguage }) {
  return (
    <section id="bottom5" className="rounded-3xl border border-rose-100 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-rose-700">{language === 'zh' ? '风险后五' : 'Bottom 5 Risks'}</p>
      <h2 className="mt-2 text-3xl font-semibold text-stone-950">{language === 'zh' ? '短期风险回报最差的 5 个标的' : 'Bottom 5 Risk / Reward Setups'}</h2>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {items.map((item) => (
          <article key={item.ticker} className="rounded-3xl border border-rose-200 bg-rose-50 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={verdictTone(item.verdict)}>{displayVerdict(item.verdict, language)}</Badge>
                  <Badge tone="red">{displayValue(item.putSellingView ?? 'Avoid', language)}</Badge>
                </div>
                <Link className="mt-3 inline-flex text-xl font-bold text-stone-950 hover:text-amber-700" to={`/stocks/${item.ticker}`}>
                  {item.ticker} · {item.companyName}
                </Link>
                <div className="mt-2">
                  <Link className="rounded-full border border-amber-200 bg-white px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50" to={`/stocks/${item.ticker}`}>
                    {language === 'zh' ? '实时行情' : 'Realtime'}
                  </Link>
                </div>
              </div>
              <p className="font-mono text-lg font-semibold text-rose-700">{displayValue(item.currentPrice, language)}</p>
            </div>
            <div className="mt-4 space-y-3 text-sm leading-6 text-stone-700">
              <p>
                <span className="font-semibold text-rose-700">{language === 'zh' ? '为什么弱：' : 'Why weak: '}</span>
                {displayValue(item.rationale, language)}
              </p>
              <p>
                <span className="font-semibold text-amber-700">{language === 'zh' ? '风险因子：' : 'Risk factor: '}</span>
                {displayValue(item.riskFactor, language)}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
