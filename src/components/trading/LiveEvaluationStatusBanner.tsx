import { Activity, CirclePause, Clock3, Info, TriangleAlert } from 'lucide-react'
import type { LiveEvaluationStatus } from '../../../shared/types'

const statePresentation = {
  STOPPED: {
    icon: CirclePause,
    badge: '已停止',
    tone: 'border-stone-300 bg-stone-50 text-stone-700',
    iconTone: 'text-stone-500',
  },
  RUNNING: {
    icon: Activity,
    badge: '正常评估',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    iconTone: 'text-emerald-600',
  },
  PARTIAL: {
    icon: Clock3,
    badge: '部分运行',
    tone: 'border-amber-200 bg-amber-50 text-amber-800',
    iconTone: 'text-amber-600',
  },
  WAITING_MARKET: {
    icon: Clock3,
    badge: '等待开市',
    tone: 'border-sky-200 bg-sky-50 text-sky-800',
    iconTone: 'text-sky-600',
  },
  ERROR: {
    icon: TriangleAlert,
    badge: '状态异常',
    tone: 'border-rose-200 bg-rose-50 text-rose-800',
    iconTone: 'text-rose-600',
  },
} as const

export default function LiveEvaluationStatusBanner({
  status,
  accent,
  onOpenDetails,
}: {
  status?: LiveEvaluationStatus
  accent: 'futu' | 'longbridge'
  onOpenDetails: () => void
}) {
  if (!status) return null
  const presentation = statePresentation[status.state]
  const Icon = presentation.icon
  const accentClass = accent === 'futu'
    ? 'border-orange-200 shadow-orange-100/50'
    : 'border-sky-200 shadow-sky-100/50'
  const buttonClass = accent === 'futu'
    ? 'border-orange-200 text-orange-800 hover:bg-orange-50'
    : 'border-sky-200 text-sky-800 hover:bg-sky-50'

  return (
    <section className={`rounded-3xl border bg-white/95 p-5 shadow-lg backdrop-blur ${accentClass}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl border ${presentation.tone}`}>
            <Icon className={presentation.iconTone} size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-stone-950">{status.title}</h2>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${presentation.tone}`}>
                {presentation.badge}
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-stone-600">{status.summary}</p>
            <p className="mt-1 text-xs text-stone-500">
              可评估 {status.activeCount} 个 · 等待 {status.waitingCount} 个 · 共 {status.totalCount} 个
            </p>
          </div>
        </div>
        <button
          type="button"
          className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-2xl border bg-white px-4 py-2 text-sm font-bold transition ${buttonClass}`}
          onClick={onOpenDetails}
          title="查看全部策略与标的状态"
          aria-label="查看实盘评估详情说明"
        >
          <Info size={17} aria-hidden="true" />
          详情说明
        </button>
      </div>
    </section>
  )
}
