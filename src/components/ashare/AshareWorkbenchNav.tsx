import { ArrowLeft, ArrowRight, Languages } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useUiStore, type UiLanguage } from '@/stores/uiStore'

const tabs = [
  { to: '/a-share', zh: '工作台', en: 'Workbench' },
  { to: '/a-share#lookup', zh: '查询订阅', en: 'Lookup' },
  { to: '/a-share#universe', zh: '股票池', en: 'Universe' },
  { to: '/a-share#market-data', zh: '行情', en: 'Market Data' },
  { to: '/a-share#risk', zh: '风控规则', en: 'Risk Rules' },
  { to: '/a-share/live-trading', zh: '实盘入口', en: 'Live Trading' },
]

export default function AshareWorkbenchNav({ className = 'mb-6' }: { className?: string }) {
  const location = useLocation()
  const { language, toggleLanguage } = useUiStore()

  return (
    <div className={className}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <Link className="inline-flex items-center rounded-2xl border border-orange-200 bg-white/80 px-4 py-2 text-sm font-bold text-stone-700 shadow-sm hover:bg-white" to="/">
          <ArrowLeft className="mr-2" size={16} />
          {copy(language, '返回平台选择', 'Back to Platforms')}
        </Link>
        <div className="flex flex-wrap gap-2">
          <Link className="inline-flex items-center rounded-2xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-bold text-orange-700 shadow-sm hover:bg-orange-100" to="/futu">
            {copy(language, '进入 Futu 工作台', 'Enter Futu')}
            <ArrowRight className="ml-2" size={16} />
          </Link>
          <Link className="inline-flex items-center rounded-2xl border border-sky-200 bg-white px-4 py-2 text-sm font-bold text-sky-700 shadow-sm hover:bg-sky-50" to="/longbridge">
            {copy(language, '进入 Longbridge', 'Enter Longbridge')}
            <ArrowRight className="ml-2" size={16} />
          </Link>
          <button className="inline-flex items-center rounded-2xl border border-orange-200 bg-white px-4 py-2 text-sm font-bold text-orange-700 hover:bg-orange-50" onClick={toggleLanguage} type="button">
            <Languages className="mr-2" size={16} />
            {language === 'zh' ? '切换英文' : '切换中文'}
          </button>
        </div>
      </header>

      <nav className="rounded-3xl border border-orange-100 bg-white/80 px-4 py-3 shadow-sm backdrop-blur" aria-label={copy(language, 'A股工作台导航', 'A-share workbench navigation')}>
        <div className="flex max-w-full gap-2 overflow-x-auto py-1 text-sm">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              className={`whitespace-nowrap rounded-2xl px-3 py-2 font-semibold transition ${
                isActive(location.pathname, location.hash, tab.to)
                  ? 'bg-orange-500 text-white shadow-sm shadow-orange-200'
                  : 'text-stone-600 hover:bg-orange-50 hover:text-orange-800'
              }`}
              to={tab.to}
            >
              {tab[language]}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  )
}

function copy(language: UiLanguage, zh: string, en: string) {
  return language === 'zh' ? zh : en
}

function isActive(pathname: string, hash: string, target: string): boolean {
  const [targetPath, targetHash] = target.split('#')
  if (targetHash) return pathname === targetPath && hash === `#${targetHash}`
  if (target === '/a-share') return pathname === '/a-share' && !hash
  return pathname === target || pathname.startsWith(`${target}/`)
}
