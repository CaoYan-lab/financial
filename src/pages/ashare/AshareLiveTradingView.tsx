import { useMemo, type ReactNode } from 'react'
import AshareWorkbenchNav from '@/components/ashare/AshareWorkbenchNav'
import Badge from '@/components/common/Badge'
import TradeStrategyConfigPanel from '@/components/trading/TradeStrategyConfigPanel'
import { useAshareWorkbench, type AShareDashboardResponse, type AShareTradingAgentLlmConfig, type AShareTradingAgentLlmPreset, type UpdateAshareTradingAgentLlmConfigRequest } from '@/hooks/ashare/useAshareWorkbench'
import { useUiStore, type UiLanguage } from '@/stores/uiStore'
import type {
  LiveCandidatePoolHistoryFilter,
  LiveCandidatePoolItem,
  LiveOrderFeeContext,
  LivePendingOrder,
  LivePendingOrderSideFilter,
  LivePendingOrderStatusFilter,
  LiveCandidatePoolSnapshot,
  LiveSignalDirectionFilter,
  LiveSignalHistoryItem,
  LiveSignalLifecycleFilter,
  LlmModelOption,
  LlmRuntimeConfig,
  SimulationHistoryPage,
  UpdateLlmRuntimeConfigRequest,
  UpdateTradeStrategyConfigRequest,
} from '../../../shared/types'

const PENDING_STATUS_FILTERS: Array<{ value: LivePendingOrderStatusFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'PENDING_CONFIRMATION', label: '待确认' },
  { value: 'CONFIRMED_SUBMITTING', label: '提交中' },
  { value: 'SUBMITTED', label: '已提交' },
  { value: 'REJECTED_BY_USER', label: '已拒绝' },
  { value: 'EXPIRED', label: '已过期' },
  { value: 'SUBMIT_FAILED', label: '提交失败' },
  { value: 'BLOCKED_BY_RISK', label: '风控关闭' },
]

const A_SHARE_PENDING_SIDE_FILTERS: Array<{ value: LivePendingOrderSideFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'BUY', label: '买入' },
  { value: 'SELL_TO_CLOSE', label: '平仓卖出' },
]

const SIGNAL_LIFECYCLE_FILTERS: Array<{ value: LiveSignalLifecycleFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'HOLD', label: '观望' },
  { value: 'CANDIDATE_POOL', label: '候选池中' },
  { value: 'PENDING_CONFIRMATION', label: '待确认' },
  { value: 'CONFIRMED_SUBMITTING', label: '提交中' },
  { value: 'SUBMITTED', label: '已提交' },
  { value: 'REJECTED_BY_USER', label: '已拒绝' },
  { value: 'EXPIRED', label: '已过期' },
  { value: 'SUBMIT_FAILED', label: '提交失败' },
  { value: 'SKIPPED', label: '未入队/拦截' },
]

const SIGNAL_DIRECTION_FILTERS: Array<{ value: LiveSignalDirectionFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'HOLD', label: '观望' },
  { value: 'BUY', label: '买入' },
  { value: 'SELL_SHORT', label: '卖空误判/拦截' },
  { value: 'SELL_TO_CLOSE', label: '平仓卖出' },
]

const CANDIDATE_POOL_HISTORY_FILTERS: Array<{ value: LiveCandidatePoolHistoryFilter; label: string }> = [
  { value: 'ACTIVE', label: '生效中' },
  { value: 'INACTIVE', label: '已失效' },
]

export default function AshareLiveTradingView() {
  const language = useUiStore((state) => state.language)
  const {
    dashboard,
    history,
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    signalTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    candidatePoolHistoryFilter,
    loading,
    runningAction,
    confirmingOrderId,
    rejectingOrderId,
    error,
    refresh,
    start,
    stop,
    runOnce,
    saveLlmConfig,
    saveTradingAgentLlmConfig,
    saveTradeStrategyConfig,
    savingConfig,
    setHistoryPage,
    setPendingOrderStatusFilter,
    setPendingOrderTickerFilter,
    setPendingOrderSideFilter,
    setSignalTickerFilter,
    setSignalDirectionFilter,
    setSignalLifecycleFilter,
    setCandidatePoolHistoryFilter,
    confirmOrder,
    rejectOrder,
  } = useAshareWorkbench()
  const engineRunning = Boolean(dashboard?.engine.running)
  const executionMode = dashboard?.tradeStrategyConfig.selection.executionMode ?? 'legacy_direct'
  const pendingReadiness = dashboard?.readiness.filter((item) => !item.quoteReady || item.klineBars < 120 || item.tickerPoints === 0) ?? []
  const signalTickerFilterItems = useMemo(
    () => tickerFilterItems([...(dashboard?.universe.map((item) => item.ticker) ?? []), ...(history.signals?.items.map((signal) => signal.ticker) ?? [])]),
    [dashboard?.universe, history.signals?.items],
  )
  const pendingTickerFilterItems = useMemo(
    () => tickerFilterItems([...(dashboard?.universe.map((item) => item.ticker) ?? []), ...(history['pending-orders']?.items.map((order) => order.intent.ticker) ?? [])]),
    [dashboard?.universe, history],
  )
  const ashareNameByTicker = useMemo(() => {
    const entries = [
      ...(dashboard?.universe.map((item) => [item.ticker.toUpperCase(), item.name] as const) ?? []),
      ...(dashboard?.readiness.map((item) => [item.ticker.toUpperCase(), item.name] as const) ?? []),
    ].filter(([, name]) => Boolean(name))
    return Object.fromEntries(entries)
  }, [dashboard?.readiness, dashboard?.universe])
  const latestSkipNotice = dashboard?.skippedTickers[0]
    ? {
      label: copy(language, '最新跳过', 'Latest Skip'),
      time: dashboard.skippedTickers[0].updatedAt,
      message: `${dashboard.skippedTickers[0].ticker} · ${dashboard.skippedTickers[0].reason}`,
    }
    : dashboard?.session.reason
      ? {
        label: copy(language, '当前门禁', 'Current Gate'),
        time: dashboard.session.checkedAt,
        message: dashboard.session.reason,
      }
      : undefined
  const engineLastError = dashboard?.engine.lastError
  const shouldShowEngineLastError = Boolean(engineLastError && engineLastError !== dashboard?.session.reason && !latestSkipNotice?.message.includes(engineLastError))

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <AshareWorkbenchNav className="mb-0" />

        <header className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black tracking-[0.24em] text-orange-700">{copy(language, '富途 A 股实盘', 'Futu A-Share Live')}</p>
              <h1 className="mt-3 text-4xl font-black tracking-[-0.04em] text-stone-950 md:text-5xl">{copy(language, '真实操作盘 A股量化交易', 'A-Share Quant Live Trading')}</h1>
              <p className="mt-4 max-w-4xl text-sm leading-6 text-stone-600">
                {copy(
                  language,
                  '大模型策略入口按 A 股规则运行：只允许多头方向、人民币计价、午休和收盘门禁、禁止卖空。当前页面使用 A 股独立接口与订阅服务，不读写现有 Futu 实盘队列。',
                  'The LLM strategy entry follows A-share rules: long-only, CNY-denominated, lunch/close gates, and no short selling. This page uses the isolated A-share API and subscription service without touching the existing Futu live queue.',
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone={engineRunning ? 'emerald' : 'amber'}>{engineRunning ? copy(language, '运行中', 'Running') : copy(language, '已停止', 'Stopped')}</Badge>
              <Badge tone={executionMode === 'trading_agent' || executionMode === 'candidate_pool' ? 'amber' : 'cyan'}>{formatDecisionMode(executionMode, language)}</Badge>
              <Badge tone="red">{copy(language, '禁止卖空', 'No Short Selling')}</Badge>
              <Badge tone={dashboard?.session.shouldSkipLlm ? 'red' : 'emerald'}>{dashboard?.session.session ?? '加载中'}</Badge>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-black text-white hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60" disabled={runningAction || engineRunning} onClick={start} type="button">
              {runningAction ? copy(language, '请求中...', 'Requesting...') : copy(language, '启动 A股评估', 'Start A-Share Evaluation')}
            </button>
            <button className="rounded-2xl bg-white px-4 py-2 text-sm font-black text-stone-800 ring-1 ring-orange-200 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={runningAction || !engineRunning} onClick={stop} type="button">{copy(language, '停止', 'Stop')}</button>
            <button className="rounded-2xl bg-white px-4 py-2 text-sm font-black text-stone-800 ring-1 ring-orange-200 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={runningAction} onClick={runOnce} type="button">{copy(language, '单轮评估', 'Run Once')}</button>
            <button className="rounded-2xl bg-white px-4 py-2 text-sm font-black text-stone-800 ring-1 ring-orange-200 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={loading} onClick={refresh} type="button">{loading ? copy(language, '刷新中...', 'Refreshing...') : copy(language, '刷新当前页', 'Refresh')}</button>
          </div>
          {latestSkipNotice ? (
            <p className="mt-4 truncate rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {latestSkipNotice.label} · {formatDateTime(latestSkipNotice.time)} · {latestSkipNotice.message}
            </p>
          ) : null}
          {shouldShowEngineLastError ? <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{engineLastError}</p> : null}
          {error ? <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p> : null}
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          <Metric label={copy(language, '股票池', 'Universe')} value={String(dashboard?.universe.length ?? 0)} hint={copy(language, 'A 股独立股票池', 'Isolated A-share universe')} />
          <Metric label={copy(language, '订阅进程', 'Subscription')} value={dashboard?.realtime.running ? copy(language, '运行中', 'Running') : copy(language, '未运行', 'Stopped')} hint={dashboard?.realtime.lastEventAt || copy(language, '暂无事件', 'No events')} />
          <Metric label={copy(language, '待补齐行情', 'Data Gaps')} value={String(pendingReadiness.length)} hint={copy(language, '目标 120 根 K 线和逐笔数据', 'Target 120 bars and tick data')} />
          <Metric label={copy(language, '下一轮评估', 'Next Run')} value={dashboard?.engine.nextRunAt ? new Date(dashboard.engine.nextRunAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }) : '-'} hint={dashboard?.engine.lastRunAt ? `${copy(language, '上次', 'Last')} ${new Date(dashboard.engine.lastRunAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}` : copy(language, '启动后自动调度', 'Scheduled after start')} />
        </section>

        <AshareAccountOverviewPanel dashboard={dashboard} language={language} />

        <section className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
          <AshareLlmRuntimeConfigPanel
            config={dashboard?.llmRuntimeConfig}
            modelOptions={dashboard?.modelOptions ?? []}
            saving={savingConfig}
            onSave={saveLlmConfig}
          />
          <AshareGuardrailsPanel />
        </section>

        <TradeStrategyConfigPanel
          title={copy(language, 'A股策略与提示词版本', 'A-Share Strategy and Prompt Version')}
          subtitle={copy(language, 'A 股使用独立配置命名空间；保存后从下一轮评估生效，不绕过门禁或人工确认。', 'A-share uses an isolated config namespace. Changes apply from the next evaluation and never bypass gates or manual confirmation.')}
          config={dashboard?.tradeStrategyConfig}
          saving={savingConfig}
          dark
          showPortfolioExecutionMode
          enableTradingAgentExecutionMode
          eyebrow={copy(language, 'A 股交易策略', 'A-Share Trade Strategy')}
          accent="futu"
          onSave={saveTradeStrategyConfig}
        />

        {executionMode === 'trading_agent' ? (
          <>
            <TradingAgentLlmConfigPanel
              config={dashboard?.tradingAgentLlmConfig}
              presets={dashboard?.tradingAgentLlmPresets ?? []}
              saving={savingConfig}
              onSave={saveTradingAgentLlmConfig}
            />
            <TradingAgentStrategyOverviewPanel status={dashboard?.tradingAgent} config={dashboard?.tradingAgentLlmConfig} />
          </>
        ) : null}

        <AshareCandidatePoolPanel
          snapshot={dashboard?.candidatePool}
          page={history['candidate-pool']}
          filter={candidatePoolHistoryFilter}
          onFilterChange={setCandidatePoolHistoryFilter}
          onPageChange={(page) => setHistoryPage('candidate-pool', page)}
          saving={savingConfig}
          onSave={saveTradeStrategyConfig}
        />

        <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <AshareSignalHistoryTable
            page={history.signals}
            nameByTicker={ashareNameByTicker}
            tickerFilter={signalTickerFilter}
            tickerFilterItems={signalTickerFilterItems}
            directionFilter={signalDirectionFilter}
            lifecycleFilter={signalLifecycleFilter}
            onTickerFilterChange={setSignalTickerFilter}
            onDirectionFilterChange={setSignalDirectionFilter}
            onLifecycleFilterChange={setSignalLifecycleFilter}
            onPageChange={(page) => setHistoryPage('signals', page)}
          />
          <AsharePendingOrdersPanel
            page={history['pending-orders']}
            statusFilter={pendingOrderStatusFilter}
            tickerFilter={pendingOrderTickerFilter}
            tickerFilterItems={pendingTickerFilterItems}
            sideFilter={pendingOrderSideFilter}
            onStatusFilterChange={setPendingOrderStatusFilter}
            onTickerFilterChange={setPendingOrderTickerFilter}
            onSideFilterChange={setPendingOrderSideFilter}
            onPageChange={(page) => setHistoryPage('pending-orders', page)}
            confirmingOrderId={confirmingOrderId}
            rejectingOrderId={rejectingOrderId}
            onConfirmOrder={confirmOrder}
            onRejectOrder={rejectOrder}
          />
        </section>
      </div>
    </main>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-3xl border border-orange-200/70 bg-white/90 p-5 shadow-sm backdrop-blur">
      <span className="text-xs font-black text-stone-500">{label}</span>
      <strong className="mt-2 block text-2xl font-black tracking-[-0.03em] text-stone-950">{value}</strong>
      <span className="mt-1 block text-xs font-semibold text-stone-500">{hint}</span>
    </div>
  )
}

