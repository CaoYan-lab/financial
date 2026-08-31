import { ArrowLeft, Copy, Download } from 'lucide-react'
import { Link } from 'react-router-dom'
import { downloadMarkdown } from '@/utils/markdownDownload'
import type { UiLanguage } from '@/stores/uiStore'
import type { ReportAnalysisModel } from '../../../shared/types'

export type ReportLanguage = UiLanguage

type Props = {
  language: ReportLanguage
  onLanguageChange: (language: ReportLanguage) => void
  markdown: string
  batchId: string
  generatedAt: string
  reportWindowDays?: 30 | 60
  usable: boolean
  analysisModel?: ReportAnalysisModel
}

export default function ReportToolbar({ language, onLanguageChange, markdown, batchId, generatedAt, reportWindowDays = 30, usable, analysisModel }: Props) {
  const copy = async () => {
    await navigator.clipboard.writeText(markdown)
  }

  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link to="/futu" className="rounded-2xl border border-stone-200 bg-stone-50 p-3 text-stone-700 hover:bg-stone-100">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">{language === 'zh' ? '可读网页报告' : 'Readable Web Report'}</p>
            <h1 className="text-2xl font-semibold text-stone-950">
              {language === 'zh' ? `${reportWindowDays} 日 Top 30 CSP 可读投资报告` : `${reportWindowDays}D Top 30 CSP Readable Research Report`}
            </h1>
            <p className="mt-1 text-xs text-stone-500">
              {language === 'zh' ? '批次' : 'Batch'} {batchId} · {generatedAt} · {reportWindowDays}D · {usable ? (language === 'zh' ? '数据可用' : 'Data usable') : language === 'zh' ? '数据质量提示' : 'Data quality warning'}
            </p>
            <p className="mt-1 text-xs text-orange-600">
              {language === 'zh' ? '报告模型' : 'Report model'}: {analysisModel?.modelLabel ?? (language === 'zh' ? '规则预览' : 'Rule preview')}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-2xl border border-stone-200 bg-stone-50 p-1">
            {(['zh', 'en'] as const).map((item) => (
              <button
                key={item}
                className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                  language === item ? 'bg-amber-600 text-stone-950' : 'text-stone-600 hover:bg-white'
                }`}
                onClick={() => onLanguageChange(item)}
              >
                {item === 'zh' ? '中文' : 'English'}
              </button>
            ))}
          </div>
          <button className="rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700 hover:bg-stone-50" onClick={copy}>
            <Copy className="mr-2 inline" size={16} />
            {language === 'zh' ? '复制源文件' : 'Copy Source'}
          </button>
          <button
            className="rounded-2xl bg-amber-600 px-4 py-3 text-sm font-bold text-stone-950 hover:bg-amber-500"
            onClick={() => downloadMarkdown(markdown, batchId)}
          >
            <Download className="mr-2 inline" size={16} />
            {language === 'zh' ? '下载源文件' : 'Download Source'}
          </button>
        </div>
      </div>
    </section>
  )
}
