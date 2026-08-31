import { Link } from 'react-router-dom'
import { Bot, PlayCircle } from 'lucide-react'
import Badge from '@/components/common/Badge'
import { useUiStore } from '@/stores/uiStore'

export default function SimulationTradingPanel() {
  const language = useUiStore((state) => state.language)

  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '模拟盘' : 'Paper Trading'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? 'Futu 模拟盘量化交易' : 'Futu Paper Quant Trading'}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {language === 'zh'
              ? '使用 Futu SIMULATE 账户和用户票池实时回调运行大模型自主正股/ETF交易；仅模拟交易，不触碰真实账户。'
              : 'Run LLM autonomous stock/ETF trading with Futu SIMULATE accounts and user-universe realtime callbacks; no real-money orders.'}
          </p>
        </div>
        <span className="rounded-2xl bg-amber-50 p-3 text-amber-700">
          <Bot size={24} />
        </span>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Badge tone="violet">SIMULATE</Badge>
        <Badge tone="cyan">{language === 'zh' ? '用户票池' : 'User Universe'}</Badge>
        <Badge tone="emerald">{language === 'zh' ? '买入/卖空/平仓' : 'Long / Short / Close'}</Badge>
      </div>
      <Link className="mt-5 inline-flex items-center rounded-2xl bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-950 shadow-sm hover:bg-stone-100" to="/simulation">
        <PlayCircle className="mr-2" size={16} />
        {language === 'zh' ? '进入模拟盘' : 'Open Paper Trading'}
      </Link>
    </section>
  )
}
