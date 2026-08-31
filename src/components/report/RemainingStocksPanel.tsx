import { useState } from 'react'
import { Link } from 'react-router-dom'
import Badge, { trackTone, verdictTone } from '@/components/common/Badge'
import { displayTrack, displayValue, displayVerdict } from '@/utils/displayText'
import type { GroupedSummary } from '../../../shared/types'
import type { ReportLanguage } from './ReportToolbar'

type GroupKey = keyof GroupedSummary

export default function RemainingStocksPanel({ summary, language }: { summary: GroupedSummary; language: ReportLanguage }) {
  const [openGroup, setOpenGroup] = useState<GroupKey>('neutralHold')
  const groups: Array<{ key: GroupKey; titleZh: string; titleEn: string; tone: 'emerald' | 'amber' | 'red' }> = [
    { key: 'attractiveButNotTop5', titleZh: '有吸引力但未进 Top 5', titleEn: 'Attractive but not Top 5', tone: 'emerald' },
    { key: 'neutralHold', titleZh: '中性 / 持有', titleEn: 'Neutral / Hold', tone: 'amber' },
    { key: 'trimWatchlistRisk', titleZh: '减仓 / 风险观察', titleEn: 'Trim / Watchlist Risk', tone: 'red' },
  ]

  return (
    <section id="remaining" className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-stone-500">{language === 'zh' ? '其余股票' : 'Remaining 20'}</p>
      <h2 className="mt-2 text-3xl font-semibold text-stone-950">{language === 'zh' ? '其余股票分组总结' : 'Grouped Summary for Remaining Stocks'}</h2>
      <div className="mt-6 grid gap-4">
        {groups.map((group) => {
          const items = summary[group.key]
          const open = openGroup === group.key
          return (
            <div key={group.key} className="rounded-3xl border border-stone-200 bg-stone-50 p-5">
              <button className="flex w-full items-center justify-between gap-4 text-left" onClick={() => setOpenGroup(open ? 'neutralHold' : group.key)}>
                <span className="text-lg font-semibold text-stone-950">{language === 'zh' ? group.titleZh : group.titleEn}</span>
                <Badge tone={group.tone}>{items.length}</Badge>
              </button>
              <div className="mt-4 flex flex-wrap gap-2">
                {items.map((item) => (
                  <Link key={item.ticker} to={`/stocks/${item.ticker}`}>
                    <Badge tone={trackTone(item.track)}>
                      {item.ticker} · {displayTrack(item.track, language)}
                    </Badge>
                  </Link>
                ))}
              </div>
              {open ? (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {items.map((item) => (
                    <div key={item.ticker} className="rounded-2xl border border-stone-200 bg-white p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link className="font-mono font-semibold text-amber-700 hover:text-amber-500" to={`/stocks/${item.ticker}`}>
                          {item.ticker}
                        </Link>
                        <Badge tone={verdictTone(item.verdict)}>{displayVerdict(item.verdict, language)}</Badge>
                        <Badge tone={trackTone(item.track)}>{displayTrack(item.track, language)}</Badge>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-stone-600">{displayValue(item.rationale, language)}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}
