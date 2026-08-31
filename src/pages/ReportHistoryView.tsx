import { Link } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import Badge from '@/components/common/Badge'
import { useReportHistory } from '@/hooks/useReportHistory'
import { useUiStore } from '@/stores/uiStore'

export default function ReportHistoryView() {
  const language = useUiStore((state) => state.language)
  const { data, page, loading, error, setPage } = useReportHistory()
  const items = data?.items ?? []

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-amber-800">{language === 'zh' ? '报告历史' : 'Report History'}</p>
              <h1 className="mt-2 text-3xl font-semibold text-stone-950">{language === 'zh' ? '研究报告中心' : 'Research Report Center'}</h1>
            </div>
            <Link to="/futu" className="rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">
              {language === 'zh' ? '返回工作台' : 'Back to Workbench'}
            </Link>
          </div>
          {error ? <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
          <div className="mt-6 grid gap-4">
            {items.map((item) => (
              <Link key={item.batchId} to={`/reports/${item.batchId}`} className="rounded-3xl border border-stone-200 bg-stone-50 p-5 hover:border-amber-200 hover:bg-amber-50">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-lg font-semibold text-stone-950">{new Date(item.generatedAt).toLocaleString()}</p>
                    <p className="mt-1 font-mono text-xs text-stone-500">{item.batchId}</p>
                    <p className="mt-1 text-xs text-orange-700">{language === 'zh' ? '模型' : 'Model'}: {item.analysisModel?.modelLabel ?? (language === 'zh' ? '规则预览' : 'Rule preview')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="amber">{item.reportWindowDays ?? 30}D</Badge>
                    <Badge tone={item.isUsableForAnalysis ? 'emerald' : 'amber'}>{item.isUsableForAnalysis ? (language === 'zh' ? '可分析' : 'Usable') : language === 'zh' ? '需复核' : 'Review'}</Badge>
                    <Badge>{language === 'zh' ? `${item.rawRowCount} 行` : `${item.rawRowCount} rows`}</Badge>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <p className="text-sm text-stone-600">Top5: {item.topOpportunityTickers.join(', ') || 'None'}</p>
                  <p className="text-sm text-stone-600">Bottom5: {item.bottomLoserTickers.join(', ') || 'None'}</p>
                </div>
              </Link>
            ))}
            {!loading && !items.length ? <p className="rounded-2xl border border-stone-200 bg-stone-50 p-5 text-sm text-stone-500">{language === 'zh' ? '暂无历史报告。' : 'No historical reports yet.'}</p> : null}
            {loading ? <p className="text-sm text-stone-500">{language === 'zh' ? '加载中...' : 'Loading...'}</p> : null}
          </div>
          <Pagination page={page} totalPages={data?.totalPages ?? 1} onPageChange={setPage} />
        </section>
      </div>
    </main>
  )
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  const language = useUiStore((state) => state.language)
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-stone-500">
        {language === 'zh' ? `第 ${page} / ${totalPages} 页` : `Page ${page} / ${totalPages}`}
      </p>
      <div className="flex gap-2">
        <button className="rounded-2xl border border-stone-200 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          {language === 'zh' ? '上一页' : 'Prev'}
        </button>
        <button className="rounded-2xl border border-stone-200 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          {language === 'zh' ? '下一页' : 'Next'}
        </button>
      </div>
    </div>
  )
}
