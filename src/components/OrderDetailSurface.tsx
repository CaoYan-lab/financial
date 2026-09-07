import type { ReactNode } from 'react'

export type OrderDetailAccent = 'amber' | 'sky'

const themes = {
  amber: {
    border: 'border-orange-200',
    eyebrow: 'text-orange-700',
    shadow: 'shadow-rose-200/20',
  },
  sky: {
    border: 'border-sky-200',
    eyebrow: 'text-sky-700',
    shadow: 'shadow-sky-200/20',
  },
} satisfies Record<OrderDetailAccent, Record<string, string>>

export function OrderDetailPanel({
  accent,
  eyebrow,
  title,
  action,
  children,
  className = '',
}: {
  accent: OrderDetailAccent
  eyebrow?: string
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  const theme = themes[accent]
  return (
    <section className={`min-w-0 rounded-3xl border bg-white/90 p-6 shadow-lg backdrop-blur ${theme.border} ${theme.shadow} ${className}`}>
      {eyebrow || title || action ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {eyebrow ? <p className={`text-xs font-semibold tracking-[0.25em] ${theme.eyebrow}`}>{eyebrow}</p> : null}
            {title ? <h2 className={`${eyebrow ? 'mt-2' : ''} text-xl font-semibold`}>{title}</h2> : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className={eyebrow || title || action ? 'mt-5' : ''}>{children}</div>
    </section>
  )
}

export function OrderDetailFieldGrid({
  accent,
  children,
  columns = 'sm:grid-cols-2',
}: {
  accent: OrderDetailAccent
  children: ReactNode
  columns?: string
}) {
  return (
    <div className={`grid overflow-hidden rounded-2xl border bg-white ${themes[accent].border} ${columns}`}>
      {children}
    </div>
  )
}

export function OrderDetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 border-b border-r border-stone-200 p-4">
      <p className="text-xs font-semibold text-stone-500">{label}</p>
      <div className="mt-1 break-words text-sm font-semibold text-stone-950">{value || '无'}</div>
    </div>
  )
}

export function OrderDetailTable({
  accent,
  title,
  headers,
  rows,
  emptyText = '暂无记录。',
  minWidth = 'min-w-[760px]',
}: {
  accent: OrderDetailAccent
  title: string
  headers: string[]
  rows: ReactNode[][]
  emptyText?: string
  minWidth?: string
}) {
  return (
    <OrderDetailPanel accent={accent} title={title}>
      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white">
        <table className={`w-full ${minWidth} text-left text-sm`}>
          <thead className="bg-stone-50 text-xs text-stone-500">
            <tr>
              {headers.map((header) => <th key={header} className="px-4 py-3">{header}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-200">
            {rows.map((row, index) => (
              <tr key={index} className="transition hover:bg-stone-50">
                {row.map((value, cell) => <td key={cell} className="px-4 py-3">{value || '无'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="p-5 text-sm text-stone-500">{emptyText}</p> : null}
      </div>
    </OrderDetailPanel>
  )
}