function AshareAccountOverviewPanel({ dashboard, language }: { dashboard?: AShareDashboardResponse; language: UiLanguage }) {
  const account = dashboard?.account
  const summary = account?.summary
  const universeTickers = new Set((dashboard?.universe ?? []).map((item) => normalizeTicker(item.ticker)))
  const asharePositions = (account?.positions ?? []).filter((position) => {
    const keys = [position.ticker, position.underlyingTicker, position.code].map(normalizeTicker)
    return keys.some((ticker) => universeTickers.has(ticker) || ticker.startsWith('SH.') || ticker.startsWith('SZ.'))
  })
  const visiblePositions = asharePositions.slice(0, 6)
  const sourceTime = summary?.source.timestamp || summary?.source.accessedAt
  return (
    <section className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black tracking-[0.18em] text-orange-700">{copy(language, '账户资金', 'Account Funds')}</p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">{copy(language, '持仓、资金与购买力', 'Positions, Funds, and Buying Power')}</h2>
          <p className="mt-2 text-sm font-semibold text-stone-500">
            {copy(language, '用于 A 股下单规模、资金充足性和平仓持仓校验。', 'Used for A-share order sizing, funds checks, and sell-to-close validation.')}
          </p>
        </div>
        <div className="text-right text-xs font-bold text-stone-500">
          <div>{copy(language, '账户', 'Account')} · {account?.selectedAccountId ?? summary?.accountId ?? '-'}</div>
          <div className="mt-1">{sourceTime ? formatDateTime(sourceTime) : copy(language, '暂未同步', 'Not synced')}</div>
        </div>
      </div>
      {account?.warnings?.length ? (
        <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{account.warnings[0]}</p>
      ) : null}
      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <AccountMetric label={copy(language, '人民币总资产', 'CNY Total Assets')} value={summary?.totalAssetsInTradingCurrency} />
        <AccountMetric label={copy(language, '人民币现金', 'CNY Cash')} value={summary?.cashInTradingCurrency} />
        <AccountMetric label={copy(language, '人民币可用资金', 'CNY Available Funds')} value={summary?.availableFundsInTradingCurrency} />
        <AccountMetric label={copy(language, '人民币购买力', 'CNY Buying Power')} value={summary?.buyingPowerInTradingCurrency} />
      </div>
      <div className="mt-5 rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-black text-stone-500">{copy(language, 'A 股持仓', 'A-Share Positions')}</span>
          <span className="rounded-full bg-white px-2 py-1 text-xs font-black text-orange-700 ring-1 ring-orange-200">{asharePositions.length}</span>
        </div>
        {visiblePositions.length ? (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {visiblePositions.map((position) => (
              <div key={`${position.ticker}-${position.code}`} className="rounded-2xl border border-orange-100 bg-white px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-black text-stone-950">{position.name || position.ticker || position.code}</div>
                    <div className="mt-1 text-xs font-bold text-stone-500">{position.ticker || position.code}</div>
                  </div>
                  <div className="text-right text-sm font-black text-stone-950">{position.quantity}</div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <PositionField label={copy(language, '市值', 'Market Value')} value={position.marketValue} />
                  <PositionField label={copy(language, '成本', 'Cost')} value={position.averageCost} />
                  <PositionField label={copy(language, '盈亏', 'P&L')} value={position.unrealizedPnL} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-stone-500">{copy(language, '当前未识别到 A 股持仓。', 'No A-share positions recognized.')}</p>
        )}
      </div>
    </section>
  )
}

function AccountMetric({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
      <span className="text-xs font-black text-stone-500">{label}</span>
      <strong className="mt-2 block text-xl font-black tracking-[-0.03em] text-stone-950">{displayAccountValue(value)}</strong>
    </div>
  )
}

function PositionField({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span className="block font-bold text-stone-400">{label}</span>
      <strong className="mt-1 block truncate font-black text-stone-800">{displayAccountValue(value)}</strong>
    </div>
  )
}

function AshareLlmRuntimeConfigPanel({
  config,
  modelOptions,
  saving,
  onSave,
}: {
  config?: LlmRuntimeConfig
  modelOptions: LlmModelOption[]
  saving: boolean
  onSave: (input: UpdateLlmRuntimeConfigRequest) => void
}) {
  const language = useUiStore((state) => state.language)
  const concurrencyOptions = Array.from({ length: config?.maxConcurrency ?? 1 }, (_, index) => index + 1)
  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{copy(language, '大模型配置', 'LLM Config')}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{copy(language, '大模型配置', 'LLM Configuration')}</h2>
          <p className="mt-2 text-sm text-stone-600">{copy(language, 'A 股独立运行配置；保存后从下一轮 A 股实盘评估生效，不影响 Futu 美港股和 Longbridge。', 'Isolated A-share runtime config. Changes apply from the next A-share live evaluation without affecting Futu HK/US or Longbridge.')}</p>
        </div>
        <Badge tone="cyan">{config?.modelLabel ?? copy(language, '未加载', 'Not Loaded')}</Badge>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-[1.2fr_0.7fr_1fr_auto]">
        <label className="text-sm font-semibold text-stone-600">
          {copy(language, '模型', 'Model')}
          <select
            className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-950"
            disabled={saving || !config}
            value={config?.model ?? ''}
            onChange={(event) => config && onSave({ model: event.target.value, concurrency: config.concurrency, disableUsOvernightLlm: config.disableUsOvernightLlm })}
          >
            {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-stone-600">
          {copy(language, '并发', 'Concurrency')}
          <select
            className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-950"
            disabled={saving || !config}
            value={config?.concurrency ?? 1}
            onChange={(event) => config && onSave({ model: config.model, concurrency: Number(event.target.value), disableUsOvernightLlm: config.disableUsOvernightLlm })}
          >
            {concurrencyOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-3 self-end rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-600">
          <input checked disabled type="checkbox" />
          {copy(language, '仅连续竞价提交大模型', 'Submit LLM only during continuous auction')}
        </label>
        <button
          className="self-end rounded-2xl bg-amber-500 px-4 py-3 text-sm font-bold text-stone-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={saving || !config}
          onClick={() => config && onSave({ model: config.model, concurrency: config.concurrency, disableUsOvernightLlm: config.disableUsOvernightLlm })}
          type="button"
        >
          {saving ? copy(language, '保存中', 'Saving') : copy(language, '保存配置', 'Save Config')}
        </button>
      </div>
      <p className="mt-3 text-xs text-stone-500">{copy(language, 'A 股不支持盘前、盘后、夜盘；午休、收盘、周末或行情不足时只记录跳过原因，不提交大模型。', 'A-shares do not support pre-market, after-hours, or overnight sessions. Lunch break, close, weekends, or insufficient market data are recorded as skips without submitting to the LLM.')}</p>
    </section>
  )
}

function AshareGuardrailsPanel() {
  const language = useUiStore((state) => state.language)
  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm backdrop-blur">
      <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">{copy(language, '硬性风控', 'Guardrails')}</p>
      <h2 className="mt-2 text-2xl font-semibold text-stone-950">{copy(language, '实盘门禁', 'Live Trading Gates')}</h2>
      <div className="mt-5 space-y-3 text-sm font-semibold text-stone-600">
        <p className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-rose-700">{copy(language, '卖空不允许入队，服务层和 Python 桥都会拦截。', 'Short selling cannot enter the queue and is blocked by both the service layer and Python bridge.')}</p>
        <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">{copy(language, '只允许连续竞价时段评估与常规交易时段订单。', 'Evaluations and regular-session orders are allowed only during continuous auction.')}</p>
        <p className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3">{copy(language, '订单方向过滤只展示全部、买入、平仓卖出。', 'Order direction filters show all, buy, and sell to close only.')}</p>
      </div>
    </section>
  )
}

function TradingAgentLlmConfigPanel({
  config,
  presets,
  saving,
  onSave,
}: {
  config?: AShareTradingAgentLlmConfig
  presets: AShareTradingAgentLlmPreset[]
  saving: boolean
  onSave: (input: UpdateAshareTradingAgentLlmConfigRequest) => void
}) {
  const language = useUiStore((state) => state.language)
  return (
    <section className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black tracking-[0.24em] text-orange-700">{copy(language, '多角色交易代理模型', 'Trading Agent LLM')}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{copy(language, '多角色交易代理模型配置', 'Trading Agent Model Configuration')}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {copy(language, '这里配置的是开源 TradingAgents 多角色链路使用的大模型，不影响 A 股直推大模型和候选池组合裁决。密钥只从服务端 `.env.local` 读取，前端不展示明文。', 'This config controls the LLM used by the open-source TradingAgents multi-role chain. It does not affect A-share direct LLM decisions or candidate-pool portfolio decisions. API keys are read only from server-side `.env.local` and never shown in the frontend.')}
          </p>
        </div>
        <Badge tone={config?.apiKeyConfigured ? 'emerald' : 'red'}>{config?.apiKeyConfigured ? copy(language, '密钥已配置', 'Key Configured') : copy(language, '密钥未配置', 'Key Missing')}</Badge>
      </div>
      <div className="mt-5 grid gap-3 xl:grid-cols-[1.1fr_0.6fr_0.6fr_0.7fr_auto]">
        <label className="text-sm font-semibold text-stone-600">
          {copy(language, '模型预设', 'Model Preset')}
          <select
            className="mt-2 w-full rounded-2xl border border-orange-200 bg-white px-4 py-3 text-sm text-stone-950"
            disabled={saving || !config}
            value={config?.presetId ?? ''}
            onChange={(event) => config && onSave({ presetId: event.target.value, maxDebateRounds: config.maxDebateRounds, maxRiskRounds: config.maxRiskRounds, outputLanguage: config.outputLanguage })}
          >
            {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-stone-600">
          {copy(language, '辩论轮数', 'Debate Rounds')}
          <select
            className="mt-2 w-full rounded-2xl border border-orange-200 bg-white px-4 py-3 text-sm text-stone-950"
            disabled={saving || !config}
            value={config?.maxDebateRounds ?? 1}
            onChange={(event) => config && onSave({ presetId: config.presetId, maxDebateRounds: Number(event.target.value), maxRiskRounds: config.maxRiskRounds, outputLanguage: config.outputLanguage })}
          >
            {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-stone-600">
          {copy(language, '风险复核轮数', 'Risk Rounds')}
          <select
            className="mt-2 w-full rounded-2xl border border-orange-200 bg-white px-4 py-3 text-sm text-stone-950"
            disabled={saving || !config}
            value={config?.maxRiskRounds ?? 1}
            onChange={(event) => config && onSave({ presetId: config.presetId, maxDebateRounds: config.maxDebateRounds, maxRiskRounds: Number(event.target.value), outputLanguage: config.outputLanguage })}
          >
            {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-stone-600">
          {copy(language, '输出语言', 'Output Language')}
          <select
            className="mt-2 w-full rounded-2xl border border-orange-200 bg-white px-4 py-3 text-sm text-stone-950"
            disabled={saving || !config}
            value={config?.outputLanguage ?? 'Chinese'}
            onChange={(event) => config && onSave({ presetId: config.presetId, maxDebateRounds: config.maxDebateRounds, maxRiskRounds: config.maxRiskRounds, outputLanguage: event.target.value })}
          >
            <option value="Chinese">{copy(language, '中文', 'Chinese')}</option>
            <option value="English">{copy(language, '英文', 'English')}</option>
          </select>
        </label>
        <button
          className="self-end rounded-2xl bg-orange-500 px-4 py-3 text-sm font-black text-white hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={saving || !config}
          onClick={() => config && onSave({ presetId: config.presetId, maxDebateRounds: config.maxDebateRounds, maxRiskRounds: config.maxRiskRounds, outputLanguage: config.outputLanguage })}
          type="button"
        >
          {saving ? copy(language, '保存中', 'Saving') : copy(language, '保存代理模型', 'Save Agent LLM')}
        </button>
      </div>
    </section>
  )
}

function TradingAgentStrategyOverviewPanel({ status, config }: { status?: AShareDashboardResponse['tradingAgent']; config?: AShareTradingAgentLlmConfig }) {
  const language = useUiStore((state) => state.language)
  const roles = [
    { role: copy(language, '行情分析员', 'Market Analyst'), summary: copy(language, '只基于 A 股行情窗口判断短线价格、K 线、逐笔成交和盘口结构。', 'Uses only the A-share market window to assess short-term price, K-line, tick, and order-book structure.') },
    { role: copy(language, '风险分析员', 'Risk Analyst'), summary: copy(language, '读取宏观新闻、个股新闻、数据质量和 A 股硬规则，将新闻只作为风险约束。', 'Reads macro news, stock news, data quality, and A-share hard rules; news is used only as a risk constraint.') },
    { role: copy(language, '看多研究员', 'Bull Researcher'), summary: copy(language, '提出看多论据，要求承认数据缺口和 A 股交易限制。', 'Builds the bullish case while acknowledging data gaps and A-share trading limits.') },
    { role: copy(language, '看空研究员', 'Bear Researcher'), summary: copy(language, '提出反方风险，重点关注宏观、估值、资金流、盘口和数据缺失。', 'Builds the bearish risk case across macro, valuation, capital flow, order book, and missing data.') },
    { role: copy(language, '投资组合经理', 'Portfolio Manager'), summary: copy(language, '综合角色报告，在观望、买入、平仓卖出中输出最终裁决。', 'Synthesizes role reports and produces the final hold, buy, or sell-to-close decision.') },
  ]
  const dataSources = [
    copy(language, '富途 A 股报价、1 分钟 K 线、逐笔成交和盘口', 'Futu A-share quotes, 1-minute bars, ticks, and order book'),
    copy(language, '富途可用研究、分析师一致预期、资金流、财务异动和市场状态', 'Available Futu research, analyst consensus, capital flow, financial anomalies, and market state'),
    copy(language, '豆包搜索新闻和宏观信息兜底', 'Doubao search fallback for news and macro context'),
    copy(language, '真实账户持仓，用于平仓卖出持仓校验', 'Real account positions for sell-to-close validation'),
  ]
  const guardrails = [
    copy(language, '禁止卖空，服务层和 Python 桥都必须拦截。', 'Short selling is forbidden and must be blocked by both the service layer and Python bridge.'),
    copy(language, '无多头持仓不得平仓卖出，超持仓数量也必须拦截。', 'Sell-to-close is blocked without a long position and cannot exceed held quantity.'),
    copy(language, '交易时段门禁、行情就绪门禁和人工确认不可绕过。', 'Trading-session gates, market-data readiness gates, and manual confirmation cannot be bypassed.'),
    copy(language, '非观望只是在硬风控通过后进入待确认订单，不自动获得下单权限。', 'Non-hold decisions enter pending confirmation only after hard controls pass; they never get automatic order permission.'),
  ]
  return (
    <section className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black tracking-[0.24em] text-orange-700">{copy(language, '多角色交易代理策略', 'Trading Agent Strategy')}</p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">{copy(language, '多角色交易代理策略说明', 'Trading Agent Strategy Overview')}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {copy(language, '这是 A 股单标的多角色研究链说明区，讲清楚模式、角色、数据输入和硬约束。具体某次运行的角色报告、富途上下文、适配器警告和最终裁决只在历史信号展开态或代理运行证据中查看。', 'This overview explains the single-name A-share multi-role research chain: mode, roles, data inputs, and hard constraints. Concrete role reports, Futu context, adapter warnings, and final decisions are shown only in signal expansion or agent-run evidence.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={status?.adapterReady ? 'emerald' : 'amber'}>{status?.adapterReady ? copy(language, '适配器就绪', 'Adapter Ready') : copy(language, '适配器未就绪', 'Adapter Not Ready')}</Badge>
          <Badge tone={config?.apiKeyConfigured ? 'emerald' : 'red'}>{config?.apiKeyConfigured ? copy(language, '大模型密钥已配置', 'LLM Key Configured') : copy(language, '大模型密钥未配置', 'LLM Key Missing')}</Badge>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <ConfigTile label={copy(language, '模式定位', 'Mode')} value={copy(language, '多角色交易代理研究链', 'Multi-role trading-agent research chain')} note={copy(language, '单标的深度评估，不参与候选池排序', 'Single-name deep research, separate from candidate ranking')} />
        <ConfigTile label={copy(language, '执行链路', 'Workflow')} value={copy(language, '代理研究 -> 投资组合经理 -> 硬风控 -> 人工确认', 'Agents -> PM -> Hard Controls -> Manual Confirmation')} note={copy(language, '非观望不等于自动下单', 'A non-hold decision is not an automatic order')} />
        <ConfigTile label={copy(language, '输出动作', 'Actions')} value={copy(language, '观望 / 买入 / 平仓卖出', 'HOLD / BUY / SELL_TO_CLOSE')} note={copy(language, 'A 股第一版禁止卖空', 'Short selling is disabled in the first A-share version')} />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black tracking-[0.2em] text-orange-700">{copy(language, '执行链路', 'Workflow')}</p>
              <h3 className="mt-1 text-lg font-black text-stone-950">{copy(language, '执行链路', 'Workflow')}</h3>
            </div>
            <Badge tone="amber">{copy(language, '不写入候选池', 'No Candidate Pool')}</Badge>
          </div>
          <div className="mt-4 grid gap-2 text-sm font-semibold text-stone-700 md:grid-cols-5">
            {(language === 'zh'
              ? ['行情/上下文注入', '多角色分析', '投资组合经理最终裁决', '服务层硬风控', '人工确认']
              : ['Market/context injection', 'Multi-role analysis', 'PM final decision', 'Service hard controls', 'Manual confirmation']).map((step, index) => (
              <div key={step} className="rounded-xl border border-orange-100 bg-white/90 p-3">
                <span className="text-xs font-black text-orange-600">0{index + 1}</span>
                <p className="mt-2 leading-5">{step}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-orange-100 bg-orange-50/50 p-4">
          <p className="text-xs font-black tracking-[0.2em] text-orange-700">{copy(language, '模式边界', 'Mode Boundary')}</p>
          <h3 className="mt-1 text-lg font-black text-stone-950">{copy(language, '和组合策略的区别', 'Difference From Portfolio Strategy')}</h3>
          <p className="mt-3 text-sm leading-6 text-stone-600">
            {copy(language, '多角色交易代理用于单标的深度研究，由投资组合经理综合角色报告给出最终动作；候选池用于多标的候选排序和组合裁决。两者数据流分离，多角色交易代理的非观望信号不进入候选池。', 'The trading agent performs single-name deep research, with the portfolio manager synthesizing role reports into a final action. The candidate pool ranks multiple names and performs portfolio-level decisions. The two data flows are separate; non-hold trading-agent signals do not enter the candidate pool.')}
          </p>
          <p className="mt-3 rounded-xl border border-orange-200 bg-white/80 px-3 py-2 text-xs font-bold text-orange-800">
            {copy(language, '运行证据请在历史信号卡片展开态查看；本面板不展示最近一次具体结果。', 'Run evidence is available in the expanded signal cards; this panel does not show the latest concrete result.')}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 xl:grid-cols-5">
        {roles.map((item) => (
          <article key={item.role} className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4 text-xs">
            <strong className="text-sm text-stone-950">{item.role}</strong>
            <p className="mt-3 min-h-20 leading-5 text-stone-600">{item.summary}</p>
          </article>
        ))}
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-orange-100 bg-white/90 p-4">
          <p className="text-xs font-black tracking-[0.2em] text-orange-700">{copy(language, '数据输入', 'Data Inputs')}</p>
          <h3 className="mt-1 text-lg font-black text-stone-950">{copy(language, '数据输入', 'Data Inputs')}</h3>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-stone-600">
            {dataSources.map((item) => <li key={item}>· {item}</li>)}
          </ul>
        </div>
        <div className="rounded-2xl border border-rose-100 bg-rose-50/60 p-4">
          <p className="text-xs font-black tracking-[0.2em] text-rose-700">{copy(language, '硬性风控', 'Hard Guardrails')}</p>
          <h3 className="mt-1 text-lg font-black text-stone-950">{copy(language, '硬性风控', 'Hard Guardrails')}</h3>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-rose-700">
            {guardrails.map((item) => <li key={item}>· {item}</li>)}
          </ul>
        </div>
      </div>

      {status?.error ? (
        <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{status.error}</p>
      ) : null}
    </section>
  )
}

function AshareSignalHistoryTable({
  page,
  nameByTicker,
  tickerFilter,
  tickerFilterItems,
  directionFilter,
  lifecycleFilter,
  onTickerFilterChange,
  onDirectionFilterChange,
  onLifecycleFilterChange,
  onPageChange,
}: {
  page?: SimulationHistoryPage<LiveSignalHistoryItem>
  nameByTicker: Record<string, string>
  tickerFilter: string
  tickerFilterItems: Array<{ value: string; label: string }>
  directionFilter: LiveSignalDirectionFilter
  lifecycleFilter: LiveSignalLifecycleFilter
  onTickerFilterChange: (ticker: string) => void
  onDirectionFilterChange: (direction: LiveSignalDirectionFilter) => void
  onLifecycleFilterChange: (status: LiveSignalLifecycleFilter) => void
  onPageChange: (page: number) => void
}) {
  const language = useUiStore((state) => state.language)
  const items = page?.items ?? []
  return (
    <section className="min-w-0 rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
      <div>
        <p className="text-xs font-black tracking-[0.24em] text-orange-700">{copy(language, '历史策略信号', 'Signal History')}</p>
        <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">{copy(language, 'A股历史信号', 'A-Share Signal History')}（{page?.total ?? 0}）</h2>
        <p className="mt-2 text-sm text-stone-600">{copy(language, '保留方向、标的、生命周期筛选，完整展示模型理由、风险、数据窗口和未入队原因。', 'Keeps direction, ticker, and lifecycle filters while showing model reasoning, risk, data window, and queue-skip reasons.')}</p>
      </div>
      <div className="mt-5 space-y-3">
        <AshareFilterSelect label={copy(language, '标的', 'Ticker')} value={tickerFilter} items={localizeTickerItems(tickerFilterItems, language)} onChange={onTickerFilterChange} />
        <AshareFilterChips label={copy(language, '信号状态', 'Status')} items={localizeSignalLifecycleFilters(language)} value={lifecycleFilter} onChange={onLifecycleFilterChange} />
        <AshareFilterChips label={copy(language, '交易方向', 'Direction')} items={localizeSignalDirectionFilters(language)} value={directionFilter} onChange={onDirectionFilterChange} />
      </div>
      <div className="mt-5 space-y-3">
        {items.map((signal) => {
          const lifecycleStatus = signal.lifecycleStatus ?? (signal.side === 'HOLD' ? 'HOLD' : 'CANDIDATE_POOL')
          const lifecycleReason = signal.lifecycleReason
          const signalName = nameByTicker[signal.ticker.toUpperCase()] || signal.ticker
          return (
            <article key={signal.historyId ?? signal.id} className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4 text-sm">
              <div className="flex flex-wrap justify-between gap-3">
                <div className="space-y-2">
                  <div>
                    <strong className="text-stone-950">
                      {signalName} · <span className={sideTone(signal.side)}>{sideLabel(signal.side, language)}</span>
                    </strong>
                    <p className="mt-1 text-xs font-semibold text-stone-500">{signal.ticker}</p>
                  </div>
                  <span className={`block w-fit rounded-xl px-3 py-1 text-xs font-black ${signalStatusTone(lifecycleStatus)}`}>
                    {signalStatusLabel(lifecycleStatus, language)}
                  </span>
                </div>
                <span className="text-right text-stone-600">
                  {signal.modelLabel ?? signal.model ?? copy(language, 'A股大模型', 'A-share LLM')}
                  <span className="mt-1 block text-xs text-stone-500">{formatDateTime(signal.generatedAt, language)}</span>
                </span>
              </div>
              {lifecycleReason && lifecycleStatus !== 'HOLD' ? (
                <p className="mt-3 rounded-xl border border-orange-200 bg-white/80 px-3 py-2 text-orange-800">
                  {lifecycleStatus === 'SUBMIT_FAILED' ? copy(language, '提交失败', 'Submit failed') : copy(language, '未进入待确认队列', 'Did not enter pending confirmation')}：{lifecycleReason}
                </p>
              ) : null}
              <div className="mt-3 grid gap-3 rounded-xl border border-orange-100 bg-white/70 p-3 text-xs sm:grid-cols-3">
                <CompactField label={copy(language, '股价', 'Price')} value={formatSignalPrice(signal.price, language)} />
                <CompactField label={copy(language, '限价', 'Limit Price')} value={formatSignalPrice(signal.limitPrice, language)} />
                <CompactField label={copy(language, '数量', 'Quantity')} value={`${signal.quantity} ${copy(language, '股', 'shares')}`} />
              </div>
              <CollapsibleText className="mt-3 text-sm leading-6 text-stone-700" text={signal.reason} maxLength={180} />
              <div className="mt-3 grid gap-3 border-t border-orange-100 pt-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                <CompactField label={copy(language, '风险说明', 'Risk')} value={signal.riskAssessment} />
                <CompactField label={copy(language, '数据窗口', 'Data Window')} value={signal.dataWindow ?? copy(language, '不可用', 'Unavailable')} />
                <CompactField label={copy(language, '交易周期', 'Horizon')} value={signal.tradeHorizon ?? copy(language, '不可用', 'Unavailable')} />
                <CompactField label={copy(language, '趋势一致性', 'Trend Alignment')} value={formatTrendAlignment(signal.trendAlignment, signal.side, language)} />
              </div>
              {signal.agentRunId || signal.agentReports?.length ? (
                <details className="mt-3 rounded-2xl border border-orange-200 bg-white/80 p-4">
                  <summary className="cursor-pointer list-none rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-black text-orange-800 hover:bg-orange-100">
                    {copy(language, '展开 / 收起多角色交易代理全文', 'Expand / Collapse Trading Agent Details')}
                  </summary>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-black tracking-[0.2em] text-orange-700">{copy(language, '多角色交易代理明细', 'Trading Agent Details')}</p>
                    {signal.agentRunId ? <Badge tone="amber">{signal.agentRunId}</Badge> : null}
                  </div>
                  {signal.agentFailureReason ? <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{signal.agentFailureReason}</p> : null}
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {(signal.agentReports ?? []).map((report, index) => (
                      <div key={`${signal.id}-${report.role}-${index}`} className="rounded-xl border border-orange-100 bg-orange-50/60 p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-stone-900">{agentRoleLabel(report.role, language)}</strong>
                          <span className={report.status === 'ERROR' ? 'text-rose-700' : report.status === 'WATCH' ? 'text-orange-700' : 'text-emerald-700'}>{agentStatusLabel(report.status, language)}</span>
                        </div>
                        <p className="mt-2 leading-5 text-stone-600">{report.summary}</p>
                      </div>
                    ))}
                  </div>
                  {signal.finalAgentDecision ? (
                    <div className="mt-3 grid gap-3 rounded-xl border border-orange-100 bg-white/80 p-3 text-xs sm:grid-cols-3">
                      <CompactField label={copy(language, '最终裁决', 'Final Decision')} value={sideLabel(String(signal.finalAgentDecision.action ?? signal.side), language)} />
                      <CompactField label={copy(language, '置信度', 'Confidence')} value={formatAgentConfidence(signal.finalAgentDecision.confidence, language)} />
                      <CompactField label={copy(language, '建议数量', 'Suggested Quantity')} value={`${Number(signal.finalAgentDecision.orderQuantity ?? signal.quantity ?? 0)} ${copy(language, '股', 'shares')}`} />
                    </div>
                  ) : null}
                </details>
              ) : null}
            </article>
          )
        })}
        {!items.length ? <p className="rounded-2xl border border-orange-100 bg-orange-50/50 p-5 text-sm text-stone-600">{copy(language, '暂无 A 股历史策略信号。', 'No A-share signal history yet.')}</p> : null}
      </div>
      <PaginationControls page={page?.page ?? 1} totalPages={page?.totalPages ?? 1} total={page?.total ?? 0} onPageChange={onPageChange} />
    </section>
  )
}

function AsharePendingOrdersPanel({
  page,
  statusFilter,
  tickerFilter,
  tickerFilterItems,
  sideFilter,
  compact = false,
  onStatusFilterChange,
  onTickerFilterChange,
  onSideFilterChange,
  onPageChange,
  confirmingOrderId,
  rejectingOrderId,
  onConfirmOrder,
  onRejectOrder,
}: {
  page?: SimulationHistoryPage<LivePendingOrder>
  statusFilter: LivePendingOrderStatusFilter
  tickerFilter: string
  tickerFilterItems: Array<{ value: string; label: string }>
  sideFilter: LivePendingOrderSideFilter
  compact?: boolean
  onStatusFilterChange: (status: LivePendingOrderStatusFilter) => void
  onTickerFilterChange: (ticker: string) => void
  onSideFilterChange: (side: LivePendingOrderSideFilter) => void
  onPageChange: (page: number) => void
  confirmingOrderId?: string
  rejectingOrderId?: string
  onConfirmOrder: (id: string) => Promise<unknown>
  onRejectOrder: (id: string) => Promise<unknown>
}) {
  const language = useUiStore((state) => state.language)
  const orders = page?.items ?? []
  const visibleExpirableOrders = orders.filter((order) => order.status === 'PENDING_CONFIRMATION')
  return (
    <section className="min-w-0 rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black tracking-[0.24em] text-orange-700">{copy(language, '待确认订单', 'Pending Orders')}</p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">{copy(language, 'A股待确认订单队列', 'A-Share Pending Order Queue')}（{page?.total ?? 0}）</h2>
          <p className="mt-2 text-sm text-stone-600">{copy(language, 'A 股方向筛选不显示卖空，误判卖空只会作为拦截信号保留。', 'A-share direction filters do not show short selling; mistaken short signals are kept only as blocked records.')}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge tone="amber">{copy(language, '人工确认', 'Manual Confirmation')}</Badge>
          <button
            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled
            title={copy(language, 'A 股批量过期接口尚未开放，保留与老页面一致的操作位置。', 'A-share bulk-expire API is not available yet; this keeps the operation location consistent with the old page.')}
            type="button"
          >
            {copy(language, '批量过期本页', 'Bulk Expire Page')}（{copy(language, '待接接口', 'API pending')} · {visibleExpirableOrders.length}）
          </button>
        </div>
      </div>
      <div className="mt-5 space-y-3">
        <AshareFilterSelect label={copy(language, '标的', 'Ticker')} value={tickerFilter} items={localizeTickerItems(tickerFilterItems, language)} onChange={onTickerFilterChange} />
        <AshareFilterChips label={copy(language, '订单状态', 'Status')} items={localizePendingStatusFilters(language)} value={statusFilter} onChange={onStatusFilterChange} />
        <AshareFilterChips label={copy(language, '方向', 'Side')} items={localizePendingSideFilters(language)} value={sideFilter} onChange={onSideFilterChange} />
      </div>
      <div className="mt-5 space-y-3">
        {orders.slice(0, compact ? 4 : orders.length).map((order) => (
          <article key={order.id} className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4 text-sm">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-stone-500">{copy(language, '标的 / 方向', 'Ticker / Side')}</p>
                  <p className="mt-1 truncate text-base font-black text-stone-950">
                    {order.intent.ticker} · <span className={sideTone(order.intent.side)}>{sideLabel(order.intent.side, language)}</span>
                  </p>
                  <p className="mt-1 truncate text-xs text-stone-500">{order.id}</p>
                </div>
                <CompactField label={copy(language, '数量 / 价格', 'Quantity / Price')} value={`${order.intent.quantity} ${copy(language, '股', 'shares')} · ${order.intent.orderType === 'MARKET' ? copy(language, '市价', 'Market') : `¥${order.intent.limitPrice.toFixed(2)}`}`} note={order.intent.orderSession} />
              </div>
              <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                <span className={`rounded-xl px-3 py-2 text-xs font-black ${pendingStatusTone(order.status)}`}>{pendingStatusLabel(order.status, language)}</span>
                {order.status === 'PENDING_CONFIRMATION' ? (
                  <>
                    <button
                      className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-black text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={rejectingOrderId === order.id || confirmingOrderId === order.id}
                      onClick={() => {
                        const confirmed = window.confirm(`${copy(language, '拒绝这笔 A 股待确认订单？', 'Reject this A-share pending order?')}\n${order.intent.ticker} · ${sideLabel(order.intent.side, language)} · ${order.intent.quantity} ${copy(language, '股', 'shares')}`)
                        if (confirmed) void onRejectOrder(order.id)
                      }}
                      type="button"
                    >
                      {rejectingOrderId === order.id ? copy(language, '拒绝中...', 'Rejecting...') : copy(language, '拒绝', 'Reject')}
                    </button>
                    <button
                      className="rounded-xl bg-orange-500 px-3 py-2 text-xs font-black text-white hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={confirmingOrderId === order.id || rejectingOrderId === order.id}
                      onClick={() => {
                        const confirmed = window.confirm(`${copy(language, '确认提交真实 A 股订单？', 'Submit this real A-share order?')}\n${order.intent.ticker} · ${sideLabel(order.intent.side, language)} · ${order.intent.quantity} ${copy(language, '股', 'shares')} · ¥${order.intent.limitPrice.toFixed(2)}\n\n${copy(language, '提交前后端会再次校验交易门禁、禁止卖空和持仓。', 'Before submission, the backend rechecks trading gates, no-short rule, and positions.')}`)
                        if (confirmed) void onConfirmOrder(order.id)
                      }}
                      type="button"
                    >
                      {confirmingOrderId === order.id ? copy(language, '提交中...', 'Submitting...') : copy(language, '确认提交', 'Confirm Submit')}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="mt-3 grid gap-3 border-t border-orange-100 pt-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <CompactField label={copy(language, '费用', 'Fee')} value={formatFee(order.intent.feeContext, language)} note={order.intent.feeContext?.source} />
              <CompactField label={copy(language, '模型', 'Model')} value={order.signal.modelLabel ?? order.signal.model ?? copy(language, 'A股大模型', 'A-share LLM')} />
              <CompactField label={copy(language, '来源', 'Source')} value={formatDecisionMode(order.decisionMode, language)} note={order.candidateId ?? order.portfolioDecisionId ?? copy(language, 'A股独立队列', 'A-share isolated queue')} />
              <CompactField label={copy(language, '入队时间', 'Queued At')} value={formatDateTime(order.createdAt, language)} />
            </div>
            {order.decisionMode === 'trading_agent' ? (
              <div className="mt-3 rounded-xl border border-orange-200 bg-white/80 px-3 py-2 text-xs text-stone-700">
                <strong>{copy(language, '多角色交易代理', 'Trading Agent')}：</strong>{order.llmDecision.agentRunId ?? order.signal.agentRunId ?? copy(language, '运行编号不可用', 'agentRunId unavailable')}；{copy(language, '报告数', 'reports')} {(order.llmDecision.agentReports ?? order.signal.agentReports ?? []).length}；{copy(language, '最终裁决', 'final decision')} {sideLabel(order.llmDecision.action, language)}
              </div>
            ) : null}
            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
              <CompactField label={copy(language, '名义金额', 'Notional')} value={order.intent.estimatedNotional ?? `${copy(language, '人民币', 'CNY')} ${(order.intent.quantity * order.intent.limitPrice).toFixed(2)}`} />
              <CompactField label={copy(language, '费用提示', 'Fee Note')} value={order.intent.feeContext?.warning ?? copy(language, '无', 'None')} />
              <CompactField label={copy(language, '下单理由', 'Order Rationale')} value={order.intent.reason} />
              <CompactField label={copy(language, '仓位理由', 'Sizing Rationale')} value={order.intent.sizingReason} />
            </div>
            <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              {copy(language, '风险提示', 'Risk Warning')}：{order.riskWarnings.join('；') || order.signal.riskAssessment}
            </div>
          </article>
        ))}
        {!orders.length ? <div className="rounded-2xl border border-orange-100 bg-orange-50 p-5 text-sm text-orange-800">{copy(language, '暂无 A 股待确认订单。非观望决策通过候选池和硬风控后会进入这里。', 'No A-share pending orders. Non-hold decisions appear here after candidate-pool review and hard controls pass.')}</div> : null}
      </div>
      <PaginationControls page={page?.page ?? 1} totalPages={page?.totalPages ?? 1} total={page?.total ?? 0} onPageChange={onPageChange} />
    </section>
  )
}

function AshareCandidatePoolPanel({
  snapshot,
  page,
  filter,
  saving,
  onFilterChange,
  onPageChange,
  onSave,
}: {
  snapshot?: LiveCandidatePoolSnapshot
  page?: SimulationHistoryPage<LiveCandidatePoolItem>
  filter: LiveCandidatePoolHistoryFilter
  saving: boolean
  onFilterChange: (filter: LiveCandidatePoolHistoryFilter) => void
  onPageChange: (page: number) => void
  onSave: (input: UpdateTradeStrategyConfigRequest) => void
}) {
  const language = useUiStore((state) => state.language)
  const items = page?.items ?? []
  const enabled = snapshot?.executionMode === 'candidate_pool'
  const tradingAgentModeEnabled = snapshot?.executionMode === 'trading_agent'
  const activePreset = snapshot?.timingPresets.find((preset) => preset.id === snapshot.presetId)
  if (!enabled) {
    return (
      <section className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{copy(language, '组合策略', 'Portfolio Strategy')}</p>
            <h2 className="mt-2 text-2xl font-semibold text-stone-950">{tradingAgentModeEnabled ? copy(language, '多角色交易代理模式 · 候选池已收起', 'Trading Agent Mode · Candidate Pool Hidden') : copy(language, '组合策略已关闭 · 候选池已收起', 'Portfolio Strategy Off · Candidate Pool Hidden')}</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              {tradingAgentModeEnabled
                ? copy(language, '当前执行模式为多角色交易代理：非观望信号走多角色代理裁决，不写入候选池；候选池历史和时间预设在本模式下收起。', 'Current execution mode is Trading Agent: non-hold signals go through multi-role agent decisions and do not enter the candidate pool. Candidate-pool history and timing presets are hidden in this mode.')
                : copy(language, '当前执行模式为大模型直推：非观望信号不写入候选池，不调用组合裁决提示词；候选池历史和时间预设在直推模式下收起。', 'Current execution mode is direct LLM: non-hold signals do not enter the candidate pool or call the portfolio-decision prompt. Candidate-pool history and timing presets are hidden in direct mode.')}
            </p>
          </div>
          <Badge tone={tradingAgentModeEnabled ? 'amber' : 'cyan'}>{tradingAgentModeEnabled ? copy(language, '多角色交易代理实验', 'Trading Agent Experiment') : copy(language, '大模型直推', 'Direct LLM')}</Badge>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <ConfigTile
            label={copy(language, '当前链路', 'Current Flow')}
            value={tradingAgentModeEnabled ? copy(language, '多角色交易代理裁决', 'Trading Agent Decision') : copy(language, '大模型直推', 'Direct LLM')}
            note={tradingAgentModeEnabled ? copy(language, '标的扫描 -> 多角色代理 -> 投资组合经理最终裁决 -> 硬风控 -> 人工确认', 'Ticker scan -> multi-role agents -> PM final decision -> hard controls -> manual confirmation') : copy(language, '标的扫描 -> 大模型单票决策 -> 硬风控 -> 人工确认', 'Ticker scan -> single LLM decision -> hard controls -> manual confirmation')}
          />
          <ConfigTile
            label={copy(language, '候选池状态', 'Candidate Pool Status')}
            value={copy(language, '已收起', 'Hidden')}
            note={`${copy(language, '已有候选历史保留；切回候选池模式后再展开查看。当前历史候选', 'Existing candidate history is preserved and shown again after switching back to candidate-pool mode. Current historical candidates')}: ${page?.total ?? items.length}`}
          />
        </div>
      </section>
    )
  }
  return (
    <section className={`rounded-3xl border p-6 shadow-sm backdrop-blur ${enabled ? 'border-rose-200 bg-rose-50/70' : 'border-orange-200/70 bg-white/90'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={`text-xs font-semibold tracking-[0.25em] ${enabled ? 'text-orange-700' : 'text-amber-700'}`}>{copy(language, '组合策略', 'Portfolio Strategy')}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{enabled ? copy(language, '新增：候选池与组合裁决', 'Candidate Pool and Portfolio Decision') : tradingAgentModeEnabled ? copy(language, '多角色交易代理模式 · 候选池只读', 'Trading Agent Mode · Candidate Pool Read-only') : copy(language, '组合策略已关闭 · 老逻辑直推', 'Portfolio Strategy Off · Legacy Direct')}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {enabled
              ? copy(language, '非观望信号先进入候选池，经组合裁决和硬风控后才进入待确认订单。', 'Non-hold signals enter the candidate pool first, then reach pending orders only after portfolio decision and hard controls.')
              : tradingAgentModeEnabled
                ? copy(language, '当前执行模式为多角色交易代理：非观望信号走多角色代理裁决，不写入候选池；已有候选只读保留。', 'Current execution mode is Trading Agent: non-hold signals go through multi-role agent decisions and do not enter the candidate pool; existing candidates are read-only.')
                : copy(language, '后续非观望信号不写入候选池，不调用组合裁决提示词，直接进入后端硬风控；已有候选只读保留。', 'Future non-hold signals do not enter the candidate pool or call the portfolio-decision prompt; existing candidates remain read-only.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={enabled || tradingAgentModeEnabled ? 'amber' : 'cyan'}>{enabled ? copy(language, '组合策略已开启', 'Portfolio Strategy On') : tradingAgentModeEnabled ? copy(language, '多角色交易代理实验', 'Trading Agent Experiment') : copy(language, '老逻辑直推', 'Legacy Direct')}</Badge>
          <Badge tone="cyan">{snapshot?.promptLabel ?? '组合裁决提示词 v1'}</Badge>
          <Badge tone="slate">{activePreset?.label ?? snapshot?.presetLabel ?? 'DeepSeek 平衡版 v1'}</Badge>
        </div>
      </div>

      <div className={`mt-5 rounded-2xl border p-4 text-sm leading-6 ${enabled ? 'border-orange-200 bg-orange-50 text-orange-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
        {enabled
          ? copy(language, '当前处于组合策略开启状态：历史策略信号仍完整记录所有单标的判断；非观望信号先进入候选池；候选池经组合裁决和硬风控后，才进入待确认订单队列。', 'Portfolio strategy is on: signal history still records every single-name decision. Non-hold signals enter the candidate pool first and reach pending orders only after portfolio decision and hard controls.')
          : tradingAgentModeEnabled
            ? copy(language, '当前处于多角色交易代理实验状态：历史策略信号记录代理中间报告；候选池不参与本模式；最终买入或平仓卖出仍必须经过硬风控和人工确认。', 'Trading Agent experiment is active: signal history records intermediate agent reports. The candidate pool is not involved, and final buy or sell-to-close still requires hard controls and manual confirmation.')
            : copy(language, '当前处于老逻辑直推状态：后续非观望信号不写入候选池，不调用组合裁决提示词，直接进入后端硬风控。', 'Legacy direct mode is active: future non-hold signals do not enter the candidate pool or call the portfolio-decision prompt; they go directly to backend hard controls.')}
      </div>

      <div className="mt-5 grid gap-3 xl:grid-cols-4">
        <ConfigTile label={copy(language, '当前链路', 'Current Flow')} value={enabled ? copy(language, '候选池组合裁决', 'Candidate-Pool Decision') : tradingAgentModeEnabled ? copy(language, '多角色交易代理裁决', 'Trading Agent Decision') : copy(language, '老逻辑直推', 'Legacy Direct')} note={enabled ? copy(language, '标的扫描 -> 候选池 -> 组合裁决 -> 硬风控 -> 人工确认', 'Ticker scan -> candidate pool -> portfolio decision -> hard controls -> manual confirmation') : tradingAgentModeEnabled ? copy(language, '标的扫描 -> 多角色代理 -> 投资组合经理最终裁决 -> 硬风控 -> 人工确认', 'Ticker scan -> multi-role agents -> PM final decision -> hard controls -> manual confirmation') : copy(language, '标的扫描 -> 硬风控 -> 人工确认', 'Ticker scan -> hard controls -> manual confirmation')} />
        <ConfigTile label={copy(language, '组合裁决提示词', 'Portfolio Prompt')} value={snapshot?.promptLabel ?? copy(language, '实盘候选池组合裁决提示词 v1', 'Live candidate-pool portfolio prompt v1')} note={`${copy(language, '配置版本', 'Config version')} v${snapshot?.promptConfigVersion ?? 1}`} />
        <ConfigTile label={copy(language, '时间预设', 'Timing Preset')} value={activePreset?.label ?? snapshot?.presetLabel ?? 'DeepSeek balanced v1'} note={copy(language, '用于候选有效期、冷却和组合裁决频率', 'Controls candidate TTL, cooldown, and portfolio review frequency')} />
        <ConfigTile label={copy(language, '裁决输出结构', 'Decision Output')} value={`${snapshot?.decisionRuleCount ?? 0} ${copy(language, '条规则', 'rules')}`} note={`${copy(language, '包含', 'Includes')}：${(snapshot?.requiredJsonKeys ?? []).slice(0, 4).join(' / ') || 'promotedCandidates'}`} />
      </div>

      <div className="mt-5 grid gap-3 xl:grid-cols-3">
        {snapshot?.timingPresets.length ? snapshot.timingPresets.map((preset) => (
          <div
            key={preset.id}
            className={`rounded-2xl border p-4 transition ${preset.id === snapshot.presetId ? 'border-orange-300 bg-orange-50 shadow-sm' : 'border-stone-200 bg-white/90 hover:border-orange-200 hover:bg-orange-50/50'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-stone-500">{copy(language, '时间预设', 'Timing Preset')} v{preset.version}</p>
                <h3 className="mt-1 text-lg font-semibold text-stone-950">{preset.label}</h3>
              </div>
              {preset.id === snapshot.presetId ? <Badge tone="amber">{copy(language, '当前', 'Current')}</Badge> : null}
            </div>
            <p className="mt-2 min-h-10 text-xs leading-5 text-stone-500">{preset.description}</p>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <PresetMetric label={copy(language, '标的扫描', 'Ticker Scan')} value={`${preset.singleSignalScanIntervalMinutes} ${copy(language, '分钟', 'min')}`} />
              <PresetMetric label={copy(language, '组合裁决', 'Portfolio Review')} value={`${preset.portfolioReviewIntervalMinutes} ${copy(language, '分钟', 'min')}`} />
              <PresetMetric label={copy(language, '候选有效期', 'Candidate TTL')} value={`${preset.candidateTtlMinutes} ${copy(language, '分钟', 'min')}`} />
              <PresetMetric label={copy(language, '每轮推进', 'Promoted per Review')} value={`${preset.maxPromotedOrdersPerReview} ${copy(language, '单', 'orders')}`} />
            </div>
            <button
              className={`mt-4 w-full rounded-2xl px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60 ${preset.id === snapshot.presetId ? 'bg-orange-300 text-stone-950' : enabled ? 'bg-white text-orange-800 ring-1 ring-orange-200 hover:bg-orange-400 hover:text-stone-950' : 'bg-stone-50 text-stone-500 ring-1 ring-stone-200'}`}
              disabled={!enabled || saving || preset.id === snapshot.presetId}
              onClick={() => onSave({ portfolioTimingPresetId: preset.id })}
              type="button"
            >
              {!enabled ? copy(language, '组合策略关闭，不可切换', 'Portfolio strategy is off') : preset.id === snapshot.presetId ? copy(language, '当前使用中', 'In Use') : saving ? copy(language, '保存中', 'Saving') : copy(language, '切换到此预设', 'Switch to This Preset')}
            </button>
          </div>
        )) : (
          <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800 xl:col-span-3">{copy(language, '组合策略时间预设尚未从后端加载。请检查组合裁决配置是否被服务读取。', 'Portfolio timing presets have not loaded from the backend. Check whether the portfolio-decision config was read by the service.')}</div>
        )}
      </div>

      <div className="mt-5 rounded-2xl border border-stone-200 bg-stone-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-stone-950">{copy(language, '候选池历史', 'Candidate Pool History')}（{page?.total ?? items.length}）</h3>
            <p className="mt-1 text-xs text-stone-500">{copy(language, '按候选最新状态分页；组合策略关闭时只读保留。', 'Paged by latest candidate status; retained as read-only when portfolio strategy is off.')}</p>
          </div>
          <AshareFilterChips items={localizeCandidatePoolHistoryFilters(language)} value={filter} onChange={onFilterChange} />
        </div>
      </div>

      <div className="mt-3 overflow-x-auto rounded-2xl border border-orange-100">
        <table className="min-w-[1120px] w-full table-fixed text-sm">
          <thead className="bg-orange-50 text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              {(language === 'zh' ? ['候选', '分组', '确认', '价格偏离', '名义金额', '状态', '时间', '裁决说明'] : ['Candidate', 'Group', 'Confirms', 'Price Drift', 'Notional', 'Status', 'Time', 'Decision Reason']).map((column) => <th key={column} className="px-4 py-3">{column}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-orange-100">
            {items.map((candidate) => (
              <tr key={candidate.candidateId}>
                <td className="px-4 py-3 font-black text-stone-950">
                  {candidate.ticker} · <span className={sideTone(candidate.action)}>{sideLabel(candidate.action, language)}</span>
                  <div className="mt-1 truncate text-xs font-normal text-stone-500">{candidate.candidateId}</div>
                </td>
                <td className="px-4 py-3 text-stone-600">{candidate.groupKey}</td>
                <td className="px-4 py-3 text-stone-600">{candidate.signalCount} {copy(language, '次', 'x')}</td>
                <td className="px-4 py-3 text-stone-600">{candidate.priceDriftPct.toFixed(2)}%</td>
                <td className="px-4 py-3 text-stone-600">{copy(language, '人民币', 'CNY')} {candidate.proposedNotional.toFixed(2)}</td>
                <td className="px-4 py-3"><span className={`rounded-xl px-3 py-2 text-xs font-black ${candidateStatusTone(candidate.status)}`}>{candidateStatusLabel(candidate.status, language)}</span></td>
                <td className="px-4 py-3 text-stone-600">
                  <div className="whitespace-nowrap font-semibold">{formatDateTime(candidate.lastSeenAt, language)}</div>
                  <div className="mt-1 whitespace-nowrap text-xs text-stone-500">{copy(language, '首次', 'First')} {formatDateTime(candidate.firstSeenAt, language)}</div>
                </td>
                <td className="px-4 py-3 text-stone-600">{candidate.portfolioDecisionReason ?? candidate.confidence}</td>
              </tr>
            ))}
            {!items.length ? <tr><td className="px-4 py-6 text-stone-500" colSpan={8}>{copy(language, '暂无 A 股候选池历史。', 'No A-share candidate-pool history yet.')}</td></tr> : null}
          </tbody>
        </table>
      </div>
      <PaginationControls page={page?.page ?? 1} totalPages={page?.totalPages ?? 1} total={page?.total ?? 0} onPageChange={onPageChange} />
    </section>
  )
}

function AshareFilterChips<T extends string>({ label, items, value, onChange }: { label?: string; items: Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label ? <span className="w-16 shrink-0 text-xs font-semibold text-stone-500">{label}</span> : null}
      {items.map((item) => (
        <button
          key={item.value}
          className={`rounded-xl px-3 py-2 text-xs font-black transition ${item.value === value ? 'bg-orange-500 text-white shadow-sm shadow-orange-200' : 'bg-white text-stone-600 ring-1 ring-orange-100 hover:bg-orange-50'}`}
          onClick={() => onChange(item.value)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function ConfigTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white/90 p-4">
      <p className="text-xs font-semibold text-stone-500">{label}</p>
      <p className="mt-2 break-words text-lg font-semibold text-stone-950">{value}</p>
      <p className="mt-1 text-xs leading-5 text-stone-500">{note}</p>
    </div>
  )
}

function PresetMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">
      <p className="text-stone-500">{label}</p>
      <p className="mt-1 font-semibold text-stone-900">{value}</p>
    </div>
  )
}

function AshareFilterSelect({ label, value, items, onChange }: { label: string; value: string; items: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs font-semibold text-stone-500">
      <span className="w-16 shrink-0">{label}</span>
      <select className="min-w-0 flex-1 rounded-xl border border-orange-100 bg-white px-3 py-2 text-xs font-black text-stone-950 outline-none focus:border-orange-300" value={value} onChange={(event) => onChange(event.target.value)}>
        {items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </label>
  )
}

function CompactField({ label, value, note, className = '' }: { label: string; value: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="text-[11px] font-semibold text-stone-500">{label}</p>
      <p className="mt-1 truncate font-semibold text-stone-800">{value}</p>
      {note ? <p className="mt-1 truncate text-xs text-stone-500">{note}</p> : null}
    </div>
  )
}

function CollapsibleText({ text, maxLength, className = '' }: { text: string; maxLength: number; className?: string }) {
  const language = useUiStore((state) => state.language)
  if (text.length <= maxLength) return <p className={className}>{text}</p>
  return (
    <div className={className}>
      <p>{compactText(text, maxLength)}</p>
      <details className="mt-2">
        <summary className="inline-flex cursor-pointer rounded-xl border border-orange-200 bg-white px-3 py-1 text-xs font-black text-orange-800 hover:bg-orange-50">
          {copy(language, '展开全文', 'Expand Full Text')}
        </summary>
        <p className="mt-2 whitespace-pre-wrap rounded-xl border border-orange-100 bg-white/80 p-3 text-sm leading-6 text-stone-700">{text}</p>
      </details>
    </div>
  )
}

function PaginationControls({ page, totalPages, total, onPageChange }: { page: number; totalPages: number; total: number; onPageChange: (page: number) => void }) {
  const language = useUiStore((state) => state.language)
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600">
      <span>{copy(language, `共 ${total} 条，第 ${page}/${totalPages} 页`, `${total} total, page ${page}/${totalPages}`)}</span>
      <div className="flex gap-2">
        <button className="rounded-xl border border-orange-100 bg-white px-3 py-1 font-semibold disabled:opacity-50" disabled={page <= 1} onClick={() => onPageChange(page - 1)} type="button">{copy(language, '上一页', 'Previous')}</button>
        <button className="rounded-xl border border-orange-100 bg-white px-3 py-1 font-semibold disabled:opacity-50" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} type="button">{copy(language, '下一页', 'Next')}</button>
      </div>
    </div>
  )
}

function compactText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function copy(language: UiLanguage, zh: string, en: string) {
  return language === 'zh' ? zh : en
}

function displayAccountValue(value?: string) {
  return value && value !== 'unavailable' ? value : '-'
}

function normalizeTicker(value?: string) {
  return (value ?? '').trim().toUpperCase().replace(/^([0-9]{6})\.(SH|SZ)$/, '$2.$1')
}

function tickerFilterItems(tickers: string[]) {
  const unique = [...new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean))]
  return [
    { value: 'ALL', label: '全部标的' },
    ...unique.sort((left, right) => left.localeCompare(right)).map((ticker) => ({ value: ticker, label: ticker })),
  ]
}

function localizeTickerItems(items: Array<{ value: string; label: string }>, language: UiLanguage) {
  return items.map((item) => (item.value === 'ALL' ? { ...item, label: copy(language, '全部标的', 'All Tickers') } : item))
}

function localizePendingStatusFilters(language: UiLanguage): Array<{ value: LivePendingOrderStatusFilter; label: string }> {
  return PENDING_STATUS_FILTERS.map((item) => ({ value: item.value, label: pendingStatusLabel(item.value, language) }))
}

function localizePendingSideFilters(language: UiLanguage): Array<{ value: LivePendingOrderSideFilter; label: string }> {
  return A_SHARE_PENDING_SIDE_FILTERS.map((item) => ({ value: item.value, label: sideLabel(item.value, language, item.value === 'ALL') }))
}

function localizeSignalLifecycleFilters(language: UiLanguage): Array<{ value: LiveSignalLifecycleFilter; label: string }> {
  return SIGNAL_LIFECYCLE_FILTERS.map((item) => ({ value: item.value, label: signalStatusLabel(item.value, language) }))
}

function localizeSignalDirectionFilters(language: UiLanguage): Array<{ value: LiveSignalDirectionFilter; label: string }> {
  return SIGNAL_DIRECTION_FILTERS.map((item) => ({ value: item.value, label: sideLabel(item.value, language, item.value === 'ALL') }))
}

function localizeCandidatePoolHistoryFilters(language: UiLanguage): Array<{ value: LiveCandidatePoolHistoryFilter; label: string }> {
  return CANDIDATE_POOL_HISTORY_FILTERS.map((item) => ({
    value: item.value,
    label: item.value === 'ACTIVE' ? copy(language, '生效中', 'Active') : copy(language, '已失效', 'Inactive'),
  }))
}

function sideLabel(side: string, language: UiLanguage = 'zh', all = false) {
  if (all) return copy(language, '全部', 'All')
  const zhLabels: Record<string, string> = {
    HOLD: '观望',
    BUY: '买入',
    SELL_SHORT: '卖空',
    SELL_TO_CLOSE: '平仓卖出',
  }
  const enLabels: Record<string, string> = {
    HOLD: 'Hold',
    BUY: 'Buy',
    SELL_SHORT: 'Short Sell',
    SELL_TO_CLOSE: 'Sell to Close',
  }
  const labels = language === 'zh' ? zhLabels : enLabels
  return labels[side] ?? side
}

function sideTone(side: string) {
  if (side === 'BUY') return 'text-red-600'
  if (side === 'SELL_TO_CLOSE') return 'text-emerald-600'
  if (side === 'SELL_SHORT') return 'text-rose-700'
  return 'text-stone-700'
}

function pendingStatusLabel(status: string, language: UiLanguage = 'zh') {
  const zhLabels: Record<string, string> = {
    ALL: '全部',
    PENDING_CONFIRMATION: '待确认',
    CONFIRMED_SUBMITTING: '提交中',
    SUBMITTED: '已提交',
    REJECTED_BY_USER: '已拒绝',
    EXPIRED: '已过期',
    BLOCKED_BY_RISK: '风控关闭',
    SUBMIT_FAILED: '提交失败',
  }
  const enLabels: Record<string, string> = {
    ALL: 'All',
    PENDING_CONFIRMATION: 'Pending',
    CONFIRMED_SUBMITTING: 'Submitting',
    SUBMITTED: 'Submitted',
    REJECTED_BY_USER: 'Rejected',
    EXPIRED: 'Expired',
    BLOCKED_BY_RISK: 'Risk Blocked',
    SUBMIT_FAILED: 'Submit Failed',
  }
  const labels = language === 'zh' ? zhLabels : enLabels
  return labels[status] ?? status
}

function pendingStatusTone(status: string) {
  if (status === 'PENDING_CONFIRMATION') return 'bg-orange-100 text-orange-800'
  if (status === 'SUBMITTED') return 'bg-emerald-100 text-emerald-800'
  if (status === 'SUBMIT_FAILED' || status === 'BLOCKED_BY_RISK') return 'bg-rose-100 text-rose-800'
  return 'bg-stone-100 text-stone-700'
}

function signalStatusTone(status: string) {
  if (status === 'SUBMITTED') return 'bg-emerald-100 text-emerald-800'
  if (status === 'SUBMIT_FAILED' || status === 'BLOCKED_BY_RISK') return 'bg-rose-100 text-rose-800'
  if (status === 'SKIPPED') return 'bg-amber-100 text-amber-800'
  if (status === 'HOLD' || status === 'EXPIRED' || status === 'REJECTED_BY_USER') return 'bg-stone-100 text-stone-700'
  return 'bg-orange-100 text-orange-800'
}

function signalStatusLabel(status: string, language: UiLanguage = 'zh') {
  const zhLabels: Record<string, string> = {
    ALL: '全部',
    HOLD: '观望',
    CANDIDATE_POOL: '候选池中',
    PENDING_CONFIRMATION: '待确认',
    CONFIRMED_SUBMITTING: '提交中',
    SUBMITTED: '已提交',
    REJECTED_BY_USER: '已拒绝',
    EXPIRED: '已过期',
    BLOCKED_BY_RISK: '风控关闭',
    SUBMIT_FAILED: '提交失败',
    SKIPPED: '未入队/拦截',
  }
  const enLabels: Record<string, string> = {
    ALL: 'All',
    HOLD: 'Hold',
    CANDIDATE_POOL: 'In Candidate Pool',
    PENDING_CONFIRMATION: 'Pending',
    CONFIRMED_SUBMITTING: 'Submitting',
    SUBMITTED: 'Submitted',
    REJECTED_BY_USER: 'Rejected',
    EXPIRED: 'Expired',
    BLOCKED_BY_RISK: 'Risk Blocked',
    SUBMIT_FAILED: 'Submit Failed',
    SKIPPED: 'Skipped/Blocked',
  }
  const labels = language === 'zh' ? zhLabels : enLabels
  return labels[status] ?? status
}

function formatTrendAlignment(value?: string, side?: string, language: UiLanguage = 'zh') {
  const zhLabels: Record<string, string> = {
    WITH_TREND: '顺趋势',
    AGAINST_TREND: '逆趋势',
    REVERSAL_ATTEMPT: '反转尝试',
    NO_TREND: '无明确趋势',
    UNAVAILABLE: side === 'HOLD' ? '观望，不判定趋势' : '旧信号未计算',
  }
  const enLabels: Record<string, string> = {
    WITH_TREND: 'With Trend',
    AGAINST_TREND: 'Against Trend',
    REVERSAL_ATTEMPT: 'Reversal Attempt',
    NO_TREND: 'No Clear Trend',
    UNAVAILABLE: side === 'HOLD' ? 'Hold, trend not evaluated' : 'Legacy signal not calculated',
  }
  const labels = language === 'zh' ? zhLabels : enLabels
  return labels[value ?? 'UNAVAILABLE'] ?? value ?? '旧信号未计算'
}

function candidateStatusLabel(status: string, language: UiLanguage = 'zh') {
  const zhLabels: Record<string, string> = {
    ACTIVE: '生效中',
    WATCH: '观察',
    PROMOTED: '已推进',
    SUPPRESSED: '已暂缓',
    EXPIRED: '已过期',
    DISABLED_BY_MODE_SWITCH: '模式关闭只读',
  }
  const enLabels: Record<string, string> = {
    ACTIVE: 'Active',
    WATCH: 'Watch',
    PROMOTED: 'Promoted',
    SUPPRESSED: 'Suppressed',
    EXPIRED: 'Expired',
    DISABLED_BY_MODE_SWITCH: 'Read-only by Mode',
  }
  const labels = language === 'zh' ? zhLabels : enLabels
  return labels[status] ?? status
}

function candidateStatusTone(status: string) {
  if (status === 'PROMOTED') return 'bg-emerald-100 text-emerald-800'
  if (status === 'SUPPRESSED' || status === 'EXPIRED' || status === 'DISABLED_BY_MODE_SWITCH') return 'bg-stone-100 text-stone-700'
  return 'bg-orange-100 text-orange-800'
}

function agentRoleLabel(role: string, language: UiLanguage = 'zh') {
  const normalized = role.toLowerCase().replace(/\s+/g, '_')
  const zhLabels: Record<string, string> = {
    market_analyst: '行情分析员',
    risk_analyst: '风险分析员',
    bull_researcher: '看多研究员',
    bear_researcher: '看空研究员',
    portfolio_manager: '投资组合经理',
    portfolio_management: '投资组合经理',
    tradingagents_adapter: '交易代理适配器',
    adapter: '交易代理适配器',
  }
  const enLabels: Record<string, string> = {
    market_analyst: 'Market Analyst',
    risk_analyst: 'Risk Analyst',
    bull_researcher: 'Bull Researcher',
    bear_researcher: 'Bear Researcher',
    portfolio_manager: 'Portfolio Manager',
    portfolio_management: 'Portfolio Manager',
    tradingagents_adapter: 'TradingAgents Adapter',
    adapter: 'TradingAgents Adapter',
  }
  const labels = language === 'zh' ? zhLabels : enLabels
  return labels[normalized] ?? role
}

function agentStatusLabel(status?: string, language: UiLanguage = 'zh') {
  const normalized = String(status ?? '').toUpperCase()
  const zhLabels: Record<string, string> = {
    OK: '正常',
    WATCH: '观察',
    ERROR: '异常',
  }
  const enLabels: Record<string, string> = {
    OK: 'OK',
    WATCH: 'Watch',
    ERROR: 'Error',
  }
  const labels = language === 'zh' ? zhLabels : enLabels
  return labels[normalized] ?? (status || copy(language, '未知', 'Unknown'))
}

function formatAgentConfidence(value: unknown, language: UiLanguage = 'zh') {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return copy(language, '不可用', 'Unavailable')
  if (parsed > 0 && parsed <= 1) return `${(parsed * 100).toFixed(0)}%`
  return `${parsed.toFixed(0)}%`
}

function formatSignalPrice(value?: string, language: UiLanguage = 'zh') {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return `¥${parsed.toFixed(2)}`
  return value || copy(language, '不可用', 'Unavailable')
}

function formatDecisionMode(mode?: string, language: UiLanguage = 'zh') {
  if (mode === 'trading_agent') return copy(language, '多角色交易代理裁决', 'Trading Agent Decision')
  if (mode === 'candidate_pool') return copy(language, '候选池裁决', 'Candidate-Pool Decision')
  if (mode === 'legacy_direct') return copy(language, '大模型直推', 'Direct LLM')
  return mode ?? copy(language, 'A股独立队列', 'A-share isolated queue')
}

function formatFee(fee?: LiveOrderFeeContext, language: UiLanguage = 'zh') {
  if (!fee || fee.feeAmount === null || fee.feeAmount === undefined) return copy(language, '不可用', 'Unavailable')
  return `${fee.currency ?? 'CNY'} ${fee.feeAmount.toFixed(2)}`
}

function formatDateTime(value?: string, language: UiLanguage = 'zh') {
  if (!value) return copy(language, '不可用', 'Unavailable')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
}
