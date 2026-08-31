import AshareInstrumentLookupPanel from '@/components/ashare/AshareInstrumentLookupPanel'
import AshareWorkbenchNav from '@/components/ashare/AshareWorkbenchNav'
import Badge from '@/components/common/Badge'
import { useAshareWorkbench } from '@/hooks/ashare/useAshareWorkbench'

export default function AshareWorkbenchView() {
  const { dashboard, loading, runningAction, error, refresh, start, stop, runOnce } = useAshareWorkbench()
  const engineRunning = Boolean(dashboard?.engine.running)

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <AshareWorkbenchNav className="mb-0" />
        <section className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.24em] text-orange-700">Futu A股量化交易工作台</p>
              <h1 className="mt-3 text-4xl font-black tracking-[-0.04em] text-stone-950 md:text-5xl">
                Futu A股量化交易工作台
              </h1>
              <p className="mt-4 max-w-4xl text-sm leading-6 text-stone-600">
                沪深 A 股查询、独立股票池、Futu OpenD 行情订阅、连续竞价 Gate 和只多头风控独立运行，不写入现有 Futu / Longbridge 数据。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone={engineRunning ? 'emerald' : 'amber'}>{engineRunning ? 'A股评估运行中' : 'A股评估已停止'}</Badge>
              <Badge tone={dashboard?.session.shouldSkipLlm ? 'red' : 'emerald'}>{dashboard?.session.session ?? '加载中'}</Badge>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-black text-white hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60" disabled={runningAction || engineRunning} onClick={start} type="button">
              {runningAction ? '请求中...' : '启动 A股评估'}
            </button>
            <button className="rounded-2xl bg-white px-4 py-2 text-sm font-black text-stone-800 ring-1 ring-orange-200 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={runningAction || !engineRunning} onClick={stop} type="button">停止</button>
            <button className="rounded-2xl bg-white px-4 py-2 text-sm font-black text-stone-800 ring-1 ring-orange-200 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={runningAction} onClick={runOnce} type="button">单轮评估</button>
            <button className="rounded-2xl bg-white px-4 py-2 text-sm font-black text-stone-800 ring-1 ring-orange-200 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={loading} onClick={refresh} type="button">{loading ? '刷新中...' : '刷新'}</button>
          </div>
          {dashboard?.engine.lastError ? <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{dashboard.engine.lastError}</p> : null}
          {error ? <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p> : null}
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <AshareInstrumentLookupPanel onUniverseUpdated={refresh} />
          <section id="universe" className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
            <p className="text-xs font-black uppercase tracking-[0.24em] text-orange-700">A股股票池 / 行情</p>
            <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">独立股票池状态</h2>
            <div className="mt-5 grid gap-3">
              {(dashboard?.readiness ?? []).length ? dashboard?.readiness.map((item) => (
                <article key={item.ticker} className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-mono text-sm font-black text-stone-950">{item.ticker}</p>
                      <p className="mt-1 text-sm font-semibold text-stone-600">
                        {item.name} · 最新价 {item.lastPrice ?? '等待行情'}
                        {item.changePercent ? <span className={`ml-2 font-black ${item.changePercent.startsWith('-') ? 'text-emerald-600' : 'text-rose-600'}`}>今日 {item.changePercent}</span> : null}
                      </p>
                    </div>
                    <Badge tone={item.quoteReady && item.klineBars >= 120 && item.tickerPoints > 0 ? 'emerald' : 'amber'}>
                      {item.quoteReady ? '行情接入' : '等待行情'}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs font-bold text-stone-600 sm:grid-cols-3 lg:grid-cols-6">
                    <span>Quote: {item.quoteReady ? 'OK' : '-'}</span>
                    <span>涨跌: {item.change ?? '-'}</span>
                    <span>涨跌幅: {item.changePercent ?? '-'}</span>
                    <span>Ticker: {item.tickerPoints}</span>
                    <span>K线: {item.klineBars}</span>
                    <span>盘口: {item.orderBookReady ? 'OK' : '-'}</span>
                  </div>
                </article>
              )) : <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3 text-sm font-semibold text-stone-600">暂无 A 股标的。先查询真实 Futu 代码，再点击 + 订阅进股票池。</p>}
            </div>
          </section>
          <section id="risk" className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
            <p className="text-xs font-black uppercase tracking-[0.24em] text-orange-700">模块边界</p>
            <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">隔离约束</h2>
            <div className="mt-5 space-y-3 text-sm font-semibold text-stone-600">
              <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">不修改现有 Futu 工作台代码、样式、股票池或实盘引擎。</p>
              <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">不修改现有 Longbridge 工作台代码、样式、数据或实盘引擎。</p>
              <p className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-rose-700">A 股第一版只多头，禁止 SELL_SHORT。</p>
              <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">{dashboard?.session.reason ?? '当前处于 A 股连续竞价时段，可进入行情准备检查。'}</p>
            </div>
          </section>
          <section id="market-data" className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
            <p className="text-xs font-black uppercase tracking-[0.24em] text-orange-700">订阅服务</p>
            <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">Futu OpenD A股订阅</h2>
            <div className="mt-5 grid gap-3 text-sm font-semibold text-stone-600">
              <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">进程：{dashboard?.realtime.running ? '运行中' : '未运行'}</p>
              <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">订阅标的：{dashboard?.realtime.subscribedTickers.join(', ') || '无'}</p>
              <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">最近事件：{dashboard?.realtime.lastEventAt || '暂无'}</p>
              {dashboard?.realtime.lastError ? <p className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-rose-700">{dashboard.realtime.lastError}</p> : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
