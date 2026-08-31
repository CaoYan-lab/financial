import type { ReactNode } from 'react'

type Tone = 'cyan' | 'emerald' | 'amber' | 'red' | 'slate' | 'violet'

const toneClasses: Record<Tone, string> = {
  cyan: 'border-amber-200 bg-amber-50 text-amber-700',
  emerald: 'border-amber-200 bg-amber-50 text-amber-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  red: 'border-rose-200 bg-rose-50 text-rose-700',
  slate: 'border-stone-200 bg-stone-100 text-stone-700',
  violet: 'border-amber-200 bg-amber-50 text-amber-700',
}

export default function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${toneClasses[tone]}`}>
      {children}
    </span>
  )
}

export function verdictTone(verdict: string): Tone {
  if (verdict.includes('Buy')) return 'emerald'
  if (verdict.includes('Trim')) return 'red'
  return 'amber'
}

export function trackTone(track: string): Tone {
  if (track === 'Both') return 'violet'
  if (track === 'A') return 'cyan'
  if (track === 'B') return 'emerald'
  return 'slate'
}
