import { Link } from 'react-router-dom'
import Badge, { trackTone, verdictTone } from '@/components/common/Badge'
import MetricCard from '@/components/common/MetricCard'
import { displayTrack, displayValue, displayVerdict } from '@/utils/displayText'
import type { CompanyAnalysis } from '../../../shared/types'
import type { ReportLanguage } from './ReportToolbar'

type Props = {
  items: CompanyAnalysis[]
  language: ReportLanguage
}

export default function TopOpportunitiesPanel({ items, language }: Props) {
  return (
    <section id="top5" className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '机会前五' : 'Top 5 Opportunities'}</p>
      <h2 className="mt-2 text-3xl font-semibold text-stone-950">{language === 'zh' ? '最值得操作的 5 个机会' : 'Top 5 Actionable Ideas'}</h2>
      <div className="mt-6 grid gap-5">
        {items.map((item, index) => (
          <article key={item.ticker} className="rounded-3xl border border-stone-200 bg-stone-50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-stone-500">#{index + 1} / Rank {item.rank}</span>
                  <Badge tone={verdictTone(item.verdict)}>{displayVerdict(item.verdict, language)}</Badge>
                  <Badge tone={trackTone(item.track)}>{displayTrack(item.track, language)}</Badge>
                </div>
                <Link className="mt-3 inline-flex text-2xl font-bold text-stone-950 hover:text-amber-700" to={`/stocks/${item.ticker}`}>
                  {item.ticker} · {item.companyName}
                </Link>
                <div className="mt-2">
                  <Link className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100" to={`/stocks/${item.ticker}`}>
                    {language === 'zh' ? '查看实时行情' : 'Realtime Quote'}
                  </Link>
                </div>
                <p className="mt-2 max-w-4xl text-sm leading-6 text-stone-600">{displayValue(item.rationale, language)}</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-2xl font-semibold text-amber-700">{displayValue(item.currentPrice, language)}</p>
                <p className="text-xs text-stone-500">{item.country}</p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <MetricCard label={language === 'zh' ? 'IV 排名' : 'IV Rank'} value={displayValue(item.ivRank, language)} />
              <MetricCard label={language === 'zh' ? '接货支撑' : 'Support'} value={displayValue(item.supportLevel, language)} />
              <MetricCard label={language === 'zh' ? '财报风险' : 'Earnings'} value={displayValue(item.earningsFlag, language)} accent="amber" />
              <MetricCard label={language === 'zh' ? '每手资金' : 'Capital'} value={displayValue(item.optionStrategy?.capitalPerContract, language)} />
            </div>

            {item.optionStrategy ? (
              <div className="mt-5 rounded-3xl border border-amber-200 bg-amber-50 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-lg font-semibold text-amber-900">
                    {language === 'zh' ? '现金担保卖 Put 操作指引' : 'Cash-Secured Put Playbook'}
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {item.optionStrategy.flags.map((flag) => (
                      <Badge key={flag} tone={flag.includes('High') ? 'red' : 'amber'}>
                        {flag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-5">
                  <MetricCard label={language === 'zh' ? '行权价' : 'Strike'} value={displayValue(item.optionStrategy.strike, language)} accent="cyan" />
                  <MetricCard label={language === 'zh' ? '到期日' : 'Expiry'} value={displayValue(item.optionStrategy.expirationDate, language)} accent="cyan" />
                  <MetricCard label={language === 'zh' ? '权利金' : 'Premium'} value={displayValue(item.optionStrategy.premium, language)} accent="emerald" />
                  <MetricCard label={language === 'zh' ? '年化收益' : 'Annualized'} value={displayValue(item.optionStrategy.annualizedReturn, language)} accent="emerald" />
                  <MetricCard label={language === 'zh' ? '剩余天数' : 'DTE'} value={displayValue(item.optionStrategy.dte, language)} accent="slate" />
                </div>
                <p className="mt-4 text-sm leading-6 text-stone-600">{displayValue(item.optionStrategy.rationale, language)}</p>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
