import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, Eye, RefreshCw, ShieldAlert } from 'lucide-react'
import AppNav from '@/components/common/AppNav'
import AssetPrivacyToggle from '@/components/common/AssetPrivacyToggle'
import Badge from '@/components/common/Badge'
import TradeStrategyConfigPanel from '@/components/trading/TradeStrategyConfigPanel'
import ManagedOrdersPanel from '@/components/ManagedOrdersPanel'
import { useLiveTrading } from '@/hooks/useLiveTrading'
import { useUiStore } from '@/stores/uiStore'
import { maskAssetValue } from '@/utils/displayText'
import { displayOrderPriceWithType, displayOrderSession, displaySignalModel, displaySide } from '@/utils/simulationDisplay'
import type { LiveCandidatePoolHistoryFilter, LiveCandidatePoolItem, LiveCandidatePoolSnapshot, LivePendingOrder, LivePendingOrderSideFilter, LivePendingOrderStatusFilter, LiveSignalDirectionFilter, LiveSignalHistoryItem, LiveSignalLifecycleFilter, LiveSkippedTicker, SimulationHistoryPage, TradeExecutionMode, UpdateTradeStrategyConfigRequest } from '../../shared/types'

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

const PENDING_SIDE_FILTERS: Array<{ value: LivePendingOrderSideFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'BUY', label: '买入' },
  { value: 'SELL_SHORT', label: '卖空' },
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
  { value: 'SELL_SHORT', label: '卖空' },
  { value: 'SELL_TO_CLOSE', label: '平仓卖出' },
]

const CANDIDATE_POOL_HISTORY_FILTERS: Array<{ value: LiveCandidatePoolHistoryFilter; label: string }> = [
  { value: 'ACTIVE', label: '生效中' },
  { value: 'INACTIVE', label: '已失效' },
]

