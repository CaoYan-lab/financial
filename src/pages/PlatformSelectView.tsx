import type { ReactNode } from 'react'
import { ArrowRight, BadgeCheck, Building2, Languages, LineChart } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useUiStore } from '@/stores/uiStore'

const text = {
  zh: {
    brandTitle: '量化交易工作台',
    brandSubtitle: '平台入口 · 账户 · 行情 · 策略 · 风控',
    platformSelector: '平台选择',
    switchLanguage: '切换英文',
    eyebrow: '平台选择',
    heroTitle: '选择交易平台，进入对应量化工作区',
    heroCopy: '现有金融助手工作台归入 Futu；Longbridge 已作为独立平台接入，账户、行情、订单和风控语义保持隔离。',
    futu: {
      title: 'Futu 量化交易工作台',
      status: '已接入',
      description: '现有金融助手工作台，将作为 Futu 平台点进去后的 Web 应用入口。',
      detail: 'Futu OpenD 行情、账户资产、持仓、研究报告、实盘确认队列和模拟盘集中管理。',
      capabilities: ['账户资产', '持仓与盈亏', 'Futu OpenD 行情', '实盘人工确认', '模拟盘', '研究报告'],
      cta: '进入 Futu 工作台',
    },
    longbridge: {
      title: 'Longbridge 量化交易工作台',
      status: '已接入',
      description: '长桥证券量化能力入口，支持独立平台工作区。',
      detail: '已接入 Longbridge 行情、账户、持仓、订单、策略执行和风控队列，不混入 Futu 工作台。',
      capabilities: ['行情接入', '账户资产', '持仓同步', '订单与成交', '策略执行', '风控队列'],
      cta: '进入 Longbridge 工作台',
    },
    ashare: {
      title: 'Futu A股量化工作台',
      status: '新增入口',
      description: '使用 Futu OpenD 查询和订阅沪深 A 股，但作为独立市场入口，不放进现有 Futu 美股/港股工作台。',
      detail: '手动查询真实 SH/SZ 订阅代码，点击 + 后进入 A 股股票池；只多头、CNY 口径、午休/收盘自动跳过 LLM。',
      capabilities: ['SH/SZ 查询', '独立股票池', '逐笔成交', '1m K线', '只多头风控', '候选池'],
      cta: '进入 A股工作台',
    },
    routeLabel: '入口路径',
  },
  en: {
    brandTitle: 'Quant Trading Workbench',
    brandSubtitle: 'Platform · Account · Market Data · Strategy · Risk',
    platformSelector: 'Platform Selector',
    switchLanguage: '切换中文',
    eyebrow: 'Platform Selector',
    heroTitle: 'Choose a trading platform and enter its quant workspace',
    heroCopy: 'The existing financial assistant workbench belongs to Futu. Longbridge is now connected as a separate platform so account, market data, orders and risk controls stay clearly separated.',
    futu: {
      title: 'Futu Quant Workbench',
      status: 'Connected',
      description: 'The existing financial assistant workbench becomes the Web app behind the Futu platform entry.',
      detail: 'Manage Futu OpenD market data, account assets, positions, research reports, live order review and paper trading in one workspace.',
      capabilities: ['Account assets', 'Positions and P/L', 'Futu OpenD data', 'Live order review', 'Paper trading', 'Research reports'],
      cta: 'Enter Futu Workbench',
    },
    longbridge: {
      title: 'Longbridge Quant Workbench',
      status: 'Connected',
      description: 'A dedicated entry for Longbridge quant trading capabilities.',
      detail: 'Longbridge market data, account, positions, orders, strategy execution and risk queues are integrated independently from Futu.',
      capabilities: ['Market data', 'Account assets', 'Position sync', 'Orders and fills', 'Strategy execution', 'Risk queue'],
      cta: 'Enter Longbridge Workbench',
    },
    ashare: {
      title: 'Futu A-share Quant Workbench',
      status: 'New Entry',
      description: 'Query and subscribe Shanghai/Shenzhen A-shares through Futu OpenD as an isolated market workspace.',
      detail: 'Manually validate real SH/SZ subscription codes, add them to the A-share universe, and evaluate long-only CNY strategies only during regular sessions.',
      capabilities: ['SH/SZ lookup', 'Isolated universe', 'Trade ticks', '1m bars', 'Long-only risk', 'Candidate pool'],
      cta: 'Enter A-share Workbench',
    },
    routeLabel: 'Entry route',
  },
}

