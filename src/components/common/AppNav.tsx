import { Link, useLocation } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Languages } from 'lucide-react'
import { useUiStore } from '@/stores/uiStore'

const dashboardItems = [
  { href: '/futu', zh: '工作台', en: 'Workbench' },
  { href: '/futu#account', zh: '账户资产', en: 'Account' },
  { href: '/futu#positions', zh: '持仓', en: 'Positions' },
  { href: '/futu#risk', zh: '风险', en: 'Risk' },
  { href: '/futu#research', zh: '研究机会', en: 'Research' },
  { href: '/futu#report-center', zh: '报告中心', en: 'Reports' },
  { href: '/live-trading', zh: '实盘入口', en: 'Trading' },
  { href: '/simulation', zh: '模拟盘', en: 'Paper Trading' },
  { href: '/reports', zh: '报告历史', en: 'Report History' },
]

const reportItems = [
  { href: '#raw', zh: '纯数据表', en: 'Raw Data' },
  { href: '#top5', zh: 'Top 5 机会', en: 'Top 5' },
  { href: '#bottom5', zh: 'Bottom 5 风险', en: 'Bottom 5' },
  { href: '#remaining', zh: '其余股票', en: 'Remaining' },
  { href: '#quality', zh: '数据质量', en: 'Quality' },
  { href: '#markdown-source', zh: '源文件', en: 'Source' },
]

export default function AppNav({ variant = 'dashboard' }: { variant?: 'dashboard' | 'report' }) {
  const location = useLocation()
  const { language, toggleLanguage } = useUiStore()
  const items = variant === 'report' ? reportItems : dashboardItems

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-white/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-3">
        <Link className="inline-flex items-center rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:bg-white" to="/">
          <ArrowLeft className="mr-2" size={16} />
          {language === 'zh' ? '返回平台选择' : 'Back to Platforms'}
        </Link>
        <Link className="inline-flex items-center rounded-2xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-bold text-orange-700 shadow-sm hover:bg-orange-100" to="/longbridge">
          {language === 'zh' ? '进入长桥工作台' : 'Enter Longbridge'}
          <ArrowRight className="ml-2" size={16} />
        </Link>
      </div>

      <div className="border-t border-stone-200/70">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <Link to="/futu" className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 text-sm font-black text-stone-950 shadow-sm">
              金
            </span>
            <div>
              <p className="text-base font-bold text-stone-950">{language === 'zh' ? 'Futu 量化交易工作台' : 'Futu Quant Workbench'}</p>
              <p className="text-xs text-stone-500">{language === 'zh' ? 'Futu · 账户 · 持仓 · 研究 · 风控' : 'Futu · Account · Positions · Research · Risk'}</p>
            </div>
          </Link>

          <nav className="flex max-w-full gap-2 overflow-x-auto py-1 text-sm">
            {items.map((item) => (
              <NavLink key={item.href} href={item.href} active={isActive(location.pathname, location.hash, item.href)}>
                {item[language]}
              </NavLink>
            ))}
          </nav>

          <button
            className="inline-flex items-center rounded-2xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700 hover:bg-orange-100"
            onClick={toggleLanguage}
            type="button"
          >
            <Languages className="mr-2" size={16} />
            {language === 'zh' ? '切换英文' : '切换中文'}
          </button>
        </div>
      </div>
    </header>
  )
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: string }) {
  const className = `whitespace-nowrap rounded-2xl px-3 py-2 font-medium transition ${
    active ? 'bg-orange-500 text-white shadow-sm' : 'text-stone-600 hover:bg-amber-50 hover:text-stone-950'
  }`
  if (href.startsWith('#')) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    )
  }
  return (
    <Link className={className} to={href}>
      {children}
    </Link>
  )
}

function isActive(pathname: string, hash: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  if (href === '/futu') return pathname === '/futu'
  if (href === '/longbridge') return pathname === '/longbridge'
  if (href === '/reports') return pathname === '/reports' || pathname.startsWith('/reports/')
  if (href === '/live-trading') return pathname === '/live-trading' || pathname.startsWith('/live-trading/')
  if (href === '/simulation') return pathname === '/simulation'
  if (href.startsWith('#')) return hash === href
  if (href.includes('#')) {
    const [path, targetHash] = href.split('#')
    return pathname === path && hash === `#${targetHash}`
  }
  return false
}
