import type { UiLanguage } from '@/stores/uiStore'
import { displayValue, profitTone } from '@/utils/displayText'

type Props = {
  value: unknown
  language: UiLanguage
  variant?: 'text' | 'pill'
}

const toneClass = {
  profit: {
    text: 'text-rose-700',
    pill: 'border-rose-200 bg-rose-50 text-rose-700',
  },
  loss: {
    text: 'text-amber-700',
    pill: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  neutral: {
    text: 'text-stone-600',
    pill: 'border-stone-200 bg-stone-50 text-stone-600',
  },
}

export default function ProfitValue({ value, language, variant = 'text' }: Props) {
  const tone = profitTone(value)
  const shownValue = displayValue(value, language)

  if (variant === 'pill') {
    return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums ${toneClass[tone].pill}`}>{shownValue}</span>
  }

  return <span className={`font-semibold tabular-nums ${toneClass[tone].text}`}>{shownValue}</span>
}
