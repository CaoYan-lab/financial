import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

const longbridgeTabs = [
  { to: '/longbridge', label: '工作台' },
  { to: '/longbridge#account', label: '账户资产' },
  { to: '/longbridge#positions', label: '持仓' },
  { to: '/longbridge#risk', label: '风险' },
  { to: '/longbridge#data-source', label: '数据源' },
  { to: '/longbridge#research', label: '研究机会' },
  { to: '/longbridge#report-center', label: '报告中心' },
  { to: '/longbridge#watchlist', label: '自选观察' },
  { to: '/longbridge/live-trading', label: '实盘入口' },
  { to: '/longbridge/reports', label: '报告历史' },
]

export default function LongbridgeWorkbenchNav({ className = 'mb-6' }: { className?: string }) {
  const location = useLocation()

  return (
    <div className={className}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <Link className="inline-flex items-center rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:bg-white" to="/">
          <ArrowLeft className="mr-2" size={16} />
          返回平台选择
        </Link>
        <Link className="inline-flex items-center rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-bold text-sky-700 shadow-sm hover:bg-sky-100" to="/futu">
          进入 Futu 工作台
          <ArrowRight className="ml-2" size={16} />
        </Link>
      </header>

      <nav className="rounded-3xl border border-sky-100 bg-white/80 px-4 py-3 shadow-sm backdrop-blur" aria-label="长桥工作台导航">
        <div className="flex max-w-full gap-2 overflow-x-auto py-1 text-sm">
          {longbridgeTabs.map((tab) => (
            <Link
              key={tab.to}
              className={`whitespace-nowrap rounded-2xl px-3 py-2 font-semibold transition ${
                isActive(location.pathname, location.hash, tab.to)
                  ? 'bg-sky-600 text-white shadow-sm shadow-sky-200'
                  : 'text-slate-600 hover:bg-sky-50 hover:text-sky-800'
              }`}
              to={tab.to}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  )
}

function isActive(pathname: string, hash: string, target: string): boolean {
  const [targetPath, targetHash] = target.split('#')
  if (targetHash) return pathname === targetPath && hash === `#${targetHash}`
  if (target === '/longbridge') return pathname === '/longbridge' && !hash
  if (target === '/longbridge/reports') return pathname === '/longbridge/reports' || pathname.startsWith('/longbridge/reports/')
  return pathname === target || pathname.startsWith(`${target}/`)
}
