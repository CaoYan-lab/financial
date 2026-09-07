import { BarChart3, Bell, Bot, Brain, DatabaseZap, FileText, Loader2, Play, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LongbridgeMetric, LongbridgePosition } from '../../shared/longbridgeTypes'
import { useLongbridgeWorkbench } from '@/hooks/useLongbridgeWorkbench'
import LongbridgeWorkbenchNav from './longbridge/LongbridgeWorkbenchNav'

export default function LongbridgeWorkbenchPlaceholder() {
  const { dashboard, loading, error, refresh } = useLongbridgeWorkbench()
  const authReady = dashboard?.sourceStatus.authStatus === 'authenticated'

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.22),transparent_28rem),radial-gradient(circle_at_top_right,rgba(99,102,241,0.18),transparent_30rem),linear-gradient(135deg,#f8fafc_0%,#edf7ff_48%,#f5f3ff_100%)] text-slate-950">
      <div className="mx-auto w-full max-w-7xl px-6 py-10">
        <LongbridgeWorkbenchNav />

        <section className="rounded-[2rem] border border-sky-200 bg-white/85 p-7 shadow-xl shadow-slate-900/10 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="max-w-3xl">
              <span className="inline-flex items-center rounded-full bg-sky-100 px-3 py-1.5 text-xs font-black tracking-[0.2em] text-sky-700">
                长桥 · 独立数据适配器
              </span>
              <h1 className="mt-5 text-5xl font-black tracking-[-0.06em] text-slate-950 md:text-6xl">
                长桥量化交易工作台
              </h1>
              <p className="mt-5 text-lg leading-8 text-slate-600">
                界面结构对齐 Futu 工作台，但数据链路完全独立：行情、K 线、盘口、持仓、账户和订单能力只从 Longbridge Skill / CLI / MCP Adapter 进入。
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-3">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-900/15 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={refresh}
                disabled={loading}
              >
                {loading ? <Loader2 className="mr-2 animate-spin" size={16} /> : <RefreshCw className="mr-2" size={16} />}
                刷新长桥数据
              </button>
              <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${authReady ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                {authReady ? '账户授权已就绪，真实数据可用' : '等待长桥账户授权'}
              </div>
            </div>
          </div>
        </section>

        {error ? <Notice tone="rose" title="Longbridge 加载失败" content={error} /> : null}
        {dashboard?.warnings.length ? <Notice tone="amber" title="当前限制" content={dashboard.warnings.join(' / ')} /> : null}

        <section className="mt-6 grid gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            <Panel id="account" title="账户资产" icon={WalletCards} subtitle="账户资产与组合总览">
              <MetricGrid metrics={dashboard?.accountMetrics ?? skeletonMetrics('账户')} />
            </Panel>

            <Panel id="positions" title="持仓" icon={BarChart3} subtitle="证券持仓明细">
              <PositionsTable positions={dashboard?.positions ?? []} loading={loading} accountReady={Boolean(dashboard?.sourceStatus.accountDataAvailable)} />
            </Panel>

            <Panel id="risk" title="风险暴露" icon={ShieldCheck} subtitle="长桥独立风控上下文">
              <MetricGrid metrics={dashboard?.riskCards ?? skeletonMetrics('风险')} />
            </Panel>

            <Panel id="data-source" title="数据源" icon={DatabaseZap} subtitle="长桥能力与授权状态">
              <MetricGrid metrics={dashboard?.dataPanels ?? skeletonMetrics('数据源')} />
            </Panel>
          </div>

          <div className="space-y-6">
            <Panel id="research" title="研究机会" icon={Brain} subtitle="行情、研究与基本面">
              <MetricGrid metrics={dashboard?.researchPanels ?? skeletonMetrics('研究')} />
              <PanelLink to="/longbridge/opportunities" label="查看长桥机会历史" />
            </Panel>

            <Panel id="report-center" title="报告中心" icon={FileText} subtitle="长桥独立投研报告">
              <EmptyState title="等待接入 Longbridge 报告生成" description="第一版先完成独立工作台和 Adapter，报告历史不会读取 Futu 数据。" />
              <PanelLink to="/longbridge/reports" label="进入长桥报告中心" />
            </Panel>

            <Panel id="watchlist" title="自选与观察" icon={Bell} subtitle="自选股与价格提醒">
              <EmptyState title="等待授权后同步自选" description="自选、提醒属于 Longbridge 账户能力，后续变更操作必须先预览并确认。" />
              <PanelLink to="/longbridge/top30-prompt" label="查看长桥策略 Prompt" />
            </Panel>

            <Panel id="live-trading" title="实盘量化" icon={Bot} subtitle="长桥实盘评估入口">
              <MetricGrid metrics={dashboard?.tradingPanels ?? skeletonMetrics('交易')} />
              <Link
                className="mt-4 inline-flex items-center rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-2 text-sm font-black text-white shadow-sm shadow-sky-200/70 hover:from-sky-400 hover:to-indigo-400"
                to="/longbridge/live-trading"
              >
                <Play className="mr-2" size={16} />
                进入长桥实盘量化
              </Link>
            </Panel>
          </div>
        </section>
      </div>
    </main>
  )
}