export default function LiveTradingView() {
  const {
    data,
    history,
    tradeStrategyConfig,
    futuOrders,
    managedOrders,
    cancelingManagedOrderId,
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    signalTickerFilter,
    signalDirectionFilter,
    signalLifecycleFilter,
    candidatePoolHistoryFilter,
    loading,
    savingConfig,
    savingSettings,
    confirmingOrderId,
    rejectingOrderId,
    expiringPendingOrders,
    refreshing,
    error,
    refresh,
    start,
    stop,
    runOnce,
    setHistoryPage,
    setPendingOrderStatusFilter,
    setPendingOrderTickerFilter,
    setPendingOrderSideFilter,
    setSignalTickerFilter,
    setSignalDirectionFilter,
    setSignalLifecycleFilter,
    setCandidatePoolHistoryFilter,
    setFutuOrdersPage,
    saveLlmConfig,
    saveTradeStrategyConfig,
    confirmOrder,
    rejectOrder,
    batchExpirePendingOrders,
    updateAutoSubmit,
    updateAutoCancel,
    cancelManagedOrder,
  } = useLiveTrading()
    const assetPrivacyHidden = useUiStore((state) => state.assetPrivacyHidden)
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedConcurrency, setSelectedConcurrency] = useState(0)
  const [disableUsOvernightLlm, setDisableUsOvernightLlm] = useState(true)
  const [confirmingOrder, setConfirmingOrder] = useState<LivePendingOrder>()

  const runtimeConfig = data?.llmRuntimeConfig
  const modelValue = selectedModel || runtimeConfig?.model || ''
  const concurrencyValue = selectedConcurrency || runtimeConfig?.concurrency || 1
  const concurrencyOptions = useMemo(() => Array.from({ length: runtimeConfig?.maxConcurrency ?? 1 }, (_, index) => index + 1), [runtimeConfig?.maxConcurrency])
  const pendingOrdersPage = history['pending-orders']
  const rawPendingOrders = pendingOrdersPage?.items ?? data?.pendingOrders ?? []
  const pendingOrders = filterPendingOrders(rawPendingOrders, pendingOrderStatusFilter, pendingOrderTickerFilter, pendingOrderSideFilter)
  const pendingOrdersRenderKey = [
    pendingOrderStatusFilter,
    pendingOrderTickerFilter,
    pendingOrderSideFilter,
    pendingOrdersPage?.page ?? 1,
    pendingOrdersPage?.total ?? pendingOrders.length,
    pendingOrders.map((order) => order.id).join('|'),
  ].join(':')
  const pendingTickerFilterItems = useMemo(
    () => pendingOrderTickerFilterItems(data?.universe ?? [], rawPendingOrders),
    [data?.universe, rawPendingOrders],
  )
  const signalItems = history.signals?.items ?? data?.latestSignals ?? []
  const signalTickerFilterItems = useMemo(
    () => historySignalTickerFilterItems(data?.universe ?? [], signalItems),
    [data?.universe, signalItems],
  )
  const activePendingOrders = pendingOrders.filter((order) => order.status === 'PENDING_CONFIRMATION' || order.status === 'CONFIRMED_SUBMITTING')
  const visibleExpirablePendingOrders = pendingOrders.filter((order) => order.status === 'PENDING_CONFIRMATION')
  const canBatchExpirePendingOrders = visibleExpirablePendingOrders.length > 0 && (pendingOrderStatusFilter === 'ALL' || pendingOrderStatusFilter === 'PENDING_CONFIRMATION')
  const engineRunning = Boolean(data?.engine.running)
  const actionBusy = loading || refreshing
  const liveEnabled = Boolean(data?.liveTradingEnabled)
  const autoSubmitEnabled = Boolean(data?.autoSubmitEnabled)
  const autoCancelEnabled = Boolean(data?.autoCancelEnabled)

  useEffect(() => {
    if (!runtimeConfig) return
    setDisableUsOvernightLlm(runtimeConfig.disableUsOvernightLlm)
  }, [runtimeConfig])

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <header className="rounded-3xl border border-orange-300/30 bg-white/90 p-6 shadow-2xl shadow-rose-200/30 backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">FUTU REAL</p>
              <h1 className="mt-2 flex items-center gap-3 text-3xl font-semibold">
                <ShieldAlert className="text-orange-300" />
                真实操作盘量化交易
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-600">大模型只生成策略信号和待确认订单；确认弹窗提交前会展示方向、数量、价格、费用、持仓影响和风险，真实订单默认受环境变量门禁保护。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="amber">{data?.account.trading.environment ?? 'REAL'}</Badge>
              <Badge tone={liveEnabled ? 'emerald' : 'amber'}>{liveEnabled ? 'LIVE_TRADING_ENABLED' : '实盘提交门禁关闭'}</Badge>
              <Badge tone={autoSubmitEnabled ? 'red' : 'cyan'}>{autoSubmitEnabled ? '自动下单开启' : '人工确认模式'}</Badge>
              <Badge tone={tradeStrategyConfig?.selection.executionMode === 'candidate_pool' ? 'amber' : 'cyan'}>
                {tradeStrategyConfig?.selection.executionMode === 'candidate_pool' ? '组合策略已开启' : '老逻辑直推'}
              </Badge>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button className="rounded-2xl bg-gradient-to-r from-orange-500 via-orange-500 to-rose-500 px-4 py-2 text-sm font-bold text-stone-950 shadow-lg shadow-rose-200/30 hover:from-orange-400 hover:via-rose-400 hover:to-rose-400 disabled:cursor-not-allowed disabled:opacity-50" onClick={start} disabled={actionBusy || engineRunning}>
              {engineRunning ? '实盘评估运行中' : actionBusy ? '请求中...' : '启动实盘评估'}
            </button>
            <button className="rounded-2xl bg-white/90 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50" onClick={stop} disabled={actionBusy || !engineRunning}>停止</button>
            <button className="rounded-2xl bg-white/90 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50" onClick={runOnce} disabled={actionBusy}>单轮评估</button>
            <button className="inline-flex items-center rounded-2xl bg-white/90 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-stone-100" onClick={() => refresh()} disabled={refreshing}>
              <RefreshCw className="mr-2" size={16} />
              {refreshing ? '刷新中...' : '刷新当前页'}
            </button>
          </div>
        </header>

        {error ? <div className="rounded-2xl border border-orange-300/40 bg-orange-500/15 px-4 py-3 text-sm text-orange-800">{error}</div> : null}

        <section className="rounded-3xl border border-rose-200 bg-white/90 p-5 shadow-lg shadow-rose-100/40 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-rose-700">真实订单提交</p>
              <h2 className="mt-2 text-xl font-semibold">Futu 自动下单开关</h2>
              <p className="mt-2 text-sm text-stone-600">
                关闭时：直推或组合策略只生成待确认订单，需人工点击确认提交。开启时：非观望决策通过硬风控后，会自动调用 Futu REAL 订单接口提交。
              </p>
            </div>
            <button
              className={`rounded-2xl px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${autoSubmitEnabled ? 'bg-rose-600 hover:bg-rose-500' : 'bg-orange-600 hover:bg-orange-500'}`}
              disabled={savingSettings || !liveEnabled}
              onClick={() => updateAutoSubmit(!autoSubmitEnabled)}
            >
              {savingSettings ? '保存中...' : autoSubmitEnabled ? '关闭自动下单' : '开启自动下单'}
            </button>
          </div>
          <div className="mt-4 grid gap-3 text-sm text-stone-600 md:grid-cols-3">
            <Guard ok={liveEnabled}>Futu 实盘提交门禁 {liveEnabled ? '已开启' : '未开启'}</Guard>
            <Guard ok={!autoSubmitEnabled}>当前模式：{autoSubmitEnabled ? '自动提交真实订单' : '人工确认后提交'}</Guard>
            <Guard ok={Boolean(data?.account.ok)}>Futu REAL 账户 {data?.account.ok ? '可用' : '不可用'}</Guard>
          </div>
        </section>

        <ManagedOrdersPanel
          platformLabel="Futu"
          data={managedOrders}
          autoCancelEnabled={autoCancelEnabled}
          saving={savingSettings}
          cancelingOrderId={cancelingManagedOrderId}
          onToggleAutoCancel={updateAutoCancel}
          onCancel={cancelManagedOrder}
        />

        <section className="grid gap-4 md:grid-cols-5">
          <Metric label="真实账户" value={data?.account.selectedAccountId || 'unavailable'} note="Futu REAL" />
            <Metric label="总资产" value={assetPrivacyHidden ? maskAssetValue() : data?.account.summary.totalAssets || 'unavailable'} note="REAL account" action={<AssetPrivacyToggle />} />
            <Metric label="购买力" value={assetPrivacyHidden ? maskAssetValue() : data?.account.summary.buyingPower || 'unavailable'} note="开仓风控输入" />
          <Metric label="历史策略信号" value={String(data?.engine.signalCount ?? history.signals?.total ?? data?.latestSignals.length ?? 0)} note="SQLite signals" />
          <Metric label="待确认订单" value={String(data?.engine.pendingOrderCount ?? pendingOrders.length)} note={`已提交 ${data?.engine.submittedOrderCount ?? 0}`} />
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">LLM CONFIG</p>
                <h2 className="mt-2 text-2xl font-semibold">大模型配置</h2>
                <p className="mt-2 text-sm text-stone-600">沿用模拟盘运行时配置；默认来自 ARK_MODEL / LLM_DECISION_CONCURRENCY，保存后从下一轮实盘评估生效。</p>
              </div>
              <Badge tone="cyan">{runtimeConfig?.modelLabel ?? '未加载'}</Badge>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-[1.2fr_0.7fr_1fr_auto]">
              <label className="text-sm font-semibold text-stone-600">
                模型
                <select className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-950" value={modelValue} onChange={(event) => setSelectedModel(event.target.value)}>
                  {(data?.modelOptions ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-semibold text-stone-600">
                并发
                <select className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-950" value={concurrencyValue} onChange={(event) => setSelectedConcurrency(Number(event.target.value))}>
                  {concurrencyOptions.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-3 self-end rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-700">
                <input
                  className="h-4 w-4 accent-amber-500"
                  type="checkbox"
                  checked={disableUsOvernightLlm}
                  onChange={(event) => setDisableUsOvernightLlm(event.target.checked)}
                />
                禁用美股夜盘 LLM
              </label>
              <button className="self-end rounded-2xl bg-amber-500 px-4 py-3 text-sm font-bold text-stone-950 hover:bg-amber-400" disabled={savingConfig || !modelValue} onClick={() => saveLlmConfig({ model: modelValue, concurrency: concurrencyValue, disableUsOvernightLlm })}>保存配置</button>
            </div>
            <p className="mt-3 text-xs text-stone-500">并发越高评估越快，但受 RPM / TPM 限制；开启“禁用美股夜盘 LLM”后，美股夜盘只记录跳过原因，把并发留给港股盘中。</p>
          </section>

          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
            <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">GUARDRAILS</p>
            <h2 className="mt-2 text-2xl font-semibold">实盘门禁</h2>
            <div className="mt-5 space-y-3 text-sm text-stone-600">
              <Guard ok>非观望建议通过后端硬风控后进入待确认队列</Guard>
              <Guard ok={Boolean(data?.liveTradingEnabled)}>真实提交门禁：LIVE_TRADING_ENABLED + FUTU_LIVE_TRD_ENV</Guard>
              <Guard ok>提交前估算费用，成交后通过 Futu REAL order_fee_query 回填</Guard>
              <Guard ok>SELL_SHORT 允许入队，但弹窗突出卖空风险</Guard>
            </div>
          </section>
        </section>

        <TradeStrategyConfigPanel
          title="实盘策略与提示词版本"
          subtitle="实盘策略选择独立保存；保存后从下一轮评估生效，不绕过门禁或人工确认。"
          config={tradeStrategyConfig}
          saving={savingConfig}
          dark
          showPortfolioExecutionMode
          onSave={saveTradeStrategyConfig}
        />

        <CandidatePoolPanel
          snapshot={data?.candidatePool}
          executionMode={tradeStrategyConfig?.selection.executionMode ?? data?.candidatePool?.executionMode ?? 'legacy_direct'}
          historyPage={history['candidate-pool']}
          historyFilter={candidatePoolHistoryFilter}
          saving={savingConfig}
          onHistoryFilterChange={setCandidatePoolHistoryFilter}
          onHistoryPageChange={(page) => setHistoryPage('candidate-pool', page)}
          onSave={saveTradeStrategyConfig}
        />

        <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <HistoryTable
            title={`历史策略信号（${history.signals?.total ?? data?.latestSignals.length ?? 0}）`}
            items={signalItems}
            page={history.signals?.page ?? 1}
            totalPages={history.signals?.totalPages ?? 1}
            total={history.signals?.total ?? data?.latestSignals.length ?? 0}
            skippedItems={history.skipped?.items ?? data?.skippedTickers ?? []}
            signalTickerFilter={signalTickerFilter}
            signalTickerFilterItems={signalTickerFilterItems}
            signalLifecycleFilter={signalLifecycleFilter}
            signalDirectionFilter={signalDirectionFilter}
            onTickerFilterChange={setSignalTickerFilter}
            onLifecycleFilterChange={setSignalLifecycleFilter}
            onDirectionFilterChange={setSignalDirectionFilter}
            onPageChange={(page) => setHistoryPage('signals', page)}
          />

          <section className="min-w-0 rounded-3xl border border-orange-300/20 bg-white/90 p-6 backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">待确认队列</p>
                <h2 className="mt-2 text-2xl font-semibold">待确认订单队列（{pendingOrdersPage?.total ?? pendingOrders.length}）</h2>
                <p className="mt-2 text-sm text-stone-500">这里展示已经入库的实盘候选订单，并按最新生命周期状态关闭确认入口。</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge tone="amber">{activePendingOrders.length} 待确认</Badge>
                <button
                  className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={expiringPendingOrders || !canBatchExpirePendingOrders}
                  onClick={async () => {
                    const confirmed = window.confirm(`确认将当前页筛选结果中的 ${visibleExpirablePendingOrders.length} 笔待确认订单批量过期？过期后不会提交真实订单。`)
                    if (!confirmed) return
                    await batchExpirePendingOrders({
                      ticker: pendingOrderTickerFilter === 'ALL' ? undefined : pendingOrderTickerFilter,
                      side: pendingOrderSideFilter === 'ALL' ? undefined : pendingOrderSideFilter,
                      ids: visibleExpirablePendingOrders.map((order) => order.id),
                    })
                  }}
                >
                    {expiringPendingOrders ? '过期处理中...' : '批量过期本页'}
                </button>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              <FilterSelect
                label="标的"
                value={pendingOrderTickerFilter}
                items={pendingTickerFilterItems}
                onChange={setPendingOrderTickerFilter}
              />
              <FilterChips
                label="订单状态"
                items={PENDING_STATUS_FILTERS}
                value={pendingOrderStatusFilter}
                onChange={setPendingOrderStatusFilter}
              />
              <FilterChips
                label="方向"
                items={PENDING_SIDE_FILTERS}
                value={pendingOrderSideFilter}
                onChange={setPendingOrderSideFilter}
              />
            </div>
              <div key={pendingOrdersRenderKey} className="mt-5 space-y-3">
              {pendingOrders.map((order) => (
                <div
                    key={`${pendingOrdersRenderKey}:${order.id}`}
                  className={`rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm ${order.intent.side === 'SELL_SHORT' ? 'bg-orange-500/10' : ''}`}
                >
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-stone-500">标的 / 方向</p>
                        <p className="mt-1 truncate text-base font-bold text-stone-950">
                          {order.intent.ticker} · <span className={pendingOrderSideTone(order)}>{pendingOrderSideLabel(order)}</span>
                        </p>
                      </div>
                      <CompactField
                        label="数量 / 价格"
                        value={`${order.intent.quantity} 股 · ${displayOrderPriceWithType(order.intent.orderType === 'MARKET' ? 'MARKET' : `$${order.intent.limitPrice.toFixed(2)}`, order.intent.orderType, 'zh')}`}
                        note={displayOrderSession(order.intent.orderSession, 'zh')}
                      />
                    </div>
                    <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                      {order.status === 'PENDING_CONFIRMATION' ? (
                        <button className="rounded-xl bg-gradient-to-r from-orange-500 to-rose-500 px-3 py-2 text-xs font-bold text-stone-950" onClick={() => setConfirmingOrder(order)}>确认弹窗</button>
                      ) : (
                        <span className={`rounded-xl px-3 py-2 text-xs font-bold ${livePendingStatusTone(order.status)}`}>
                          {livePendingStatusLabel(order.status)}
                        </span>
                      )}
                      <Link className="rounded-xl bg-white/90 px-3 py-2 text-xs font-bold text-stone-950" to={liveOrderDetailPath(order)}>详情</Link>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 border-t border-stone-200 pt-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                    <CompactField
                      label="费用"
                      value={order.intent.feeContext.feeAmount === null ? '不可用' : `$${order.intent.feeContext.feeAmount.toFixed(2)}`}
                      note={order.intent.feeContext.source}
                    />
                    <CompactField
                      label="模型"
                      value={displaySignalModel(order.signal.modelLabel, order.signal.model, 'zh')}
                    />
                    <CompactField
                      label="来源"
                      value={order.decisionMode === 'candidate_pool' ? '候选池裁决' : '老逻辑直推'}
                      note={order.candidateId ?? formatDecisionMode(order.decisionMode)}
                    />
                    <CompactField
                      label="入队时间"
                      value={formatDateTime(order.createdAt)}
                    />
                  </div>
                </div>
              ))}
              {!pendingOrders.length ? (
                <div className="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-sm text-stone-500">暂无待确认实盘订单。</div>
              ) : null}
            </div>
            <PaginationControls
              page={pendingOrdersPage?.page ?? 1}
              totalPages={pendingOrdersPage?.totalPages ?? 1}
              total={pendingOrdersPage?.total ?? pendingOrders.length}
              onPageChange={(page) => setHistoryPage('pending-orders', page)}
            />
          </section>
        </section>

        <section className="grid gap-6 xl:grid-cols-1">
          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
            <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">FUTU REAL ORDERS</p>
            <h2 className="mt-2 text-2xl font-semibold">实盘订单状态（{futuOrders?.total ?? 0}）</h2>
            <div className="mt-5 space-y-3">
              {(futuOrders?.orders ?? []).map((order) => (
                <div key={order.orderId} className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm">
                  <div className="flex justify-between gap-3">
                    <strong>{order.ticker} · {order.orderStatusLabel}</strong>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span className="text-stone-600">{order.orderId}</span>
                      <Link
                        className="inline-flex items-center gap-1 rounded-xl border border-amber-200 bg-white px-3 py-2 text-xs font-bold text-amber-800 hover:bg-amber-50"
                        to={`/live-trading/orders/${order.orderId}?ticker=${encodeURIComponent(order.ticker)}&submittedAt=${encodeURIComponent(order.createTime)}`}
                      >
                        <Eye size={14} />
                        订单详情
                      </Link>
                    </div>
                  </div>
                  <p className="mt-2 text-stone-600">成交 {order.filledQuantity}/{order.quantity} · {displayOrderPriceWithType(order.price, order.orderType, 'zh')}</p>
                  <p className="mt-1 text-xs text-stone-500">创建：{formatDateTime(order.createTime)} · 更新：{formatDateTime(order.updatedTime)}</p>
                  <p className="mt-1 text-xs text-stone-500">费用：{order.feeContext?.feeAmount === null || order.feeContext?.feeAmount === undefined ? order.feeContext?.warning ?? '等待 REAL 回填' : `$${order.feeContext.feeAmount.toFixed(2)}`}</p>
                </div>
              ))}
              {!futuOrders?.orders?.length ? <p className="text-sm text-stone-500">暂无可展示的 Futu REAL 订单。</p> : null}
            </div>
            <PaginationControls
              page={futuOrders?.page ?? 1}
              totalPages={futuOrders?.totalPages ?? 1}
              total={futuOrders?.total ?? 0}
              onPageChange={setFutuOrdersPage}
            />
          </section>
        </section>
      </div>

      {confirmingOrder ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-white/95 p-4 sm:p-6">
          <div className="mx-auto my-4 max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-3xl border border-orange-300/40 bg-white p-6 shadow-2xl shadow-rose-200/30 sm:my-6 sm:max-h-[calc(100vh-3rem)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">LIVE ORDER CONFIRMATION</p>
                <h2 className="mt-2 text-2xl font-semibold">二次确认真实订单</h2>
              </div>
              <button className="text-stone-500" onClick={() => setConfirmingOrder(undefined)}>关闭</button>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <Metric
                label="标的 / 方向"
                value={(
                  <>
                    {confirmingOrder.intent.ticker} · <span className={pendingOrderSideTone(confirmingOrder)}>{pendingOrderSideLabel(confirmingOrder)}</span>
                  </>
                )}
                note={confirmingOrder.signal.id}
              />
              <Metric label="数量 / 价格" value={`${confirmingOrder.intent.quantity} 股`} note={displayOrderPriceWithType(`$${confirmingOrder.intent.limitPrice.toFixed(2)}`, confirmingOrder.intent.orderType, 'zh')} />
              <Metric label="费用" value={confirmingOrder.intent.feeContext.feeAmount === null ? 'unavailable' : `$${confirmingOrder.intent.feeContext.feeAmount.toFixed(2)}`} note="estimated_pre_trade，成交后 REAL 回填" />
              <Metric label="模型" value={displaySignalModel(confirmingOrder.signal.modelLabel, confirmingOrder.signal.model, 'zh')} note={confirmingOrder.signal.confidence} />
              <Metric label="订单来源" value={confirmingOrder.decisionMode === 'candidate_pool' ? '候选池裁决' : '老逻辑直推'} note={confirmingOrder.candidateId ?? formatDecisionMode(confirmingOrder.decisionMode)} />
            </div>
            <div className="mt-5 space-y-2 text-sm text-stone-600">
              {confirmingOrder.riskWarnings.map((warning) => <Guard key={warning} ok={warning.includes('人工') || warning.includes('费用')}>{warning}</Guard>)}
                {data?.liveTradingEnabled ? null : (
                  <Guard ok={false}>实盘提交门禁未开启：当前确认请求会被后端拒绝，不会提交 Futu REAL 订单。</Guard>
                )}
              <p className="rounded-2xl bg-stone-50 p-4 text-stone-600">{confirmingOrder.signal.reason}</p>
                {error ? (
                  <p className="rounded-2xl border border-orange-300/40 bg-orange-500/15 p-3 text-orange-800">{error}</p>
                ) : null}
            </div>
            <div className="mt-5 flex justify-end gap-3">
                <button
                  className="rounded-2xl bg-white/90 px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={confirmingOrderId === confirmingOrder.id || rejectingOrderId === confirmingOrder.id}
                  onClick={async () => {
                    const result = await rejectOrder(confirmingOrder.id)
                    if (result?.ok) setConfirmingOrder(undefined)
                  }}
                >
                  {rejectingOrderId === confirmingOrder.id ? '拒绝中...' : '拒绝'}
                </button>
                <button
                  className="rounded-2xl bg-gradient-to-r from-orange-500 via-orange-500 to-rose-500 px-4 py-2 text-sm font-bold text-stone-950 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={confirmingOrderId === confirmingOrder.id || rejectingOrderId === confirmingOrder.id}
                  onClick={async () => {
                    const result = await confirmOrder(confirmingOrder.id)
                    if (result?.ok) setConfirmingOrder(undefined)
                  }}
                >
                  {confirmingOrderId === confirmingOrder.id ? '提交中...' : '确认提交真实订单'}
                </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function Metric({ label, value, note, action }: { label: string; value: ReactNode; note: string; action?: ReactNode }) {
  return (
    <div className="rounded-3xl border border-stone-200 bg-white/90 p-5 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">{label}</p>
        {action}
      </div>
      <p className="mt-2 text-2xl font-semibold text-stone-950">{value}</p>
      <p className="mt-1 text-xs text-stone-500">{note}</p>
    </div>
  )
}

function CandidatePoolPanel({
  snapshot,
  executionMode,
  historyPage,
  historyFilter,
  saving,
  onHistoryFilterChange,
  onHistoryPageChange,
  onSave,
}: {
  snapshot?: LiveCandidatePoolSnapshot
  executionMode: TradeExecutionMode
  historyPage?: SimulationHistoryPage<LiveCandidatePoolItem>
  historyFilter: LiveCandidatePoolHistoryFilter
  saving: boolean
  onHistoryFilterChange: (filter: LiveCandidatePoolHistoryFilter) => void
  onHistoryPageChange: (page: number) => void
  onSave: (input: UpdateTradeStrategyConfigRequest) => void
}) {
  const enabled = executionMode === 'candidate_pool'
  const candidates = historyPage?.items ?? (historyFilter === 'ACTIVE' ? snapshot?.candidates ?? [] : [])
  const timingPresets = snapshot?.timingPresets ?? []
  const activePreset = timingPresets.find((preset) => preset.id === snapshot?.presetId)
  const modeLabel = enabled ? '候选池组合裁决' : '老逻辑直推'
  const presetName = activePreset?.label ?? snapshot?.presetLabel ?? 'DeepSeek 平衡版 v1'
  const [expanded, setExpanded] = useState(enabled)
  const [promptOpen, setPromptOpen] = useState(false)

  useEffect(() => {
    setExpanded(enabled)
  }, [enabled])

  return (
    <section className={`rounded-3xl border p-6 backdrop-blur ${enabled ? 'border-rose-300/30 bg-rose-500/10' : 'border-orange-300/20 bg-white/90'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={`text-xs font-semibold tracking-[0.25em] ${enabled ? 'text-orange-700' : 'text-amber-700'}`}>组合策略</p>
          <h2 className="mt-2 text-2xl font-semibold">{enabled ? '新增：候选池与 DeepSeek 组合裁决' : '组合策略已关闭 · 老逻辑直推'}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {enabled
              ? '该模块插在“策略与提示词版本”之后、“历史策略信号”之前。它解释为什么某个买入信号进入订单队列，为什么其他买入信号暂缓。'
              : '后续非观望信号不写入候选池，不调用组合裁决提示词，直接进入后端硬风控；已有候选只读保留。'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={enabled ? 'amber' : 'cyan'}>{enabled ? '组合策略已开启' : '老逻辑直推'}</Badge>
          <Badge tone="cyan">{snapshot?.promptLabel ?? '组合裁决提示词 v1'}</Badge>
          <Badge tone="slate">{presetName}</Badge>
          {!enabled ? (
            <button
              className="flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-white/90 text-stone-600 transition hover:border-orange-200/50 hover:bg-orange-300/10"
              onClick={() => setExpanded((value) => !value)}
              aria-label={expanded ? '折叠组合策略面板' : '展开组合策略面板'}
              title={expanded ? '折叠' : '展开'}
            >
              <ChevronDown className={`transition-transform ${expanded ? 'rotate-180' : ''}`} size={18} />
            </button>
          ) : null}
        </div>
      </div>

      {!expanded ? null : (
        <>
      <div className={`mt-5 rounded-2xl border p-4 text-sm leading-6 ${enabled ? 'border-orange-300/30 bg-orange-500/10 text-orange-900' : 'border-amber-300/30 bg-amber-500/10 text-amber-900'}`}>
        {enabled
          ? '当前处于组合策略开启状态：历史策略信号仍完整记录所有 DeepSeek 单标的判断；非观望信号先进入候选池；候选池经组合裁决和硬风控后，才进入待确认订单队列。'
          : '当前处于老逻辑直推状态：后续非观望信号不写入候选池，不调用组合裁决提示词，直接进入后端硬风控。'}
      </div>

      <div className="mt-5 grid gap-3 xl:grid-cols-4">
        <ConfigTile label="当前链路" value={modeLabel} note={enabled ? '标的扫描 -> 候选池 -> 组合裁决 -> 硬风控 -> 人工确认' : '标的扫描 -> 硬风控 -> 人工确认'} />
        <button
          className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-left transition hover:border-orange-300/40 hover:bg-orange-500/10"
          onClick={() => setPromptOpen((value) => !value)}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">组合裁决提示词</p>
          <p className="mt-2 text-2xl font-semibold text-stone-950">{snapshot?.promptLabel ?? '实盘候选池组合裁决提示词 v1'}</p>
          <p className="mt-1 text-xs text-stone-500">{promptOpen ? '点击收起完整 YAML 配置窗口' : `配置版本 v${snapshot?.promptConfigVersion ?? 1}，点击查看完整 YAML 窗口`}</p>
        </button>
        <ConfigTile label="时间预设" value={presetName} note={`当前用于候选有效期、冷却和组合裁决频率`} />
        <ConfigTile label="裁决输出结构" value={`${snapshot?.decisionRuleCount ?? 0} 条规则`} note={`包含：${formatRequiredJsonKeys(snapshot?.requiredJsonKeys ?? [])}`} />
      </div>

      {promptOpen ? (
        <div className="mt-3 rounded-2xl border border-orange-300/30 bg-white/95 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-stone-950">组合裁决 Prompt YAML</h3>
              <p className="mt-1 text-xs text-stone-500">来源：trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml</p>
            </div>
            <Badge tone="amber">v{snapshot?.promptConfigVersion ?? 1}</Badge>
          </div>
          <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-2xl bg-stone-100 p-4 text-xs leading-5 text-stone-800">
            {snapshot?.promptRawYaml ?? '后端尚未返回组合裁决 Prompt YAML。请检查 dashboard candidatePool.promptRawYaml 字段。'}
          </pre>
        </div>
      ) : null}

      <div className="mt-5 grid gap-3 xl:grid-cols-3">
        {timingPresets.length ? timingPresets.map((preset) => (
          <div
            key={preset.id}
            className={`rounded-2xl border p-4 transition ${preset.id === snapshot?.presetId ? 'border-orange-300/50 bg-orange-500/10 shadow-lg shadow-rose-200/20' : 'border-stone-200 bg-stone-50 hover:border-orange-300/30 hover:bg-orange-500/5'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-stone-500">时间预设 v{preset.version}</p>
                <h3 className="mt-1 text-lg font-semibold text-stone-950">{preset.label}</h3>
              </div>
              {preset.id === snapshot?.presetId ? <Badge tone="amber">当前</Badge> : null}
            </div>
            <p className="mt-2 min-h-10 text-xs leading-5 text-stone-500">{preset.description}</p>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <PresetMetric label="标的扫描" value={`${preset.singleSignalScanIntervalMinutes} 分钟`} />
              <PresetMetric label="组合裁决" value={`${preset.portfolioReviewIntervalMinutes} 分钟`} />
              <PresetMetric label="候选有效期" value={`${preset.candidateTtlMinutes} 分钟`} />
              <PresetMetric label="杠杆冷却" value={`${preset.leveragedEtfCooldownMinutes} 分钟`} />
              <PresetMetric label="最少确认" value={`${preset.minSignalConfirmations} 次`} />
              <PresetMetric label="每轮推进" value={`${preset.maxPromotedOrdersPerReview} 单`} />
            </div>
            <button
              className={`mt-4 w-full rounded-2xl px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60 ${preset.id === snapshot?.presetId ? 'bg-orange-300 text-stone-950' : enabled ? 'bg-white/90 text-orange-800 hover:bg-orange-400 hover:text-stone-950' : 'bg-stone-50 text-stone-500'}`}
              disabled={!enabled || saving || preset.id === snapshot?.presetId}
              onClick={() => onSave({ portfolioTimingPresetId: preset.id })}
            >
              {!enabled ? '组合策略关闭，不可切换' : preset.id === snapshot?.presetId ? '当前使用中' : saving ? '保存中' : '切换到此预设'}
            </button>
          </div>
        )) : (
          <div className="rounded-2xl border border-orange-300/30 bg-orange-500/10 p-4 text-sm text-orange-800 xl:col-span-3">
            组合策略时间预设尚未从后端加载。请检查组合裁决 YAML 配置是否被服务读取。
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-3 xl:grid-cols-2">
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
          <h3 className="text-lg font-semibold text-stone-950">提示词配置摘要</h3>
          <p className="mt-2 text-sm leading-6 text-stone-600">{snapshot?.promptSummary ?? '从跨时间候选池中选择是否推进候选到实盘人工确认订单队列。'}</p>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
          <h3 className="text-lg font-semibold text-stone-950">{enabled ? '开启后当前状态' : '关闭后当前状态'}</h3>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {enabled
              ? (historyPage?.total ?? candidates.length) ? `当前筛选下有 ${historyPage?.total ?? candidates.length} 个候选历史记录。` : '组合策略已经开启，但当前还没有候选。下一轮非观望信号会先写入候选池，再进入组合裁决。'
              : '候选池模块只读；后续信号会回到老逻辑直推，待确认订单来源显示“老逻辑直推”。'}
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-stone-200 bg-stone-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-stone-950">候选池历史（{historyPage?.total ?? candidates.length}）</h3>
            <p className="mt-1 text-xs text-stone-500">按候选最新状态去重分页，便于查看库里的历史；不展示“全部”混合视图。</p>
          </div>
          <FilterChips
            items={CANDIDATE_POOL_HISTORY_FILTERS}
            value={historyFilter}
            onChange={onHistoryFilterChange}
          />
        </div>
      </div>

          <div className="mt-3 overflow-x-auto rounded-2xl border border-stone-200">
            <table className="min-w-[1120px] table-fixed divide-y divide-white/10 text-sm">
          <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
                  <th className="w-[170px] px-4 py-3">候选</th>
                  <th className="w-[190px] px-4 py-3">分组</th>
                <th className="w-[80px] px-4 py-3">确认</th>
                <th className="w-[100px] px-4 py-3">价格偏离</th>
                <th className="w-[120px] px-4 py-3">名义金额</th>
                <th className="w-[140px] px-4 py-3">状态</th>
                  <th className="w-[170px] px-4 py-3">时间</th>
                <th className="px-4 py-3">裁决说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {candidates.map((candidate) => (
              <tr key={candidate.candidateId} className={enabled ? '' : 'opacity-65'}>
                <td className="px-4 py-3 font-bold">
                    {candidate.ticker} · <span className={historySideTone({ side: candidate.action })}>{displaySide(candidate.action, 'zh')}</span>
                  <div className="mt-1 text-xs font-normal text-stone-500">{candidate.candidateId}</div>
                </td>
                <td className="px-4 py-3">
                  {formatGroupKey(candidate.groupKey)}
                  {candidate.riskTags.length ? <div className="mt-1 text-xs text-amber-700">{candidate.riskTags.map(formatRiskTag).join(' / ')}</div> : null}
                </td>
                <td className="px-4 py-3">{candidate.signalCount} 次</td>
                <td className="px-4 py-3">{candidate.priceDriftPct.toFixed(2)}%</td>
                <td className="px-4 py-3">${candidate.proposedNotional.toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex min-w-[72px] justify-center whitespace-nowrap rounded-xl px-3 py-2 text-xs font-bold ${candidateStatusTone(candidate.status)}`}>
                    {formatCandidateStatus(candidate.status)}
                  </span>
                </td>
                  <td className="px-4 py-3">
                    <div className="whitespace-nowrap font-semibold text-stone-700">{formatDateTime(candidate.lastSeenAt)}</div>
                    <div className="mt-1 whitespace-nowrap text-xs text-stone-500">首次 {formatDateTime(candidate.firstSeenAt)}</div>
                  </td>
                <td className="px-4 py-3 text-stone-600">{candidate.portfolioDecisionReason ?? (enabled ? '等待下一次组合裁决。' : '组合策略关闭，只读保留。')}</td>
              </tr>
            ))}
            {!candidates.length ? (
              <tr>
                  <td className="px-4 py-6 text-stone-500" colSpan={8}>
                  {historyFilter === 'ACTIVE'
                    ? enabled ? '组合策略已开启，但暂无生效中候选。请启动或等待下一轮实盘评估；非观望信号会先进入候选池而不是直接进入待确认订单。' : '暂无生效中候选池历史。当前关闭时会沿用老逻辑直推。'
                    : '暂无已失效候选池历史。'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <PaginationControls
        page={historyPage?.page ?? 1}
        totalPages={historyPage?.totalPages ?? 1}
        total={historyPage?.total ?? candidates.length}
        onPageChange={onHistoryPageChange}
      />
        </>
      )}
    </section>
  )
}

function ConfigTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
      <p className="text-xs font-semibold text-stone-500">{label}</p>
      <p className="mt-2 break-words text-lg font-semibold text-stone-950">{value}</p>
      <p className="mt-1 text-xs leading-5 text-stone-500">{note}</p>
    </div>
  )
}

function PresetMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-stone-100/80 px-3 py-2">
      <p className="text-stone-500">{label}</p>
      <p className="mt-1 font-bold text-stone-700">{value}</p>
    </div>
  )
}

function formatRequiredJsonKeys(keys: string[]) {
  if (!keys.length) return '未加载'
  const labels: Record<string, string> = {
    ok: '是否成功',
    promptVersion: '提示词版本',
    promotedCandidates: '推进候选',
    watchedCandidates: '观察候选',
    suppressedCandidates: '暂缓候选',
    expiredCandidates: '过期候选',
    portfolioRationale: '组合说明',
  }
  return keys.map((key) => labels[key] ?? key).join('、')
}

function formatGroupKey(groupKey: string) {
  const labels: Record<string, string> = {
    NVDA_DIRECT: '英伟达正股直接组',
    NVDA_LONG_BETA: '英伟达高波动做多组',
    AMD_LONG_BETA: 'AMD 高波动做多组',
    AMZN_LONG_BETA: '亚马逊高波动做多组',
    TSM_LONG_BETA: '台积电高波动做多组',
    SK_HYNIX_LONG_BETA: '海力士高波动做多组',
    SAMSUNG_ELECTRONICS_LONG_BETA: '三星电子高波动做多组',
    SPACEX_LONG_BETA: 'SpaceX 相关高波动做多组',
    NASDAQ_LONG_BETA: '纳指高波动做多组',
    DIRECT_LONG_BETA: '普通直接做多组',
  }
  return labels[groupKey] ?? groupKey
}

function formatRiskTag(tag: string) {
  const labels: Record<string, string> = {
    LEVERAGED_2X_ETF: '2倍杠杆 ETF',
    HIGH_BETA_TECH: '高波动科技',
    SINGLE_STOCK_LEVERAGED: '单股杠杆产品',
    LOW_LIQUIDITY_SESSION: '低流动性时段',
    OVERNIGHT_SESSION: '夜盘',
    REPEATED_SIGNAL: '重复信号',
    PRICE_DRIFTED_UP: '价格上移',
    PRICE_DRIFTED_DOWN: '价格下移',
  }
  return labels[tag] ?? tag
}

function formatCandidateStatus(status: string) {
  const labels: Record<string, string> = {
      ACTIVE: '生效中',
    PROMOTED: '已推进',
    WATCH: '观察',
    SUPPRESSED: '已暂缓',
    EXPIRED: '已过期',
    DISABLED_BY_MODE_SWITCH: '模式关闭只读',
  }
  return labels[status] ?? status
}

function formatDecisionMode(mode?: string) {
  if (mode === 'candidate_pool') return '候选池组合裁决'
  return '老逻辑直推'
}

function CompactField({ label, value, note, strong = false }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold text-stone-500">{label}</p>
      <p className={`mt-1 truncate ${strong ? 'text-base font-bold text-stone-950' : 'font-semibold text-stone-700'}`}>{value}</p>
      {note ? <p className="mt-0.5 truncate text-[11px] text-stone-500">{note}</p> : null}
    </div>
  )
}

function Guard({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? CheckCircle2 : AlertTriangle
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-stone-200 bg-stone-50 p-3">
      <Icon className={ok ? 'mt-0.5 text-amber-300' : 'mt-0.5 text-amber-300'} size={16} />
      <span>{children}</span>
    </div>
  )
}

function candidateStatusTone(status: string) {
  if (status === 'PROMOTED') return 'bg-amber-500/20 text-amber-800'
  if (status === 'SUPPRESSED' || status === 'WATCH') return 'bg-amber-500/20 text-amber-800'
  if (status === 'DISABLED_BY_MODE_SWITCH' || status === 'EXPIRED') return 'bg-stone-500/20 text-stone-600'
  return 'bg-amber-500/20 text-amber-800'
}

function pendingOrderTickerFilterItems(universe: Array<{ ticker: string; label?: string }>, pendingOrders: LivePendingOrder[]) {
  const byTicker = new Map<string, string>()
  for (const item of universe) {
    const ticker = item.ticker.toUpperCase()
    byTicker.set(ticker, item.label ? `${ticker} · ${item.label}` : ticker)
  }
  for (const order of pendingOrders) {
    const ticker = order.intent.ticker.toUpperCase()
    if (!byTicker.has(ticker)) byTicker.set(ticker, ticker)
  }
  return [
    { value: 'ALL', label: '全部标的' },
    ...[...byTicker.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, label]) => ({ value, label })),
  ]
}

function filterPendingOrders(
  orders: LivePendingOrder[],
  statusFilter: LivePendingOrderStatusFilter,
  tickerFilter: string,
  sideFilter: LivePendingOrderSideFilter,
) {
  const normalizedTicker = tickerFilter.toUpperCase()
  return orders.filter((order) => {
    if (statusFilter !== 'ALL' && order.status !== statusFilter) return false
    if (normalizedTicker !== 'ALL' && order.intent.ticker.toUpperCase() !== normalizedTicker) return false
    if (sideFilter !== 'ALL' && order.intent.side !== sideFilter) return false
    return true
  })
}

function historySignalTickerFilterItems(universe: Array<{ ticker: string; label?: string }>, signals: LiveSignalHistoryItem[]) {
  const byTicker = new Map<string, string>()
  for (const item of universe) {
    const ticker = item.ticker.toUpperCase()
    byTicker.set(ticker, item.label ? `${ticker} · ${item.label}` : ticker)
  }
  for (const signal of signals) {
    const ticker = signal.ticker.toUpperCase()
    if (!byTicker.has(ticker)) byTicker.set(ticker, ticker)
  }
  return [
    { value: 'ALL', label: '全部标的' },
    ...[...byTicker.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, label]) => ({ value, label })),
  ]
}

function HistoryTable({
  title,
  items,
  page,
  totalPages,
  total,
  skippedItems,
  signalTickerFilter,
  signalTickerFilterItems,
  signalLifecycleFilter,
  signalDirectionFilter,
  onTickerFilterChange,
  onLifecycleFilterChange,
  onDirectionFilterChange,
  onPageChange,
}: {
  title: string
  items: LiveSignalHistoryItem[]
  page: number
  totalPages: number
  total: number
  skippedItems: LiveSkippedTicker[]
  signalTickerFilter: string
  signalTickerFilterItems: Array<{ value: string; label: string }>
  signalLifecycleFilter: LiveSignalLifecycleFilter
  signalDirectionFilter: LiveSignalDirectionFilter
  onTickerFilterChange: (value: string) => void
  onLifecycleFilterChange: (value: LiveSignalLifecycleFilter) => void
  onDirectionFilterChange: (value: LiveSignalDirectionFilter) => void
  onPageChange: (page: number) => void
}) {
  return (
    <section className="min-w-0 rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">SIGNALS</p>
      <h2 className="mt-2 text-2xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-stone-500">这里展示已经提交给大模型并写入实盘数据库的策略信号。观望只进入历史库；非观望如果未通过硬风控，会显示拦截原因。</p>
      <div className="mt-5 space-y-3">
        <FilterSelect
          label="标的"
          value={signalTickerFilter}
          items={signalTickerFilterItems}
          onChange={onTickerFilterChange}
        />
        <FilterChips
          label="信号状态"
          items={SIGNAL_LIFECYCLE_FILTERS}
          value={signalLifecycleFilter}
          onChange={onLifecycleFilterChange}
        />
        <FilterChips
          label="交易方向"
          items={SIGNAL_DIRECTION_FILTERS}
          value={signalDirectionFilter}
          onChange={onDirectionFilterChange}
        />
      </div>
      <div className="mt-5 space-y-3">
        {items.map((signal) => {
          const lifecycleReason = signal.lifecycleReason ?? findSignalSkipReason(signal, skippedItems)
          return (
            <div key={signal.id} className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm">
              <div className="flex justify-between gap-3">
                <div className="space-y-2">
                  <strong>
                    {signal.ticker} · <span className={historySideTone(signal)}>{historySideLabel(signal)}</span>
                  </strong>
                  {signal.lifecycleStatus ? (
                    <span className={`block w-fit rounded-xl px-3 py-1 text-xs font-bold ${signalLifecycleTone(signal.lifecycleStatus)}`}>
                      {signalLifecycleLabel(signal.lifecycleStatus)}
                    </span>
                  ) : null}
                </div>
                <span className="text-right text-stone-600">
                  {displaySignalModel(signal.modelLabel, signal.model, 'zh')}
                  <span className="mt-1 block text-xs text-stone-500">{formatDateTime(signal.generatedAt)}</span>
                </span>
              </div>
              {lifecycleReason ? (
                <p className="mt-3 rounded-xl border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-amber-800">
                  {signal.lifecycleStatus === 'SUBMIT_FAILED' ? '提交失败' : '未进入待确认队列'}：{lifecycleReason}
                </p>
              ) : null}
              <p className="mt-2 text-stone-600">{signal.reason}</p>
            </div>
          )
        })}
        {!items.length ? <p className="text-sm text-stone-500">暂无历史策略信号。</p> : null}
      </div>
      <PaginationControls page={page} totalPages={totalPages} total={total} onPageChange={onPageChange} />
    </section>
  )
}

function historySideLabel(signal: { side: string; reason?: string }) {
  if (signal.side === 'BUY' && isShortCoverSignal(signal)) return '平仓买入'
  return displaySide(signal.side, 'zh')
}

function pendingOrderSideLabel(order: LivePendingOrder) {
  return historySideLabel({ side: order.intent.side, reason: order.intent.reason || order.signal.reason })
}

function liveOrderDetailPath(order: LivePendingOrder) {
  const params = new URLSearchParams({ ticker: order.intent.ticker })
  if (order.submittedOrder?.orderId) params.set('brokerOrderId', order.submittedOrder.orderId)
  if (order.submittedOrder?.submittedAt) params.set('submittedAt', order.submittedOrder.submittedAt)
  return `/live-trading/orders/${order.id}?${params.toString()}`
}

function pendingOrderSideTone(order: LivePendingOrder) {
  return historySideTone({ side: order.intent.side, reason: order.intent.reason || order.signal.reason })
}

function historySideTone(signal: { side: string; reason?: string }) {
    if (signal.side === 'SELL_TO_CLOSE' || (signal.side === 'BUY' && isShortCoverSignal(signal))) return 'text-emerald-600'
    if (signal.side === 'SELL_SHORT') return 'text-emerald-600'
    if (signal.side === 'BUY') return 'text-red-600'
  return 'text-stone-600'
}

function isShortCoverSignal(signal: { side: string; reason?: string }) {
  return signal.side === 'BUY' && /回补|平仓|空头|short/i.test(signal.reason ?? '')
}

function findSignalSkipReason(signal: { id: string; ticker: string; side: string; generatedAt?: string }, skippedItems: LiveSkippedTicker[]) {
  if (signal.side === 'HOLD') return ''
  const exact = skippedItems.find((item) => item.signalId === signal.id)
  if (exact) return exact.reason
  const signalTime = signal.generatedAt ? Date.parse(signal.generatedAt) : NaN
  if (!Number.isFinite(signalTime)) return ''
  return (
    skippedItems.find((item) => {
      if (item.ticker.toUpperCase() !== signal.ticker.toUpperCase()) return false
      if (item.side && item.side !== signal.side) return false
      const skippedTime = Date.parse(item.updatedAt)
      return Number.isFinite(skippedTime) && skippedTime >= signalTime && skippedTime - signalTime <= 10_000
    })?.reason ?? ''
  )
}

function livePendingStatusLabel(status: LivePendingOrder['status']) {
  if (status === 'REJECTED_BY_USER') return '已拒绝'
  if (status === 'EXPIRED') return '已过期'
  if (status === 'CONFIRMED_SUBMITTING') return '提交中'
  if (status === 'SUBMITTED') return '已提交'
  if (status === 'SUBMIT_FAILED') return '提交失败'
  if (status === 'BLOCKED_BY_RISK') return '风控关闭'
  return '待确认'
}

function livePendingStatusTone(status: LivePendingOrder['status']) {
  if (status === 'REJECTED_BY_USER') return 'bg-stone-500/20 text-stone-600'
  if (status === 'EXPIRED') return 'bg-stone-500/20 text-stone-600'
  if (status === 'SUBMITTED') return 'bg-amber-500/20 text-amber-700'
  if (status === 'SUBMIT_FAILED' || status === 'BLOCKED_BY_RISK') return 'bg-rose-500/20 text-rose-700'
  if (status === 'CONFIRMED_SUBMITTING') return 'bg-amber-500/20 text-amber-800'
  return 'bg-orange-500 text-stone-950'
}

function signalLifecycleLabel(status: LiveSignalHistoryItem['lifecycleStatus']) {
  if (status === 'HOLD') return '观望'
  if (status === 'CANDIDATE_POOL') return '候选池中'
  if (status === 'PENDING_CONFIRMATION') return '待确认'
  if (status === 'CONFIRMED_SUBMITTING') return '提交中'
  if (status === 'SUBMITTED') return '已提交'
  if (status === 'REJECTED_BY_USER') return '已拒绝'
  if (status === 'EXPIRED') return '已过期'
  if (status === 'SUBMIT_FAILED') return '提交失败'
  if (status === 'BLOCKED_BY_RISK') return '风控关闭'
  if (status === 'SKIPPED') return '未入队/拦截'
  return '未追踪'
}

function signalLifecycleTone(status: LiveSignalHistoryItem['lifecycleStatus']) {
  if (status === 'SUBMITTED') return 'bg-amber-500/20 text-amber-700'
  if (status === 'REJECTED_BY_USER' || status === 'EXPIRED' || status === 'HOLD') return 'bg-stone-500/20 text-stone-600'
  if (status === 'CANDIDATE_POOL') return 'bg-amber-500/20 text-amber-800'
  if (status === 'CONFIRMED_SUBMITTING') return 'bg-amber-500/20 text-amber-800'
  if (status === 'SUBMIT_FAILED' || status === 'BLOCKED_BY_RISK') return 'bg-rose-500/20 text-rose-700'
  if (status === 'SKIPPED') return 'bg-amber-500/20 text-amber-800'
  return 'bg-orange-500 text-stone-950'
}

function FilterChips<T extends string>({
  label,
  items,
  value,
  onChange,
  className = '',
}: {
  label?: string
  items: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {label ? <span className="w-16 shrink-0 text-xs font-semibold text-stone-500">{label}</span> : null}
      {items.map((item) => (
        <button
          key={item.value}
          className={`rounded-xl px-3 py-2 text-xs font-bold transition ${item.value === value ? 'bg-amber-400 text-stone-950 shadow-lg shadow-amber-500/20' : 'bg-white/90 text-stone-600 hover:bg-stone-100'}`}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string
  value: string
  items: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs font-semibold text-stone-500">
      <span className="w-16 shrink-0">{label}</span>
      <select
        className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-bold text-stone-950"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {items.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </select>
    </label>
  )
}

function PaginationControls({ page, totalPages, total, onPageChange }: { page: number; totalPages: number; total: number; onPageChange: (page: number) => void }) {
  const currentPage = Math.max(1, page)
  const currentTotalPages = Math.max(1, totalPages)
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4 text-sm text-stone-600">
      <span>
        第 {currentPage} / {currentTotalPages} 页 · 共 {total} 条
      </span>
      <div className="flex gap-2">
        <button
          className="rounded-xl bg-white/90 px-3 py-2 font-bold text-stone-950 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          上一页
        </button>
        <button
          className="rounded-xl bg-white/90 px-3 py-2 font-bold text-stone-950 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={currentPage >= currentTotalPages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  )
}

function formatDateTime(value?: string) {
  if (!value) return 'unavailable'
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}
