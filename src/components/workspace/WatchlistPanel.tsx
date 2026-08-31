import { Link } from 'react-router-dom'
import Badge from '@/components/common/Badge'
import { useUiStore } from '@/stores/uiStore'
import type { ReportGenerationResult, ReportPromptArchive } from '../../../shared/types'

export default function WatchlistPanel({ report, promptArchive }: { report?: ReportGenerationResult; promptArchive?: ReportPromptArchive }) {
  const language = useUiStore((state) => state.language)
  const tickers = report?.rawData.map((row) => row.ticker) ?? []
  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '报告规则' : 'Report Prompt'}</p>
      <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? 'Top30 CSP 研究说明' : 'Top30 CSP Research Brief'}</h2>
      <p className="mt-4 text-sm leading-6 text-stone-600">
        {promptArchive?.summary ??
          (language === 'zh'
            ? '围绕全球市值前30且在美交易的公司，筛选适合现金担保卖 Put 的候选机会。'
            : 'Research the Top30 US-traded global mega-cap companies for cash-secured put candidates.')}
      </p>
      <Link to="/top30-prompt" className="mt-4 inline-flex rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-100">
        {language === 'zh' ? '查看原始 Prompt' : 'Open Original Prompt'}
      </Link>
      <div className="mt-5 flex flex-wrap gap-2">
        {tickers.length ? tickers.map((ticker) => <Badge key={ticker} tone="slate">{ticker}</Badge>) : <p className="text-sm text-stone-500">{language === 'zh' ? '生成报告后会展示当前覆盖的 Top30 标的。' : 'Generate a report to show the current Top30 universe.'}</p>}
      </div>
    </section>
  )
}
