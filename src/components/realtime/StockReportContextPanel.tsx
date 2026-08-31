import Badge, { trackTone, verdictTone } from '@/components/common/Badge'
import MetricCard from '@/components/common/MetricCard'
import { displayTrack, displayValue, displayVerdict } from '@/utils/displayText'
import type { UiLanguage } from '@/stores/uiStore'
import type { CompanyAnalysis } from '../../../shared/types'

export default function StockReportContextPanel({ analysis, language }: { analysis?: CompanyAnalysis; language: UiLanguage }) {
  if (!analysis) {
    return (
      <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
        <p className="text-xs font-semibold tracking-[0.25em] text-stone-500">{language === 'zh' ? '报告上下文' : 'Report Context'}</p>
        <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '暂无报告上下文' : 'No Report Context'}</h2>
        <p className="mt-3 text-sm leading-6 text-stone-600">
          {language === 'zh' ? '生成 Top 30 CSP 报告后，本区域会展示该股票的评级、Track 和期权策略摘要。' : 'Generate a Top 30 CSP report to show rating, track and options context here.'}
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-stone-500">{language === 'zh' ? '报告上下文' : 'Report Context'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{analysis.ticker} · {analysis.companyName}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={verdictTone(analysis.verdict)}>{displayVerdict(analysis.verdict, language)}</Badge>
          <Badge tone={trackTone(analysis.track)}>{displayTrack(analysis.track, language)}</Badge>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-stone-600">{displayValue(analysis.rationale, language)}</p>
      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <MetricCard label={language === 'zh' ? '当前价' : 'Price'} value={displayValue(analysis.currentPrice, language)} />
        <MetricCard label={language === 'zh' ? 'IV 排名' : 'IV Rank'} value={displayValue(analysis.ivRank, language)} />
        <MetricCard label={language === 'zh' ? '接货支撑' : 'Support'} value={displayValue(analysis.supportLevel, language)} />
        <MetricCard label={language === 'zh' ? '财报风险' : 'Earnings'} value={displayValue(analysis.earningsFlag, language)} accent="amber" />
      </div>
      {analysis.optionStrategy ? (
        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">{language === 'zh' ? '卖 Put 指引摘要' : 'Sell Put Summary'}</p>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            {language === 'zh' ? '行权价' : 'Strike'} {displayValue(analysis.optionStrategy.strike, language)} · {language === 'zh' ? '到期日' : 'Expiry'}{' '}
            {displayValue(analysis.optionStrategy.expirationDate, language)} · {language === 'zh' ? '权利金' : 'Premium'}{' '}
            {displayValue(analysis.optionStrategy.premium, language)}
          </p>
        </div>
      ) : null}
    </section>
  )
}