export default function PlatformSelectView() {
  const { language, toggleLanguage } = useUiStore()
  const copy = text[language]

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.24),transparent_30rem),radial-gradient(circle_at_top_right,rgba(34,211,238,0.2),transparent_28rem),linear-gradient(135deg,#fffaf0_0%,#f8fafc_54%,#eef6ff_100%)] text-stone-950">
      <div className="mx-auto w-full max-w-7xl px-6 py-10">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-amber-500 to-rose-400 text-lg font-black text-stone-950 shadow-sm shadow-orange-200">
              量
            </span>
            <div>
              <p className="text-lg font-black tracking-tight text-stone-950">{copy.brandTitle}</p>
              <p className="text-sm text-stone-500">{copy.brandSubtitle}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-stone-200 bg-white/80 px-4 py-2 text-sm font-bold text-stone-600 shadow-sm backdrop-blur">
              {copy.platformSelector}
            </span>
            <button
              className="inline-flex items-center rounded-2xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700 shadow-sm hover:bg-orange-100"
              onClick={toggleLanguage}
              type="button"
            >
              <Languages className="mr-2" size={16} />
              {copy.switchLanguage}
            </button>
          </div>
        </header>

        <section className="max-w-3xl">
          <p className="inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-black tracking-[0.24em] text-orange-700">
            {copy.eyebrow}
          </p>
          <h1 className="mt-5 text-5xl font-black tracking-[-0.06em] text-slate-950 md:text-7xl">
            {copy.heroTitle}
          </h1>
          <p className="mt-5 text-lg leading-8 text-stone-600">
            {copy.heroCopy}
          </p>
        </section>

        <section className="mt-9 grid gap-6 lg:grid-cols-2" aria-label="交易平台入口">
          <PlatformCard
            title={copy.futu.title}
            status={copy.futu.status}
            statusClassName="bg-emerald-100 text-emerald-700"
            icon={<BadgeCheck size={28} />}
            iconClassName="bg-gradient-to-br from-amber-400 to-rose-400 text-stone-950"
            cardClassName="border-orange-200/80 bg-white/80"
            glowClassName="from-orange-200/70 via-rose-100/70 to-transparent"
            description={copy.futu.description}
            detail={copy.futu.detail}
            capabilities={copy.futu.capabilities}
            to="/futu"
            cta={copy.futu.cta}
            routeLabel={copy.routeLabel}
            route="/futu"
          />

          <PlatformCard
            title={copy.longbridge.title}
            status={copy.longbridge.status}
            statusClassName="bg-emerald-100 text-emerald-700"
            icon={<Building2 size={28} />}
            iconClassName="bg-gradient-to-br from-cyan-300 to-indigo-400 text-slate-950"
            cardClassName="border-sky-200/80 bg-white/80"
            glowClassName="from-cyan-100/80 via-indigo-100/70 to-transparent"
            description={copy.longbridge.description}
            detail={copy.longbridge.detail}
            capabilities={copy.longbridge.capabilities}
            to="/longbridge"
            cta={copy.longbridge.cta}
            routeLabel={copy.routeLabel}
            route="/longbridge"
          />

          <PlatformCard
            title={copy.ashare.title}
            status={copy.ashare.status}
            statusClassName="bg-orange-100 text-orange-700"
            icon={<LineChart size={28} />}
            iconClassName="bg-gradient-to-br from-amber-400 to-orange-500 text-stone-950"
            cardClassName="border-orange-200/80 bg-white/80"
            glowClassName="from-amber-100/80 via-orange-100/70 to-transparent"
            description={copy.ashare.description}
            detail={copy.ashare.detail}
            capabilities={copy.ashare.capabilities}
            to="/a-share"
            cta={copy.ashare.cta}
            routeLabel={copy.routeLabel}
            route="/a-share"
          />
        </section>
      </div>
    </main>
  )
}

function PlatformCard({
  title,
  status,
  statusClassName,
  icon,
  iconClassName,
  cardClassName,
  glowClassName,
  description,
  detail,
  capabilities,
  to,
  cta,
  routeLabel,
  route,
}: {
  title: string
  status: string
  statusClassName: string
  icon: ReactNode
  iconClassName: string
  cardClassName: string
  glowClassName: string
  description: string
  detail: string
  capabilities: string[]
  to: string
  cta: string
  routeLabel: string
  route: string
}) {
  return (
    <article className={`group relative min-h-[520px] overflow-hidden rounded-[2rem] border p-7 shadow-xl shadow-slate-900/10 backdrop-blur transition hover:-translate-y-1 hover:shadow-2xl ${cardClassName}`}>
      <div className={`absolute inset-x-0 top-0 h-56 bg-gradient-to-br ${glowClassName}`} />
      <div className="relative flex min-h-[464px] flex-col">
        <div className="mb-7 flex items-start justify-between gap-4">
          <span className={`grid h-16 w-16 place-items-center rounded-3xl shadow-inner ${iconClassName}`}>{icon}</span>
          <span className={`rounded-full px-3 py-1.5 text-xs font-black ${statusClassName}`}>{status}</span>
        </div>
        <h2 className="text-4xl font-black tracking-[-0.05em] text-slate-950">{title}</h2>
        <p className="mt-5 text-base font-semibold leading-7 text-stone-700">{description}</p>
        <p className="mt-3 text-sm leading-7 text-stone-500">{detail}</p>
        <ul className="mt-7 grid grid-cols-2 gap-3">
          {capabilities.map((item) => (
            <li key={item} className="rounded-2xl border border-stone-200/80 bg-white/70 px-3 py-3 text-sm font-bold text-stone-700">
              {item}
            </li>
          ))}
        </ul>
        <div className="mt-auto flex flex-wrap items-center gap-3 pt-8">
          <Link className="inline-flex items-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-900/15 transition group-hover:bg-stone-800" to={to}>
            {cta}
            <ArrowRight className="ml-2" size={16} />
          </Link>
          <span className="text-sm font-bold text-stone-500">{routeLabel}: {route}</span>
        </div>
      </div>
    </article>
  )
}
