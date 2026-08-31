import { useUiStore } from '@/stores/uiStore'

const stages = [
  { zh: '股票池', en: 'Universe' },
  { zh: '市场数据', en: 'Market Data' },
  { zh: '完整性校验', en: 'Integrity' },
  { zh: '分析', en: 'Analysis' },
  { zh: '源文件', en: 'Source File' },
]

type Props = {
  active: boolean
  completed: boolean
}

export default function StatusTimeline({ active, completed }: Props) {
  const language = useUiStore((state) => state.language)
  const statusText = completed ? (language === 'zh' ? '已完成' : 'Completed') : active ? (language === 'zh' ? '运行中' : 'Running') : language === 'zh' ? '等待中' : 'Queued'

  return (
    <section className="rounded-3xl border border-stone-200 bg-white/80 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-stone-500">{language === 'zh' ? '流程' : 'Pipeline'}</p>
      <div className="mt-5 grid gap-3 md:grid-cols-5">
        {stages.map((stage, index) => (
          <div key={stage.en} className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
            <div
              className={`mb-3 h-2 rounded-full ${
                completed || active ? 'bg-amber-500 shadow-lg shadow-amber-500/20' : 'bg-stone-200'
              }`}
              style={{ transitionDelay: `${index * 90}ms` }}
            />
            <p className="text-sm font-semibold text-stone-950">{stage[language]}</p>
            <p className="mt-1 text-xs text-stone-500">{statusText}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
