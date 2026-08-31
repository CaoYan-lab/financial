import BottomLosersPanel from '@/components/report/BottomLosersPanel'
import DataQualityPanel from '@/components/report/DataQualityPanel'
import MarkdownSourceDrawer from '@/components/report/MarkdownSourceDrawer'
import RemainingStocksPanel from '@/components/report/RemainingStocksPanel'
import ReportToolbar from '@/components/report/ReportToolbar'
import TopOpportunitiesPanel from '@/components/report/TopOpportunitiesPanel'
import UniverseTable from '@/components/UniverseTable'
import AppNav from '@/components/common/AppNav'
import { Link, useParams } from 'react-router-dom'
import { useReportDetail } from '@/hooks/useReportDetail'
import { useReportStore } from '@/stores/reportStore'
import { useUiStore } from '@/stores/uiStore'

export default function ReportView() {
  const { batchId } = useParams()
  const currentReport = useReportStore((state) => state.report)
  const detail = useReportDetail(batchId)
  const report = batchId ? detail.report : currentReport
  const { language, setLanguage } = useUiStore()

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav variant="report" />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        {detail.error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{detail.error}</div> : null}
        {detail.loading ? <p className="rounded-2xl border border-stone-200 bg-white/90 px-4 py-3 text-sm text-stone-500">{language === 'zh' ? '报告加载中...' : 'Loading report...'}</p> : null}
        {report ? (
          <>
            <ReportToolbar
              language={language}
              onLanguageChange={setLanguage}
              markdown={report.markdown}
              batchId={report.batchId}
              generatedAt={report.generatedAt}
              reportWindowDays={report.reportWindowDays}
              usable={report.dataQuality.isUsableForAnalysis}
              analysisModel={report.analysisModel}
            />
            <nav className="sticky top-[73px] z-30 flex flex-wrap gap-2 rounded-3xl border border-stone-200 bg-white/90 p-3 text-sm text-stone-600 shadow-sm backdrop-blur-xl">
              {[
                ['#raw', language === 'zh' ? '纯数据表' : 'Raw Data'],
                ['#top5', language === 'zh' ? '机会前五' : 'Top 5'],
                ['#bottom5', language === 'zh' ? '风险后五' : 'Bottom 5'],
                ['#remaining', language === 'zh' ? '其余股票' : 'Remaining'],
                ['#quality', language === 'zh' ? '数据质量' : 'Quality'],
                ['#markdown-source', language === 'zh' ? '源文件' : 'Source'],
              ].map(([href, label]) => (
                <a key={href} href={href} className="rounded-2xl px-4 py-2 hover:bg-stone-100 hover:text-stone-950">
                  {label}
                </a>
              ))}
            </nav>
            <UniverseTable rows={report.rawData} language={language} />
            <TopOpportunitiesPanel items={report.analysis.topOpportunities} language={language} />
            <BottomLosersPanel items={report.analysis.bottomLosers} language={language} />
            <RemainingStocksPanel summary={report.analysis.groupedSummary} language={language} />
            <DataQualityPanel dataQuality={report.dataQuality} language={language} />
            <MarkdownSourceDrawer markdown={report.markdown} batchId={report.batchId} language={language} />
          </>
        ) : (
          <section className="rounded-3xl border border-stone-200 bg-white/90 p-10 text-center shadow-sm">
            <h1 className="text-2xl font-semibold text-stone-950">{language === 'zh' ? '暂无报告' : 'No Report'}</h1>
            <p className="mt-3 text-stone-500">{language === 'zh' ? '请先返回报告中心选择一份历史报告，或在工作台生成新报告。' : 'Open a historical report from the report center or generate a new one from the workbench.'}</p>
            <Link to="/reports" className="mt-5 inline-flex rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm font-semibold text-amber-800 hover:bg-amber-100">
              {language === 'zh' ? '打开报告中心' : 'Open Report Center'}
            </Link>
          </section>
        )}
      </div>
    </main>
  )
}
