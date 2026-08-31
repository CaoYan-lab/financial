import { Link } from 'react-router-dom'
import Badge, { trackTone, verdictTone } from '@/components/common/Badge'
import { useUiStore } from '@/stores/uiStore'
import { displayTrack, displayVerdict, displayValue } from '@/utils/displayText'
import type { TopOpportunitySnapshot } from '../../../shared/types'

export default function OpportunityCommandPanel({ opportunities }: { opportunities?: TopOpportunitySnapshot[] }) {
  const language = useUiStore((state) => state.language)
  const items = opportunities ?? []

  return (
    <section className="rounded-3xl border border-orange-100 bg-white/90 p-6 shadow-sm">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">{language === 'zh' ? '研究机会' : 'Research'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '机会指挥台' : 'Opportunity Command'}</h2>
        </div>
        {items.length ? (
          <Link to="/opportunities" className="rounded-2xl bg-orange-600 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-orange-500">
            {language === 'zh' ? '查看历史 Top5' : 'Top5 History'}
          </Link>
        ) : null}
      </div>
      <div className="mt-5 grid gap-3">
        {items.map((snapshot) => {
          const item = snapshot.analysis
          return (
            <div key={`${snapshot.batchId}-${item.ticker}`} className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-lg font-bold text-stone-950">#{snapshot.opportunityRank} {item.ticker}</p>
                  <p className="text-xs text-stone-500">{displayValue(item.companyName, language)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={verdictTone(item.verdict)}>{displayVerdict(item.verdict, language)}</Badge>
                  <Badge tone={trackTone(item.track)}>{displayTrack(item.track, language)}</Badge>
                </div>
              </div>
              <p className="mt-3 text-sm text-stone-600">
                {item.optionStrategy
                  ? `${language === 'zh' ? '行权价' : 'Strike'} ${displayValue(item.optionStrategy.strike, language)} · ${displayValue(item.optionStrategy.expirationDate, language)} · ${displayValue(item.optionStrategy.annualizedReturn, language)}`
                  : displayValue(item.rationale, language)}
              </p>
            </div>
          )
        })}
        {!items.length ? <p className="text-sm text-stone-500">{language === 'zh' ? '生成报告后展示最新一次 Top5 操作机会。' : 'Generate a report to show the latest Top5 opportunities.'}</p> : null}
      </div>
    </section>
  )
}
