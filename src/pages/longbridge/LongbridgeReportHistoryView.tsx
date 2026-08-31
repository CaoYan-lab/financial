import { Link } from 'react-router-dom'
import { FileText } from 'lucide-react'
import { LongbridgeEmptyCard, LongbridgePageShell } from './LongbridgePageShell'

export default function LongbridgeReportHistoryView() {
  return (
    <LongbridgePageShell
      eyebrow="Longbridge Reports"
      title="长桥研究报告中心"
      description="对应 Futu 的报告中心页面。后续报告生成只使用 Longbridge market-data / research / fundamentals / content，不读取 Futu 报告历史。"
    >
      <section className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-sm backdrop-blur">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.22em] text-sky-700">报告归档</p>
            <h2 className="mt-2 text-2xl font-black text-slate-950">Longbridge 独立报告历史</h2>
          </div>
          <FileText className="text-sky-600" size={28} />
        </div>
        <div className="mt-5">
          <LongbridgeEmptyCard title="暂无长桥报告" description="当前不会展示 Futu /reports 历史。接入 Longbridge 报告生成后，报告会写入独立归档。" />
        </div>
        <Link className="mt-5 inline-flex rounded-2xl border border-sky-200 bg-sky-50 px-5 py-3 text-sm font-black text-sky-700 hover:bg-sky-100" to="/longbridge/reports/preview">
          查看报告详情页占位
        </Link>
      </section>
    </LongbridgePageShell>
  )
}