function Panel({
  id,
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  id?: string
  title: string
  subtitle: string
  icon: typeof WalletCards
  children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-28 rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.2em] text-sky-700">{subtitle}</p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-slate-950">{title}</h2>
        </div>
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-cyan-200 to-indigo-300 text-slate-950">
          <Icon size={22} />
        </span>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

function MetricGrid({ metrics }: { metrics: LongbridgeMetric[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {metrics.map((metric) => (
        <article key={`${metric.label}:${metric.helper}`} className="rounded-2xl border border-slate-100 bg-slate-50/80 p-4">
          <p className="text-xs font-bold text-slate-500">{metric.label}</p>
          <p className="mt-2 break-words text-2xl font-black tracking-[-0.04em] text-slate-950">{metric.value}</p>
          <p className="mt-2 break-words text-xs leading-5 text-slate-500">{metric.helper}</p>
        </article>
      ))}
    </div>
  )
}

function PanelLink({ to, label }: { to: string; label: string }) {
  return (
    <Link className="mt-4 inline-flex rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-black text-sky-700 hover:bg-sky-100" to={to}>
      {label}
    </Link>
  )
}

function PositionsTable({ positions, loading, accountReady }: { positions: LongbridgePosition[]; loading: boolean; accountReady: boolean }) {
  if (loading) return <EmptyState title="正在读取长桥账户" description="加载 SDK 授权状态和账户数据。" />
  if (!accountReady) return <EmptyState title="持仓未授权" description="长桥账户授权或持仓读取权限不可用。" />
  if (!positions.length) return <EmptyState title="暂无持仓" description="长桥持仓接口已授权并返回成功，当前账户没有股票持仓。" />

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">标的</th>
            <th className="px-4 py-3">数量</th>
            <th className="px-4 py-3">市值</th>
            <th className="px-4 py-3">盈亏</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white/70">
          {positions.map((position) => (
            <tr key={`${position.symbol}:${position.name}`}>
              <td className="px-4 py-3">
                <p className="font-black text-slate-950">{position.symbol}</p>
                <p className="text-xs text-slate-500">{position.name}</p>
              </td>
              <td className="px-4 py-3 font-semibold text-slate-700">{position.quantity}</td>
              <td className="px-4 py-3 font-semibold text-slate-700">{position.marketValue}</td>
              <td className="px-4 py-3 font-semibold text-slate-700">{position.unrealizedPnL}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-sm">
      <p className="font-black text-slate-800">{title}</p>
      <p className="mt-2 leading-6 text-slate-500">{description}</p>
    </div>
  )
}

function Notice({ title, content, tone }: { title: string; content: string; tone: 'amber' | 'rose' }) {
  const className =
    tone === 'rose'
      ? 'mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700'
      : 'mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700'
  return (
    <div className={className}>
      <span className="font-black">{title}：</span>
      {content}
    </div>
  )
}

function skeletonMetrics(prefix: string): LongbridgeMetric[] {
  return [
    { label: `${prefix}状态`, value: '加载中', helper: 'Longbridge Adapter' },
    { label: '数据来源', value: 'CLI / Skill / MCP', helper: '独立于 Futu' },
  ]
}
