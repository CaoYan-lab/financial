import { useState } from 'react'
import { Copy, Download } from 'lucide-react'
import { downloadMarkdown } from '@/utils/markdownDownload'
import type { ReportLanguage } from './ReportToolbar'

export default function MarkdownSourceDrawer({ markdown, batchId, language }: { markdown: string; batchId: string; language: ReportLanguage }) {
  const [open, setOpen] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(markdown)
  }

  return (
    <section id="markdown-source" className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-stone-500">{language === 'zh' ? '源文件' : 'Source File'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? 'Markdown 源文件' : 'Markdown Source File'}</h2>
          <p className="mt-2 text-sm text-stone-500">
            {language === 'zh' ? '主阅读视图已结构化；这里仅用于复制、下载和留档。' : 'The readable report is structured above; this source is for copy, download and archive.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm text-stone-700 hover:bg-stone-50" onClick={() => setOpen(!open)}>
            {open ? (language === 'zh' ? '收起' : 'Collapse') : language === 'zh' ? '展开源文件' : 'Show Source'}
          </button>
          <button className="rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm text-stone-700 hover:bg-stone-50" onClick={copy}>
            <Copy className="mr-2 inline" size={16} />
            {language === 'zh' ? '复制' : 'Copy'}
          </button>
          <button className="rounded-2xl bg-amber-600 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-amber-500" onClick={() => downloadMarkdown(markdown, batchId)}>
            <Download className="mr-2 inline" size={16} />
            {language === 'zh' ? '下载' : 'Download'}
          </button>
        </div>
      </div>
      {open ? <pre className="mt-5 max-h-[560px] overflow-auto rounded-2xl border border-stone-200 bg-stone-100 p-5 font-mono text-xs leading-6 text-stone-700">{markdown}</pre> : null}
    </section>
  )
}
