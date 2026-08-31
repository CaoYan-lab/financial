import type { ReactNode } from 'react'

export default function MetricCard({
  label,
  value,
  helper,
  accent = 'cyan',
  valueClassName,
  action,
}: {
  label: string
  value: ReactNode
  helper?: ReactNode
  accent?: 'cyan' | 'emerald' | 'amber' | 'red' | 'slate'
  valueClassName?: string
  action?: ReactNode
}) {
  const accentClass = {
    cyan: 'border-amber-200 border-t-amber-500',
    emerald: 'border-amber-200 border-t-amber-500',
    amber: 'border-amber-200 border-t-amber-500',
    red: 'border-rose-200 border-t-rose-500',
    slate: 'border-stone-200 border-t-stone-400',
  }[accent]

  return (
    <div className={`rounded-2xl border border-t-4 ${accentClass} bg-white p-4 shadow-sm`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold tracking-wide text-stone-500">{label}</p>
        {action}
      </div>
      <div className={`mt-2 break-words text-lg font-semibold tabular-nums ${valueClassName ?? 'text-stone-950'}`}>{value}</div>
      {helper ? <p className="mt-2 text-xs text-stone-500">{helper}</p> : null}
    </div>
  )
}
