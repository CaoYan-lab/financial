import { Link } from 'react-router-dom'
import Badge from '@/components/common/Badge'
import { useUiStore } from '@/stores/uiStore'
import type { ReportHistorySummary } from '../../../shared/types'

export default function ResearchReportPanel({ recentReports }: { recentReports?: ReportHistorySummary[] }) {
  const language = useUiStore((state) => state.language)
  const reports = recentReports ?? []

  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '报告' : 'Report'}</p>
      <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '研究报告中心' : 'Research Report Center'}</h2>
      {reports.length ? (
        <>
          <div className="mt-5 grid gap-3">
            {reports.slice(0, 3).map((item) => (
              <Link key={item.batchId} to={`/reports/${item.batchId}`} className="rounded-2xl border border-stone-200 bg-stone-50 p-4 hover:border-amber-200 hover:bg-amber-50">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm font-semibold text-stone-900">{new Date(item.generatedAt).toLocaleString()}</p>
                    <p className="mt-1 font-mono text-xs text-stone-500">{item.batchId}</p>
                    <p className="mt-1 text-xs text-orange-600">{language === 'zh' ? '模型' : 'Model'}: {item.analysisModel?.modelLabel ?? (language === 'zh' ? '规则预览' : 'Rule preview')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="amber">{item.reportWindowDays ?? 30}D</Badge>
                    <Badge tone={item.isUsableForAnalysis ? 'emerald' : 'amber'}>{item.isUsableForAnalysis ? (language === 'zh' ? '可分析' : 'Usable') : language === 'zh' ? '需复核' : 'Review'}</Badge>
                  </div>
                </div>
                <p className="mt-3 text-sm text-stone-600">Top5: {item.topOpportunityTickers.join(', ') || 'None'}</p>
              </Link>
            ))}
          </div>
          <Link to="/reports" className="mt-5 inline-flex rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm font-semibold text-amber-700 hover:bg-amber-100">
            {language === 'zh' ? '查看更多报告' : 'View More Reports'}
          </Link>
        </>
      ) : (
        <p className="mt-5 text-sm text-stone-500">{language === 'zh' ? '生成报告后会自动归档到这里，首页仅展示最近 3 次。' : 'Generated reports are archived here. The workbench shows the latest 3 only.'}</p>
      )}
    </section>
  )
}
