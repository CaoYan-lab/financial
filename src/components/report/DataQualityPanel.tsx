import Badge from '@/components/common/Badge'
import type { DataQualityReport } from '../../../shared/types'
import type { ReportLanguage } from './ReportToolbar'

export default function DataQualityPanel({ dataQuality, language }: { dataQuality: DataQualityReport; language: ReportLanguage }) {
  return (
    <section id="quality" className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '数据质量' : 'Data Quality'}</p>
      <h2 className="mt-2 text-3xl font-semibold text-stone-950">{language === 'zh' ? '数据质量与来源' : 'Data Quality & Sources'}</h2>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4 md:col-span-2">
          <p className="text-sm font-semibold text-stone-950">{language === 'zh' ? '数据来源' : 'Sources'}</p>
          <div className="mt-3 space-y-2 text-sm text-stone-600">
            {dataQuality.sources.map((source) => (
              <p key={`${source.source}-${source.timestamp}`}>
                {source.source}
                {source.url ? ` · ${source.url}` : ''} · {source.timestamp}
              </p>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
          <p className="text-sm font-semibold text-stone-950">{language === 'zh' ? '可用性' : 'Usability'}</p>
          <div className="mt-3">
            <Badge tone={dataQuality.isUsableForAnalysis ? 'emerald' : 'red'}>{dataQuality.isUsableForAnalysis ? (language === 'zh' ? '可用' : 'Usable') : language === 'zh' ? '警示' : 'Warning'}</Badge>
          </div>
          <p className="mt-3 text-xs text-stone-500">{dataQuality.generatedAt}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {Object.entries(dataQuality.unavailableSummary).map(([field, count]) => (
          <Badge key={field} tone="amber">
            {field}: {count}
          </Badge>
        ))}
      </div>
    </section>
  )
}
