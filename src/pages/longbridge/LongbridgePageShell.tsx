import type { ReactNode } from 'react'
import LongbridgeWorkbenchNav from './LongbridgeWorkbenchNav'

export function LongbridgePageShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.22),transparent_28rem),radial-gradient(circle_at_top_right,rgba(99,102,241,0.18),transparent_30rem),linear-gradient(135deg,#f8fafc_0%,#edf7ff_48%,#f5f3ff_100%)] text-slate-950">
      <div className="mx-auto w-full max-w-7xl px-6 py-10">
        <LongbridgeWorkbenchNav />

        <section className="rounded-[2rem] border border-sky-200 bg-white/85 p-7 shadow-xl shadow-slate-900/10 backdrop-blur">
          <p className="text-xs font-black uppercase tracking-[0.22em] text-sky-700">{eyebrow}</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.05em] text-slate-950 md:text-6xl">{title}</h1>
          <p className="mt-4 max-w-4xl text-base leading-8 text-slate-600">{description}</p>
        </section>

        <div className="mt-6">{children}</div>
      </div>
    </main>
  )
}

export function LongbridgeEmptyCard({ title, description }: { title: string; description: string }) {
  return (
    <section className="rounded-3xl border border-dashed border-slate-200 bg-white/75 p-6 shadow-sm backdrop-blur">
      <p className="text-xl font-black text-slate-950">{title}</p>
      <p className="mt-2 text-sm leading-7 text-slate-600">{description}</p>
    </section>
  )
}
