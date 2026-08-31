import Badge from '@/components/common/Badge'
import MetricCard from '@/components/common/MetricCard'
import { useUiStore } from '@/stores/uiStore'
import { displayValue } from '@/utils/displayText'
import type { PortfolioRiskSummary } from '../../../shared/types'

export default function RiskExposurePanel({ risk }: { risk?: PortfolioRiskSummary }) {
  const language = useUiStore((state) => state.language)
  const defaultWarning = language === 'zh' ? '当前账户字段未返回额外风险警示。' : 'No risk warning from available account fields.'

  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '风险' : 'Risk'}</p>
      <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '组合风险雷达' : 'Portfolio Risk Radar'}</h2>
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <MetricCard label={language === 'zh' ? '最大持仓' : 'Largest Position'} value={displayValue(risk?.largestPosition, language)} accent="amber" />
        <MetricCard label={language === 'zh' ? '集中度' : 'Concentration'} value={displayValue(risk?.concentrationRisk, language)} accent="amber" />
        <MetricCard label={language === 'zh' ? '现金占比' : 'Cash Ratio'} value={displayValue(risk?.cashRatio, language)} />
        <MetricCard label={language === 'zh' ? 'Top 30 重合度' : 'Top 30 Overlap'} value={displayValue(risk?.top30Overlap, language)} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {(risk?.warnings.length ? risk.warnings : [defaultWarning]).map((warning) => (
          <Badge key={warning} tone={risk?.warnings.length ? 'amber' : 'emerald'}>
            {warning}
          </Badge>
        ))}
      </div>
    </section>
  )
}
