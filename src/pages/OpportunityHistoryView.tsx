import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import Badge, { trackTone, verdictTone } from '@/components/common/Badge'
import { useTopOpportunityHistory } from '@/hooks/useTopOpportunityHistory'
import { useUiStore } from '@/stores/uiStore'
import { displayTrack, displayValue, displayVerdict } from '@/utils/displayText'

export default function OpportunityHistoryView() {
  const language = useUiStore((state) => state.language)
  const { data, page, loading, error, setPage } = useTopOpportunityHistory()
  const [openBatchId, setOpenBatchId] = useState<string>()
  const groups = data?.items ?? []

  useEffect(() => {
    if (!openBatchId && groups[0]) setOpenBatchId(groups[0].report.batchId)
  }, [groups, openBatchId])

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-amber-800">{language === 'zh' ? '机会历史' : 'Opportunity History'}</p>
              <h1 className="mt-2 text-3xl font-semibold text-stone-950">{language === 'zh' ? '历史 Top5 操作机会' : 'Historical Top5 Opportunities'}</h1>
            </div>
            <Link to="/futu" className="rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">
              {language === 'zh' ? '返回工作台' : 'Back to Workbench'}
            </Link>
          </div>
          {error ? <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
          <div className="mt-6 space-y-4">
            {groups.map((group) => {
              const open = openBatchId === group.report.batchId
              return (
                <article key={group.report.batchId} className="rounded-3xl border border-stone-200 bg-stone-50">
                  <button className="w-full p-5 text-left" onClick={() => setOpenBatchId(open ? undefined : group.report.batchId)}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="font-mono text-lg font-semibold text-stone-950">{new Date(group.report.generatedAt).toLocaleString()}</p>
                        <p className="mt-1 font-mono text-xs text-stone-500">{group.report.batchId}</p>
                      </div>
                      <Badge tone="violet">{open ? (language === 'zh' ? '收起' : 'Collapse') : language === 'zh' ? '展开' : 'Expand'}</Badge>
                    </div>
                    <p className="mt-3 text-sm text-stone-600">Top5: {group.report.topOpportunityTickers.join(', ') || 'None'}</p>
                  </button>
                  {open ? (
                    <div className="border-t border-stone-200 p-5">
                      <div className="grid gap-4">
                        {group.opportunities.map((snapshot) => {
                          const item = snapshot.analysis
                          return (
                            <div key={snapshot.id} className="rounded-2xl border border-white bg-white p-4 shadow-sm">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="font-mono text-lg font-bold text-stone-950">#{snapshot.opportunityRank} {item.ticker}</p>
                                  <p className="text-sm text-stone-500">{displayValue(item.companyName, language)}</p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <Badge tone={verdictTone(item.verdict)}>{displayVerdict(item.verdict, language)}</Badge>
                                  <Badge tone={trackTone(item.track)}>{displayTrack(item.track, language)}</Badge>
                                </div>
                              </div>
                              <p className="mt-3 text-sm leading-6 text-stone-600">{displayValue(item.rationale, language)}</p>
                              {item.optionStrategy ? (
                                <p className="mt-3 text-sm text-amber-800">
                                  {language === 'zh' ? '策略' : 'Strategy'}: {displayValue(item.optionStrategy.strike, language)} · {displayValue(item.optionStrategy.expirationDate, language)} · {displayValue(item.optionStrategy.annualizedReturn, language)}
                                </p>
                              ) : null}
                              <Link className="mt-3 inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100" to={`/stocks/${item.ticker}`}>
                                {language === 'zh' ? '查看实时行情' : 'Realtime Quote'}
                              </Link>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}
                </article>
              )
            })}
            {!loading && !groups.length ? <p className="rounded-2xl border border-stone-200 bg-stone-50 p-5 text-sm text-stone-500">{language === 'zh' ? '暂无历史 Top5。' : 'No Top5 history yet.'}</p> : null}
            {loading ? <p className="text-sm text-stone-500">{language === 'zh' ? '加载中...' : 'Loading...'}</p> : null}
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-500">{language === 'zh' ? `第 ${page} / ${data?.totalPages ?? 1} 页` : `Page ${page} / ${data?.totalPages ?? 1}`}</p>
            <div className="flex gap-2">
              <button className="rounded-2xl border border-stone-200 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                {language === 'zh' ? '上一页' : 'Prev'}
              </button>
              <button className="rounded-2xl border border-stone-200 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={page >= (data?.totalPages ?? 1)} onClick={() => setPage(page + 1)}>
                {language === 'zh' ? '下一页' : 'Next'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
