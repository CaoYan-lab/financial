import { Link } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import Badge from '@/components/common/Badge'
import { useReportPrompt } from '@/hooks/useReportPrompt'
import { useUiStore } from '@/stores/uiStore'

export default function Top30PromptView() {
  const language = useUiStore((state) => state.language)
  const { promptArchive, loading, error } = useReportPrompt()

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '原始 Prompt' : 'Original Prompt'}</p>
              <h1 className="mt-2 text-3xl font-semibold text-stone-950">{promptArchive?.title ?? 'Top30 CSP Research Prompt'}</h1>
            </div>
            <Link to="/futu" className="rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">
              {language === 'zh' ? '返回工作台' : 'Back to Workbench'}
            </Link>
          </div>
          {error ? <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
          {loading ? <p className="mt-5 text-sm text-stone-500">{language === 'zh' ? '加载中...' : 'Loading...'}</p> : null}
          {promptArchive ? (
            <>
              <div className="mt-6 rounded-3xl border border-amber-100 bg-amber-50 p-5">
                <div className="flex flex-wrap gap-2">
                  <Badge tone="cyan">{promptArchive.source}</Badge>
                </div>
                <p className="mt-3 text-sm leading-6 text-stone-700">{promptArchive.summary}</p>
                <p className="mt-3 text-xs text-stone-500">
                  {language === 'zh'
                    ? '当前保存的是用户已提供的 Prompt v3 片段，后续可替换为完整全文。'
                    : 'The current archive is the user-provided Prompt v3 fragment and can be replaced with the full text later.'}
                </p>
              </div>
              <pre className="mt-6 overflow-x-auto whitespace-pre-wrap rounded-3xl border border-stone-200 bg-white p-6 text-sm leading-6 text-stone-700">
                {promptArchive.rawPrompt}
              </pre>
            </>
          ) : null}
        </section>
      </div>
    </main>
  )
}
