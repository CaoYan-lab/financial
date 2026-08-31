import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, Database } from 'lucide-react'
import type { SourceStatusResponse } from '../../shared/types'
import { useUiStore } from '@/stores/uiStore'

type Props = {
  status?: SourceStatusResponse
}

export default function DataSourcePanel({ status }: Props) {
  const futuReady = status?.futuOpenDAvailable ?? false
  const language = useUiStore((state) => state.language)
  const [open, setOpen] = useState(false)

  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((current) => !current)}>
        <div className="flex items-center gap-3">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-amber-800">
            <Database size={22} />
          </div>
          <div>
            <p className="text-xs font-semibold tracking-[0.25em] text-amber-800">{language === 'zh' ? '数据源' : 'Data Sources'}</p>
            <h2 className="text-xl font-semibold text-stone-950">{language === 'zh' ? '数据源状态' : 'Source Status'}</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${futuReady ? 'bg-amber-50 text-amber-800' : 'bg-amber-50 text-amber-700'}`}>
            {language === 'zh' ? (futuReady ? '核心可用' : '待处理') : futuReady ? 'Core Ready' : 'Pending'}
          </span>
          <ChevronDown className={`text-stone-500 transition-transform ${open ? 'rotate-180' : ''}`} size={18} />
        </div>
      </button>

      {open ? (
        <>
          <div className="mt-6 space-y-3">
            <StatusRow label="Futu OpenD 连接" ok={futuReady} />
            <StatusRow label="Python SDK futu-api" ok={status?.futuPythonSdkAvailable ?? false} />
            <StatusRow label="OpenD 已手动登录" ok={status?.futuOpenDLoggedIn ?? false} />
            <StatusRow label="期权链 / IV 数据" ok={status?.optionsDataAvailable ?? false} />
            <StatusRow label="K 线 / 技术指标" ok={status?.technicalDataAvailable ?? false} />
            <StatusRow label="StockAnalysis Universe" ok={status?.universePrimaryAvailable ?? false} />
            <StatusRow label="CompaniesMarketCap Fallback" ok={status?.universeFallbackAvailable ?? false} />
          </div>

          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle size={16} />
              {language === 'zh' ? 'Futu OpenD 前置条件' : 'Futu OpenD Requirements'}
            </div>
            <p className="mt-2 text-amber-700">
              {language === 'zh'
                ? '请启动 Futu OpenD 并在 GUI 中手动登录。本应用只读取行情，不执行交易；不可取得的字段会标为不可用。'
                : 'Start Futu OpenD and log in manually in the GUI. This app reads data only and never places trades; unavailable fields stay marked as unavailable.'}
            </p>
          </div>

          {status?.missingCapabilities?.length ? (
            <ul className="mt-4 space-y-2 text-sm text-stone-600">
              {status.missingCapabilities.map((item) => (
                <li key={item} className="rounded-xl bg-stone-50 px-3 py-2">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  const language = useUiStore((state) => state.language)

  return (
    <div className="flex items-center justify-between rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
      <span className="text-sm text-stone-700">{label}</span>
      <span className={`flex items-center gap-2 text-xs font-semibold ${ok ? 'text-amber-800' : 'text-amber-700'}`}>
        <CheckCircle2 size={14} />
        {language === 'zh' ? (ok ? '就绪' : '待处理') : ok ? 'Ready' : 'Pending'}
      </span>
    </div>
  )
}
