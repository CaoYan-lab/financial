import { Link } from 'react-router-dom'
import { PlayCircle, ShieldAlert } from 'lucide-react'
import Badge from '@/components/common/Badge'
import { useUiStore } from '@/stores/uiStore'
import type { TradingEnvironmentStatus } from '../../../shared/types'

export default function LiveTradingPanel({ trading }: { trading?: TradingEnvironmentStatus }) {
  const language = useUiStore((state) => state.language)

  return (
    <section className="rounded-3xl border border-orange-200 bg-gradient-to-br from-orange-50 via-rose-50 to-rose-50 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">{language === 'zh' ? '实盘交易门禁' : 'Live Trading Gate'}</p>
          <h2 className="mt-2 flex items-center gap-2 text-2xl font-semibold text-stone-950">
            <ShieldAlert className="text-orange-500" size={24} />
            {language === 'zh' ? '实盘交易入口' : 'Live Trading Entry'}
          </h2>
          <p className="mt-2 text-sm text-orange-800">
            {language === 'zh'
              ? '实盘入口已升级为半自动队列：大模型生成候选订单，用户二次确认后才可能提交真实订单。'
              : 'The live entry now uses a semi-automated queue: LLM creates candidates, and real orders require explicit confirmation.'}
          </p>
        </div>
        <Badge tone="amber">{trading?.environment ?? 'UNKNOWN'}</Badge>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-orange-100 bg-white/75 p-4">
          <p className="text-xs font-semibold text-orange-700">{language === 'zh' ? '待确认队列' : 'Pending Queue'}</p>
          <p className="mt-1 text-lg font-bold text-stone-950">{language === 'zh' ? '人工确认' : 'Manual confirm'}</p>
        </div>
        <div className="rounded-2xl border border-orange-100 bg-white/75 p-4">
          <p className="text-xs font-semibold text-orange-700">{language === 'zh' ? '模型配置' : 'Model Config'}</p>
          <p className="mt-1 text-lg font-bold text-stone-950">ARK / GLM</p>
        </div>
        <div className="rounded-2xl border border-orange-100 bg-white/75 p-4">
          <p className="text-xs font-semibold text-orange-700">{language === 'zh' ? '费用' : 'Fees'}</p>
          <p className="mt-1 text-lg font-bold text-stone-950">{language === 'zh' ? '成交后回填' : 'Post-trade'}</p>
        </div>
      </div>

      <Link className="mt-5 inline-flex items-center rounded-2xl bg-gradient-to-r from-orange-500 via-rose-500 to-rose-500 px-4 py-2 text-sm font-semibold text-stone-950 shadow-sm shadow-rose-200/60 hover:from-orange-400 hover:via-rose-400 hover:to-rose-400" to="/live-trading">
        <PlayCircle className="mr-2" size={16} />
        {language === 'zh' ? '进入实盘量化' : 'Open Live Trading'}
      </Link>
    </section>
  )
}
