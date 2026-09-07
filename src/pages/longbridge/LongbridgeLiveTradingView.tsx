import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, Eye, RefreshCw, ShieldAlert } from 'lucide-react'
import AssetPrivacyToggle from '@/components/common/AssetPrivacyToggle'
import TradeStrategyConfigPanel from '@/components/trading/TradeStrategyConfigPanel'
import ManagedOrdersPanel from '@/components/ManagedOrdersPanel'
import BrokerOrdersTable from '@/components/BrokerOrdersTable'
import { useLongbridgeLiveTradingConfig } from '@/hooks/useLongbridgeLiveTradingConfig'
import { useLongbridgeLiveTrading } from '@/hooks/useLongbridgeLiveTrading'
import { useLongbridgeWorkbench } from '@/hooks/useLongbridgeWorkbench'
import { useUiStore } from '@/stores/uiStore'
import { maskAssetValue } from '@/utils/displayText'
import type { LiveCandidatePoolHistoryFilter, LiveCandidatePoolItem, LiveCandidatePoolSnapshot, LiveOrderFeeContext, LivePendingOrder, LivePendingOrderSideFilter, LivePendingOrderStatusFilter, LiveSignalDirectionFilter, LiveSignalHistoryItem, LiveSignalLifecycleFilter, SimulationHistoryPage, TradeExecutionMode, UpdateTradeStrategyConfigRequest } from '../../../shared/types'
import type { LongbridgeBrokerOrderSideFilter, LongbridgeBrokerOrderStatusFilter } from '../../../shared/longbridgeTypes'
import { localizeLongbridgeOrderError } from '../../../shared/orderErrorMessages'
import LongbridgeWorkbenchNav from './LongbridgeWorkbenchNav'

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
  { value: 'SKIPPED', label: '风控拦截' },
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

const ALL_TICKER_FILTER = [{ value: 'ALL', label: '全部标的' }]
const BROKER_ORDER_STATUS_FILTERS: Array<{ value: LongbridgeBrokerOrderStatusFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'PENDING', label: '进行中' },
  { value: 'FILLED', label: '全部成交' },
  { value: 'PARTIALLY_FILLED', label: '部分成交' },
  { value: 'CANCELED', label: '已撤单' },
  { value: 'REJECTED', label: '已拒绝' },
  { value: 'EXPIRED', label: '已过期' },
]
const BROKER_ORDER_SIDE_FILTERS: Array<{ value: LongbridgeBrokerOrderSideFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'BUY', label: '买入' },
  { value: 'SELL', label: '卖出' },
]

export default function LongbridgeLiveTradingView() {
  const { dashboard, loading, refresh } = useLongbridgeWorkbench()
  const longbridgeLive = useLongbridgeLiveTrading()
  const { config: liveConfig, saving: savingConfig, error: configError, saveLlmConfig, saveTradeStrategyConfig } = useLongbridgeLiveTradingConfig()
  const assetPrivacyHidden = useUiStore((state) => state.assetPrivacyHidden)
  const [candidateExpanded, setCandidateExpanded] = useState(false)
  const [confirmingOrder, setConfirmingOrder] = useState<LivePendingOrder>()
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedConcurrency, setSelectedConcurrency] = useState(1)
  const [disableUsOvernightLlm, setDisableUsOvernightLlm] = useState(true)
  const authReady = dashboard?.sourceStatus.authStatus === 'authenticated'
  const liveEnabled = Boolean(dashboard?.sourceStatus.tradingAvailable || longbridgeLive.data?.liveTradingEnabled)
  const autoSubmitEnabled = Boolean(longbridgeLive.data?.autoSubmitEnabled)
  const autoCancelEnabled = Boolean(longbridgeLive.data?.autoCancelEnabled)
  const executionMode = liveConfig?.tradeStrategyConfig.selection.executionMode ?? 'legacy_direct'
  const runtimeConfig = liveConfig?.llmRuntimeConfig
  const candidatePoolSnapshot = longbridgeLive.data?.candidatePool ?? liveConfig?.candidatePoolConfig
  const signalCount = longbridgeLive.history.signals?.total ?? longbridgeLive.data?.signals.length ?? (longbridgeLive.lastRun?.signal ? 1 : 0)
  const pendingOrderCount = longbridgeLive.history['pending-orders']?.total ?? longbridgeLive.data?.pendingOrders.length ?? longbridgeLive.lastRun?.pendingOrders.length ?? 0
  const engineRunning = Boolean(longbridgeLive.data?.engine.running)
  const universeTickers = useMemo(
    () => longbridgeLive.data?.engine.universe ?? [],
    [longbridgeLive.data?.engine.universe],
  )
  const pendingOrderItems = longbridgeLive.history['pending-orders']?.items
  const signalTickerFilterItems = useMemo(
    () => tickerFilterItems([...universeTickers, ...(longbridgeLive.history.signals?.items.map((signal) => signal.ticker) ?? [])]),
    [longbridgeLive.history.signals?.items, universeTickers],
  )
  const pendingTickerFilterItems = useMemo(
    () => tickerFilterItems([...universeTickers, ...(pendingOrderItems?.map((order) => order.intent.ticker) ?? [])]),
    [pendingOrderItems, universeTickers],
  )
  const brokerTickerFilterItems = useMemo(
    () => tickerFilterItems([
      ...universeTickers,
      ...(longbridgeLive.brokerOrders?.orders.map((order) => order.symbol) ?? []),
    ]),
    [longbridgeLive.brokerOrders?.orders, universeTickers],
  )
  const accountMetric = useMemo(
    () => Object.fromEntries((dashboard?.accountMetrics ?? []).map((item) => [item.label, item.value])),
    [dashboard?.accountMetrics],
  )
  const actionBusy = loading || longbridgeLive.refreshing || longbridgeLive.running
  const concurrencyOptions = useMemo(() => {
    const max = Math.max(1, runtimeConfig?.maxConcurrency ?? 1)
    return Array.from({ length: max }, (_, index) => index + 1)
  }, [runtimeConfig?.maxConcurrency])

  useEffect(() => {
    if (!runtimeConfig) return
    setSelectedModel(runtimeConfig.model)
    setSelectedConcurrency(runtimeConfig.concurrency)
    setDisableUsOvernightLlm(runtimeConfig.disableUsOvernightLlm)
  }, [runtimeConfig])

  useEffect(() => {
    setCandidateExpanded(executionMode === 'candidate_pool')
  }, [executionMode])

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.22),transparent_28rem),radial-gradient(circle_at_top_right,rgba(99,102,241,0.18),transparent_30rem),linear-gradient(135deg,#f8fafc_0%,#edf7ff_48%,#f5f3ff_100%)] text-slate-950">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <LongbridgeWorkbenchNav className="mb-0" />

        <header className="rounded-3xl border border-sky-200 bg-white/90 p-6 shadow-2xl shadow-sky-200/30 backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-sky-700">长桥实盘</p>
              <h1 className="mt-2 flex items-center gap-3 text-3xl font-semibold">
                <ShieldAlert className="text-sky-500" />
                真实操作盘量化交易
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-600">
                界面结构与 Futu 实盘量化保持一致；大模型直推和候选池组合策略均复刻，但行情、K 线、盘口、持仓、购买力和订单能力只允许来自长桥技能、命令行或 MCP 数据适配器。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="cyan">长桥实盘</Badge>
              <Badge tone={liveEnabled ? 'emerald' : 'amber'}>{liveEnabled ? '提交门禁已开启' : '长桥提交门禁关闭'}</Badge>
              <Badge tone={autoSubmitEnabled ? 'red' : 'cyan'}>{autoSubmitEnabled ? '自动下单已开启' : '人工确认模式'}</Badge>
              <Badge tone={executionMode === 'candidate_pool' ? 'violet' : 'cyan'}>
                {executionMode === 'candidate_pool' ? '组合策略已开启' : '大模型直推'}
              </Badge>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              className="rounded-2xl bg-gradient-to-r from-sky-500 via-cyan-500 to-indigo-500 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-sky-200/30 hover:from-sky-400 hover:via-cyan-400 hover:to-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => longbridgeLive.start()}
              disabled={actionBusy || !authReady || engineRunning}
            >
              {engineRunning ? '实盘评估运行中' : actionBusy ? '请求中...' : '启动实盘评估'}
            </button>
            <button className="rounded-2xl bg-white/90 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => longbridgeLive.stop()} disabled={actionBusy || !engineRunning}>停止</button>
            <button className="rounded-2xl bg-white/90 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => longbridgeLive.runOnce()} disabled={actionBusy || !authReady}>单轮评估</button>
            <button className="inline-flex items-center rounded-2xl bg-white/90 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-stone-100" onClick={() => { refresh(); longbridgeLive.refresh() }} disabled={loading || longbridgeLive.refreshing}>
              <RefreshCw className="mr-2" size={16} />
              {loading || longbridgeLive.refreshing ? '刷新中...' : '刷新当前页'}
            </button>
          </div>
        </header>

        <section className="rounded-3xl border border-rose-200 bg-white/90 p-5 shadow-lg shadow-rose-100/40 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-rose-700">真实订单提交</p>
              <h2 className="mt-2 text-xl font-semibold">长桥自动下单开关</h2>
              <p className="mt-2 text-sm text-stone-600">
                关闭时：直推或组合策略只生成待确认订单，需人工点击确认提交。开启时：非观望决策通过硬风控后，会自动调用长桥真实订单接口提交。
              </p>
            </div>
            <button
              className={`rounded-2xl px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${autoSubmitEnabled ? 'bg-rose-600 hover:bg-rose-500' : 'bg-sky-600 hover:bg-sky-500'}`}
              disabled={longbridgeLive.savingSettings || !liveEnabled}
              onClick={() => longbridgeLive.updateAutoSubmit(!autoSubmitEnabled)}
            >
              {longbridgeLive.savingSettings ? '保存中...' : autoSubmitEnabled ? '关闭自动下单' : '开启自动下单'}
            </button>
          </div>
          <div className="mt-4 grid gap-3 text-sm text-stone-600 md:grid-cols-3">
            <Guard ok={liveEnabled}>长桥实盘提交门禁 {liveEnabled ? '已开启' : '未开启'}</Guard>
            <Guard ok={!autoSubmitEnabled}>当前模式：{autoSubmitEnabled ? '自动提交真实订单' : '人工确认后提交'}</Guard>
            <Guard ok={authReady}>长桥账户授权 {authReady ? '已登录' : '不可用'}</Guard>
          </div>
        </section>

        <ManagedOrdersPanel
          platformLabel="长桥"
          accent="sky"
          detailBasePath="/longbridge/live-trading/orders"
          data={longbridgeLive.managedOrders}
          autoCancelEnabled={autoCancelEnabled}
          saving={longbridgeLive.savingSettings}
          cancelingOrderId={longbridgeLive.cancelingManagedOrderId}
          onToggleAutoCancel={longbridgeLive.updateAutoCancel}
          onCancel={longbridgeLive.cancelManagedOrder}
        />

        {dashboard?.warnings.length ? <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{dashboard.warnings.join('；')}</div> : null}
        {configError ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{configError}</div> : null}
        {longbridgeLive.data?.engine.lastError ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">长桥引擎错误：{longbridgeLive.data.engine.lastError}</div> : null}
        {longbridgeLive.error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{longbridgeLive.error}</div> : null}
        {longbridgeLive.lastRun ? (
          <div className="rounded-2xl border border-sky-200 bg-white/90 px-4 py-3 text-sm text-stone-700">
            最近一次评估：{longbridgeLive.lastRun.symbol} · {longbridgeLive.lastRun.decision?.action ?? '无决策'} · {longbridgeLive.lastRun.decision?.confidence ?? 'unknown'} · {longbridgeLive.lastRun.decision?.reason ?? longbridgeLive.lastRun.warnings[0] ?? '已完成'}
          </div>
        ) : null}

        <section className="grid gap-4 md:grid-cols-5">
          <Metric label="真实账户" value={authReady ? '长桥账户' : '不可用'} note="长桥实盘" />
          <Metric label="美金总览" value={assetPrivacyHidden ? maskAssetValue() : accountMetric['美金总览'] ?? '不可用'} note="账户净资产，美元" action={<AssetPrivacyToggle />} />
          <Metric label="最大购买力" value={assetPrivacyHidden ? maskAssetValue() : accountMetric['最大购买力'] ?? '不可用'} note="开仓风控输入，美元" />
          <Metric label="历史策略信号" value={String(signalCount)} note="长桥独立信号库" />
          <Metric label="待确认订单" value={String(pendingOrderCount)} note="已提交 0" />
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.25em] text-sky-700">大模型配置</p>
                <h2 className="mt-2 text-2xl font-semibold">大模型配置</h2>
                <p className="mt-2 text-sm text-stone-600">沿用同一份 DeepSeek 运行时配置；默认来自 ARK_MODEL / LLM_DECISION_CONCURRENCY，保存后从下一轮评估生效。</p>
              </div>
              <Badge tone="cyan">{runtimeConfig?.modelLabel ?? '未加载'}</Badge>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-[1.2fr_0.7fr_1fr_auto]">
              <label className="text-sm font-semibold text-stone-600">
                模型
                <select className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-950" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                  {(liveConfig?.modelOptions ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-semibold text-stone-600">
                并发
                <select className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-950" value={selectedConcurrency} onChange={(event) => setSelectedConcurrency(Number(event.target.value))}>
                  {concurrencyOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-3 self-end rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-700">
                <input
                  className="h-4 w-4 accent-sky-500"
                  type="checkbox"
                  checked={disableUsOvernightLlm}
                  onChange={(event) => setDisableUsOvernightLlm(event.target.checked)}
                />
                禁用美股夜盘 LLM
              </label>
              <button className="self-end rounded-2xl bg-sky-500 px-4 py-3 text-sm font-bold text-white hover:bg-sky-400 disabled:opacity-60" disabled={savingConfig || !selectedModel} onClick={() => saveLlmConfig({ model: selectedModel, concurrency: selectedConcurrency, disableUsOvernightLlm })}>
                {savingConfig ? '保存中' : '保存配置'}
              </button>
            </div>
            <p className="mt-3 text-xs text-stone-500">并发越高评估越快；开启“禁用美股夜盘 LLM”后，美股夜盘只记录跳过原因，把并发留给港股盘中。</p>
          </section>

          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
            <p className="text-xs font-semibold tracking-[0.25em] text-sky-700">实盘门禁</p>
            <h2 className="mt-2 text-2xl font-semibold">实盘门禁</h2>
            <div className="mt-5 space-y-3 text-sm text-stone-600">
              <Guard ok>非观望建议通过长桥数据适配器和后端硬风控后进入待确认队列</Guard>
              <Guard ok={liveEnabled}>真实提交门禁：长桥实盘开关 + 授权交易权限</Guard>
              <Guard ok={authReady}>行情、K 线、盘口、持仓和购买力来自长桥技能、命令行或 MCP</Guard>
              <Guard ok>SELL_SHORT 允许入队，但必须突出卖空、保证金和回补风险</Guard>
            </div>
          </section>
        </section>

        <TradeStrategyConfigPanel
          title="实盘策略与提示词版本"
          subtitle="沿用 trade_strategy 中同一份实盘策略和提示词 YAML；保存后从下一轮长桥评估生效，不绕过门禁或人工确认。"
          config={liveConfig?.tradeStrategyConfig}
          saving={savingConfig}
          dark
          showPortfolioExecutionMode
          eyebrow="策略配置"
          accent="longbridge"
          onSave={saveTradeStrategyConfig}
        />

        <LongbridgeCandidatePoolConfigPanel
          snapshot={candidatePoolSnapshot}
          executionMode={executionMode}
          historyPage={longbridgeLive.history['candidate-pool']}
          historyFilter={longbridgeLive.candidatePoolHistoryFilter}
          expanded={candidateExpanded}
          saving={savingConfig}
          onHistoryFilterChange={longbridgeLive.setCandidatePoolHistoryFilter}
          onHistoryPageChange={(page) => longbridgeLive.setHistoryPage('candidate-pool', page)}
          onExpandedChange={setCandidateExpanded}
          onSave={saveTradeStrategyConfig}
        />

        <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <LongbridgeSignalHistoryTable
            page={longbridgeLive.history.signals}
            tickerFilter={longbridgeLive.signalTickerFilter}
            tickerFilterItems={signalTickerFilterItems}
            directionFilter={longbridgeLive.signalDirectionFilter}
            lifecycleFilter={longbridgeLive.signalLifecycleFilter}
            onTickerFilterChange={longbridgeLive.setSignalTickerFilter}
            onDirectionFilterChange={longbridgeLive.setSignalDirectionFilter}
            onLifecycleFilterChange={longbridgeLive.setSignalLifecycleFilter}
            onPageChange={(page) => longbridgeLive.setHistoryPage('signals', page)}
          />

          <div className="min-w-0 space-y-6">
            <LongbridgePendingOrdersPanel
              page={longbridgeLive.history['pending-orders']}
              statusFilter={longbridgeLive.pendingOrderStatusFilter}
              tickerFilter={longbridgeLive.pendingOrderTickerFilter}
              tickerFilterItems={pendingTickerFilterItems}
              sideFilter={longbridgeLive.pendingOrderSideFilter}
              confirmingOrderId={longbridgeLive.confirmingOrderId}
              rejectingOrderId={longbridgeLive.rejectingOrderId}
              expiringPendingOrders={longbridgeLive.expiringPendingOrders}
              onStatusFilterChange={longbridgeLive.setPendingOrderStatusFilter}
              onTickerFilterChange={longbridgeLive.setPendingOrderTickerFilter}
              onSideFilterChange={longbridgeLive.setPendingOrderSideFilter}
              onPageChange={(page) => longbridgeLive.setHistoryPage('pending-orders', page)}
              onOpenConfirm={setConfirmingOrder}
              onBatchExpire={longbridgeLive.batchExpirePendingOrders}
            />

            <BrokerOrdersTable
              platform="长桥"
              compact
              filters={{
                ticker: longbridgeLive.brokerOrderTickerFilter,
                status: longbridgeLive.brokerOrderStatusFilter,
                side: longbridgeLive.brokerOrderSideFilter,
                tickerItems: brokerTickerFilterItems,
                statusItems: BROKER_ORDER_STATUS_FILTERS,
                sideItems: BROKER_ORDER_SIDE_FILTERS,
                onChange: (patch) => void longbridgeLive.setBrokerOrderFilters({
                  ...(patch.ticker !== undefined ? { ticker: patch.ticker } : {}),
                  ...(patch.status !== undefined ? { status: patch.status as LongbridgeBrokerOrderStatusFilter } : {}),
                  ...(patch.side !== undefined ? { side: patch.side as LongbridgeBrokerOrderSideFilter } : {}),
                }),
              }}
              rows={(longbridgeLive.brokerOrders?.orders ?? []).map((order) => ({
                orderId: order.orderId,
                ticker: order.symbol,
                name: order.stockName,
                status: order.statusLabel,
                side: order.sideLabel,
                orderType: order.orderTypeLabel,
                quantity: order.quantity,
                filledQuantity: order.executedQuantity,
                price: formatOrderMoney(order.price, order.currency),
                filledPrice: formatOrderMoney(order.executedPrice, order.currency),
                session: order.outsideRthLabel,
                updatedAt: order.updatedAt ?? order.submittedAt,
                detailHref: `/longbridge/live-trading/orders/${order.orderId}?submittedAt=${encodeURIComponent(order.submittedAt)}`,
              }))}
              page={longbridgeLive.brokerOrders?.page ?? 1}
              totalPages={longbridgeLive.brokerOrders?.totalPages ?? 1}
              total={longbridgeLive.brokerOrders?.total ?? 0}
              loading={longbridgeLive.refreshing}
              onRefresh={() => void longbridgeLive.loadBrokerOrders(longbridgeLive.brokerOrdersPage)}
              onPageChange={longbridgeLive.setBrokerOrdersPage}
            />
          </div>
        </section>

          {confirmingOrder ? (
            <LongbridgeOrderConfirmDialog
              order={confirmingOrder}
              liveEnabled={liveEnabled}
              confirmingOrderId={longbridgeLive.confirmingOrderId}
              rejectingOrderId={longbridgeLive.rejectingOrderId}
              error={longbridgeLive.error}
              onClose={() => setConfirmingOrder(undefined)}
              onConfirm={async (id) => {
                const result = await longbridgeLive.confirmOrder(id)
                if (result?.ok) setConfirmingOrder(undefined)
              }}
              onReject={async (id) => {
                const result = await longbridgeLive.rejectOrder(id)
                if (result?.ok) setConfirmingOrder(undefined)
              }}
            />
          ) : null}
      </div>
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

function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'cyan' | 'emerald' | 'amber' | 'red' | 'slate' | 'violet' }) {
  const toneClasses = {
    cyan: 'border-sky-200 bg-sky-50 text-sky-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-sky-200 bg-sky-50 text-sky-700',
    red: 'border-rose-200 bg-rose-50 text-rose-700',
    slate: 'border-slate-200 bg-slate-100 text-slate-700',
    violet: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${toneClasses[tone]}`}>
      {children}
    </span>
  )
}

function Guard({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-2xl border border-stone-200 bg-stone-50 p-3">
      {ok ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-500" size={16} /> : <AlertTriangle className="mt-0.5 shrink-0 text-sky-600" size={16} />}
      <span>{children}</span>
    </div>
  )
}

function LongbridgeOrderConfirmDialog({
  order,
  liveEnabled,
  confirmingOrderId,
  rejectingOrderId,
  error,
  onClose,
  onConfirm,
  onReject,
}: {
  order: LivePendingOrder
  liveEnabled: boolean
  confirmingOrderId?: string
  rejectingOrderId?: string
  error?: string
  onClose: () => void
  onConfirm: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
}) {
  const submitting = confirmingOrderId === order.id
  const rejecting = rejectingOrderId === order.id
  const submittedError = order.submittedOrder?.error
    ? localizeLongbridgeOrderError(order.submittedOrder.error)
    : undefined
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-white/95 p-4 sm:p-6">
      <div className="mx-auto my-4 max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-3xl border border-sky-200 bg-white p-6 shadow-2xl shadow-sky-200/40 sm:my-6 sm:max-h-[calc(100vh-3rem)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.25em] text-sky-700">长桥订单确认</p>
            <h2 className="mt-2 text-2xl font-semibold">二次确认长桥真实订单</h2>
          </div>
          <button className="text-stone-500" onClick={onClose}>关闭</button>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Metric
            label="标的 / 方向"
            value={<>{order.intent.ticker} · <span className={sideTone(order.intent.side)}>{sideLabel(order.intent.side)}</span></>}
            note={order.signal.id}
          />
          <Metric label="数量 / 价格" value={`${order.intent.quantity} 股`} note={order.intent.orderType === 'MARKET' ? 'MARKET' : `$${order.intent.limitPrice.toFixed(2)}`} />
          <Metric label="费用" value={formatFee(order.intent.feeContext)} note={`${order.intent.feeContext?.source ?? '不可用'}，成交后以长桥回填为准`} />
          <Metric label="模型" value={order.signal.modelLabel ?? order.signal.model ?? 'Longbridge LLM'} note={order.signal.confidence} />
          <Metric label="订单来源" value={order.decisionMode === 'candidate_pool' ? '候选池裁决' : '大模型直推'} note={order.candidateId ?? formatDecisionMode(order.decisionMode)} />
          <Metric label="名义金额" value={order.intent.estimatedNotional ?? `$${(order.intent.quantity * order.intent.limitPrice).toFixed(2)}`} note={order.intent.orderSession} />
        </div>
        <div className="mt-5 space-y-2 text-sm text-stone-600">
          {order.riskWarnings.map((warning) => <Guard key={warning} ok={warning.includes('人工') || warning.includes('费用') || warning.includes('dry-run')}>{warning}</Guard>)}
          {liveEnabled ? null : (
            <Guard ok={false}>长桥实盘提交门禁未开启：当前确认请求会被后端拒绝，不会提交真实订单。</Guard>
          )}
          <p className="rounded-2xl border border-sky-200 bg-sky-50 p-4 leading-6 text-sky-900">
            策略理由：{order.intent.reason || order.signal.reason}
          </p>
          {submittedError ? (
            <p className="whitespace-pre-wrap rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800">{submittedError}</p>
          ) : null}
          {error ? (
            <p className="whitespace-pre-wrap rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800">{error}</p>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button
            className="rounded-2xl bg-white px-4 py-2 text-sm font-bold text-stone-950 ring-1 ring-stone-200 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting || rejecting}
            onClick={() => onReject(order.id)}
          >
            {rejecting ? '拒绝中...' : '拒绝'}
          </button>
          <button
            className="rounded-2xl bg-gradient-to-r from-sky-500 via-cyan-500 to-indigo-500 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting || rejecting}
            onClick={() => onConfirm(order.id)}
          >
            {submitting ? '提交中...' : '提交真实订单'}
          </button>
        </div>
      </div>
    </div>
  )
}

function LongbridgeCandidatePoolConfigPanel({
  snapshot,
  executionMode,
  historyPage,
  historyFilter,
  expanded,
  saving,
  onHistoryFilterChange,
  onHistoryPageChange,
  onExpandedChange,
  onSave,
}: {
  snapshot?: LiveCandidatePoolSnapshot
  executionMode: TradeExecutionMode
  historyPage?: SimulationHistoryPage<LiveCandidatePoolItem>
  historyFilter: LiveCandidatePoolHistoryFilter
  expanded: boolean
  saving: boolean
  onHistoryFilterChange: (filter: LiveCandidatePoolHistoryFilter) => void
  onHistoryPageChange: (page: number) => void
  onExpandedChange: (expanded: boolean) => void
  onSave: (input: UpdateTradeStrategyConfigRequest) => void
}) {
  const enabled = executionMode === 'candidate_pool'
  const timingPresets = snapshot?.timingPresets ?? []
  const activePreset = timingPresets.find((preset) => preset.id === snapshot?.presetId)
  const presetName = activePreset?.label ?? snapshot?.presetLabel ?? '未加载'
  const [promptOpen, setPromptOpen] = useState(false)

  return (
    <section className={`rounded-3xl border p-6 backdrop-blur ${enabled ? 'border-indigo-200 bg-indigo-50/70' : 'border-sky-200 bg-white/90'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={`text-xs font-semibold tracking-[0.25em] ${enabled ? 'text-indigo-700' : 'text-sky-700'}`}>组合策略</p>
          <h2 className="mt-2 text-2xl font-semibold">{enabled ? '候选池与 DeepSeek 组合裁决' : '组合策略已关闭 · 大模型直推'}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {enabled
              ? '复刻 Futu 候选池组合裁决：非观望信号先进入候选池，再由组合裁决决定是否推进到待确认队列。'
              : '大模型直推模式：非观望信号不写入候选池，直接进入后端硬风控和人工确认链路。'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={enabled ? 'violet' : 'cyan'}>{enabled ? '组合策略已开启' : '大模型直推'}</Badge>
          <Badge tone="cyan">{snapshot?.promptLabel ?? '组合裁决提示词 v1'}</Badge>
          <Badge tone="slate">{presetName}</Badge>
          {!enabled ? (
            <button className="flex h-9 w-9 items-center justify-center rounded-full border border-sky-200 bg-white/90 text-sky-700 transition hover:border-sky-300 hover:bg-sky-50" onClick={() => onExpandedChange(!expanded)} aria-label={expanded ? '折叠组合策略面板' : '展开组合策略面板'}>
              <ChevronDown className={`transition-transform ${expanded ? 'rotate-180' : ''}`} size={18} />
            </button>
          ) : null}
        </div>
      </div>

      {!enabled && !expanded ? null : (
        <>
          <div className={`mt-5 rounded-2xl border p-4 text-sm leading-6 ${enabled ? 'border-indigo-200 bg-indigo-50 text-indigo-900' : 'border-sky-200 bg-sky-50 text-sky-900'}`}>
            {enabled
              ? '当前处于组合策略开启状态：历史策略信号仍完整记录所有单标的判断；非观望信号先进入候选池；候选池经组合裁决和硬风控后，才进入待确认订单队列。'
              : '当前处于大模型直推状态：后续非观望信号不写入候选池，不调用组合裁决提示词，直接进入后端硬风控。'}
          </div>

          <div className="mt-5 grid gap-3 xl:grid-cols-4">
            <ConfigTile label="当前链路" value={enabled ? '候选池组合裁决' : '大模型直推'} note={enabled ? '标的扫描 -> 候选池 -> 组合裁决 -> 硬风控 -> 人工确认' : '标的扫描 -> 硬风控 -> 人工确认'} />
            <button className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4 text-left transition hover:border-sky-300 hover:bg-sky-100" onClick={() => setPromptOpen((value) => !value)}>
              <p className="text-xs font-semibold text-stone-500">组合裁决提示词</p>
              <p className="mt-2 text-2xl font-semibold text-stone-950">{snapshot?.promptLabel ?? '实盘候选池组合裁决提示词 v1'}</p>
              <p className="mt-1 text-xs text-stone-500">{promptOpen ? '点击收起完整 YAML 配置窗口' : `配置版本 v${snapshot?.promptConfigVersion ?? 1}，点击查看完整 YAML 窗口`}</p>
            </button>
            <ConfigTile label="时间预设" value={presetName} note="当前用于候选有效期、冷却和组合裁决频率" />
            <ConfigTile label="裁决输出结构" value={`${snapshot?.decisionRuleCount ?? 0} 条规则`} note={`包含：${formatRequiredJsonKeys(snapshot?.requiredJsonKeys ?? [])}`} />
          </div>

          {promptOpen ? (
            <div className="mt-3 rounded-2xl border border-sky-200 bg-white/95 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-stone-950">组合裁决 Prompt YAML</h3>
                  <p className="mt-1 text-xs text-stone-500">来源：trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml</p>
                </div>
                <Badge tone="cyan">v{snapshot?.promptConfigVersion ?? 1}</Badge>
              </div>
              <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-2xl bg-stone-100 p-4 text-xs leading-5 text-stone-800">
                {snapshot?.promptRawYaml ?? '后端尚未返回组合裁决 Prompt YAML。请检查 trade_strategy 配置读取。'}
              </pre>
            </div>
          ) : null}

          <div className="mt-5 grid gap-3 xl:grid-cols-3">
            {timingPresets.length ? timingPresets.map((preset) => (
              <div
                key={preset.id}
                className={`rounded-2xl border p-4 transition ${preset.id === snapshot?.presetId ? 'border-sky-300 bg-sky-50 shadow-lg shadow-sky-200/20' : 'border-stone-200 bg-stone-50 hover:border-sky-300 hover:bg-sky-50/70'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-stone-500">时间预设 v{preset.version}</p>
                    <h3 className="mt-1 text-lg font-semibold text-stone-950">{preset.label}</h3>
                  </div>
                  {preset.id === snapshot?.presetId ? <Badge tone="cyan">当前</Badge> : null}
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
                  className={`mt-4 w-full rounded-2xl px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60 ${preset.id === snapshot?.presetId ? 'bg-sky-200 text-sky-900' : enabled ? 'bg-white/90 text-sky-800 hover:bg-sky-500 hover:text-white' : 'bg-stone-50 text-stone-500'}`}
                  disabled={!enabled || saving || preset.id === snapshot?.presetId}
                  onClick={() => onSave({ portfolioTimingPresetId: preset.id })}
                >
                  {!enabled ? '组合策略关闭，不可切换' : preset.id === snapshot?.presetId ? '当前使用中' : saving ? '保存中' : '切换到此预设'}
                </button>
              </div>
            )) : (
              <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800 xl:col-span-3">
                组合策略时间预设尚未从后端加载。请检查组合裁决 YAML 配置是否被服务读取。
              </div>
            )}
          </div>

            <LongbridgeCandidateHistoryTable
              page={historyPage}
              filter={historyFilter}
              onFilterChange={onHistoryFilterChange}
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

function LongbridgeSignalHistoryTable({
  page,
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
  tickerFilter: string
  tickerFilterItems: Array<{ value: string; label: string }>
  directionFilter: LiveSignalDirectionFilter
  lifecycleFilter: LiveSignalLifecycleFilter
  onTickerFilterChange: (ticker: string) => void
  onDirectionFilterChange: (direction: LiveSignalDirectionFilter) => void
  onLifecycleFilterChange: (status: LiveSignalLifecycleFilter) => void
  onPageChange: (page: number) => void
}) {
  const items = page?.items ?? []
  return (
    <section className="min-w-0 rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
      <p className="text-xs font-semibold tracking-[0.25em] text-sky-700">策略信号</p>
      <h2 className="mt-2 text-2xl font-semibold">历史策略信号（{page?.total ?? 0}）</h2>
      <p className="mt-2 text-sm text-stone-500">这里展示已经提交给长桥大模型并写入实盘数据库的策略信号。观望只进入历史库；非观望如果未进入待确认队列，会显示原因。</p>
      <div className="mt-5 space-y-3">
        <LongbridgeFilterSelect label="标的" value={tickerFilter} items={tickerFilterItems} onChange={onTickerFilterChange} />
        <LongbridgeFilterChips label="信号状态" items={SIGNAL_LIFECYCLE_FILTERS} value={lifecycleFilter} onChange={onLifecycleFilterChange} />
        <LongbridgeFilterChips label="交易方向" items={SIGNAL_DIRECTION_FILTERS} value={directionFilter} onChange={onDirectionFilterChange} />
      </div>
      <div className="mt-5 space-y-3">
        {items.map((signal) => {
          const lifecycleReason = signal.lifecycleReason
          return (
            <div key={signal.historyId ?? signal.id} className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm">
              <div className="flex justify-between gap-3">
                <div className="space-y-2">
                  <strong>
                    {signal.ticker} · <span className={sideTone(signal.side)}>{sideLabel(signal.side)}</span>
                  </strong>
                  <span className={`block w-fit rounded-xl px-3 py-1 text-xs font-bold ${signalStatusTone(signal.lifecycleStatus ?? (signal.side === 'HOLD' ? 'HOLD' : 'CANDIDATE_POOL'))}`}>
                    {signalStatusLabel(signal.lifecycleStatus ?? (signal.side === 'HOLD' ? 'HOLD' : 'CANDIDATE_POOL'))}
                  </span>
                </div>
                <span className="text-right text-stone-600">
                  {signal.modelLabel ?? signal.model ?? 'Longbridge LLM'}
                  <span className="mt-1 block text-xs text-stone-500">{formatDateTime(signal.generatedAt)}</span>
                </span>
              </div>
              {lifecycleReason && signal.lifecycleStatus !== 'HOLD' ? (
                <p className="mt-3 rounded-xl border border-sky-300/40 bg-sky-500/10 px-3 py-2 text-sky-800">
                  {signal.lifecycleStatus === 'SUBMIT_FAILED' ? '提交失败' : '未进入待确认队列'}：{lifecycleReason}
                </p>
              ) : null}
              <p className="mt-2 leading-6 text-stone-600">{signal.reason}</p>
            </div>
          )
        })}
        {!items.length ? <p className="text-sm text-stone-500">暂无长桥历史策略信号。不会读取 Futu 信号库。</p> : null}
      </div>
      <PaginationControls page={page?.page ?? 1} totalPages={page?.totalPages ?? 1} total={page?.total ?? 0} onPageChange={onPageChange} />
    </section>
  )
}

function LongbridgePendingOrdersPanel({
  page,
  statusFilter,
  tickerFilter,
  tickerFilterItems,
  sideFilter,
  confirmingOrderId,
  rejectingOrderId,
  expiringPendingOrders,
  onStatusFilterChange,
  onTickerFilterChange,
  onSideFilterChange,
  onPageChange,
  onOpenConfirm,
  onBatchExpire,
}: {
  page?: SimulationHistoryPage<LivePendingOrder>
  statusFilter: LivePendingOrderStatusFilter
  tickerFilter: string
  tickerFilterItems: Array<{ value: string; label: string }>
  sideFilter: LivePendingOrderSideFilter
  confirmingOrderId?: string
  rejectingOrderId?: string
  expiringPendingOrders?: boolean
  onStatusFilterChange: (status: LivePendingOrderStatusFilter) => void
  onTickerFilterChange: (ticker: string) => void
  onSideFilterChange: (side: LivePendingOrderSideFilter) => void
  onPageChange: (page: number) => void
  onOpenConfirm: (order: LivePendingOrder) => void
  onBatchExpire: (input: { ticker?: string; side?: LivePendingOrderSideFilter; ids?: string[] }) => Promise<unknown>
}) {
  const orders = page?.items ?? []
  const visibleExpirableOrders = orders.filter((order) => order.status === 'PENDING_CONFIRMATION')
  const canBatchExpire = visibleExpirableOrders.length > 0 && (statusFilter === 'ALL' || statusFilter === 'PENDING_CONFIRMATION')
  return (
    <section className="rounded-3xl border border-sky-200 bg-white/90 p-6 backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-sky-700">待确认订单</p>
          <h2 className="mt-2 text-2xl font-semibold">待确认订单队列（{page?.total ?? 0}）</h2>
          <p className="mt-2 text-sm text-stone-600">长桥订单独立存储；提交后可进入组合详情页查看系统决策、券商状态、成交、费用和监管过程。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge tone="cyan">人工确认</Badge>
          <button
            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={Boolean(expiringPendingOrders) || !canBatchExpire}
            onClick={async () => {
              const confirmed = window.confirm(`确认将当前页筛选结果中的 ${visibleExpirableOrders.length} 笔长桥待确认订单批量过期？过期后不会提交真实订单。`)
              if (!confirmed) return
              await onBatchExpire({
                ticker: tickerFilter === 'ALL' ? undefined : tickerFilter,
                side: sideFilter === 'ALL' ? undefined : sideFilter,
                ids: visibleExpirableOrders.map((order) => order.id),
              })
            }}
          >
            {expiringPendingOrders ? '过期处理中...' : '批量过期本页'}
          </button>
        </div>
      </div>
      <div className="mt-5 space-y-3">
        <LongbridgeFilterSelect label="标的" value={tickerFilter} items={tickerFilterItems} onChange={onTickerFilterChange} />
        <LongbridgeFilterChips label="订单状态" items={PENDING_STATUS_FILTERS} value={statusFilter} onChange={onStatusFilterChange} />
        <LongbridgeFilterChips label="方向" items={PENDING_SIDE_FILTERS} value={sideFilter} onChange={onSideFilterChange} />
      </div>
      <div className="mt-5 space-y-3">
        {orders.map((order) => (
          <div key={order.id} className={`rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm ${order.intent.side === 'SELL_SHORT' ? 'bg-rose-50' : ''}`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-stone-500">标的 / 方向</p>
                    <p className="mt-1 truncate text-base font-bold text-stone-950">
                      {order.intent.ticker} · <span className={sideTone(order.intent.side)}>{sideLabel(order.intent.side)}</span>
                    </p>
                    <p className="mt-1 truncate text-xs text-stone-500">{order.id}</p>
                  </div>
                <CompactField label="数量 / 价格" value={`${order.intent.quantity} 股 · ${order.intent.orderType === 'MARKET' ? 'MARKET' : `$${order.intent.limitPrice.toFixed(2)}`}`} note={order.intent.orderSession} />
              </div>
              <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                <span className={`rounded-xl px-3 py-2 text-xs font-bold ${pendingStatusTone(order.status)}`}>{pendingStatusLabel(order.status)}</span>
                {order.status === 'PENDING_CONFIRMATION' ? (
                  <button className="rounded-xl bg-sky-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-60" disabled={confirmingOrderId === order.id || rejectingOrderId === order.id} onClick={() => onOpenConfirm(order)}>
                    {confirmingOrderId === order.id || rejectingOrderId === order.id ? '处理中...' : '确认弹窗'}
                  </button>
                ) : null}
                {order.submittedOrder ? (
                  <Link
                    className="inline-flex items-center gap-1.5 rounded-xl border border-sky-200 bg-white px-3 py-2 text-xs font-bold text-sky-700 hover:bg-sky-50"
                    to={`/longbridge/live-trading/orders/${encodeURIComponent(order.submittedOrder.orderId)}?pendingOrderId=${encodeURIComponent(order.id)}&submittedAt=${encodeURIComponent(order.submittedOrder.submittedAt)}`}
                  >
                    <Eye size={14} />
                    组合详情
                  </Link>
                ) : null}
              </div>
            </div>
            <div className="mt-3 grid gap-3 border-t border-stone-200 pt-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <CompactField label="费用" value={formatFee(order.intent.feeContext)} note={order.intent.feeContext?.source} />
              <CompactField label="模型" value={order.signal.modelLabel ?? order.signal.model ?? 'Longbridge LLM'} />
              <CompactField label="来源" value={order.decisionMode === 'candidate_pool' ? '候选池裁决' : '大模型直推'} note={order.candidateId ?? order.portfolioDecisionId ?? 'Longbridge'} />
              <CompactField label="入队时间" value={formatDateTime(order.createdAt)} />
            </div>
            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
              <CompactField label="名义金额" value={order.intent.estimatedNotional ?? `$${(order.intent.quantity * order.intent.limitPrice).toFixed(2)}`} />
              <CompactField
                label="风险提示"
                value={
                  order.status === 'SUBMIT_FAILED'
                    ? localizeLongbridgeOrderError(order.riskWarnings[0] ?? order.submittedOrder?.error)
                    : order.riskWarnings[0] ?? order.signal.riskAssessment
                }
              />
            </div>
          </div>
        ))}
        {!orders.length ? <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5 text-sm text-sky-800">暂无长桥待确认订单。大模型直推或组合策略推进后，订单会在本页展开确认，不跳转下级页面。</div> : null}
      </div>
      <PaginationControls page={page?.page ?? 1} totalPages={page?.totalPages ?? 1} total={page?.total ?? 0} onPageChange={onPageChange} />
    </section>
  )
}

function LongbridgeCandidateHistoryTable({
  page,
  filter,
  onFilterChange,
  onPageChange,
}: {
  page?: SimulationHistoryPage<LiveCandidatePoolItem>
  filter: LiveCandidatePoolHistoryFilter
  onFilterChange: (filter: LiveCandidatePoolHistoryFilter) => void
  onPageChange: (page: number) => void
}) {
  const items = page?.items ?? []
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-stone-950">候选池历史（{page?.total ?? 0}）</h3>
        <div className="flex gap-2 text-sm">
          {CANDIDATE_POOL_HISTORY_FILTERS.map((item) => (
            <button key={item.value} className={`rounded-full border px-3 py-1 font-semibold ${filter === item.value ? 'border-indigo-300 bg-indigo-100 text-indigo-800' : 'border-stone-200 bg-white text-stone-600'}`} onClick={() => onFilterChange(item.value)}>{item.label}</button>
          ))}
        </div>
      </div>
      <div className="mt-3 overflow-x-auto rounded-2xl border border-stone-200">
        <table className="min-w-[920px] w-full table-fixed text-sm">
          <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              {['候选', '分组', '确认', '价格偏离', '名义金额', '状态', '时间', '裁决说明'].map((column) => <th key={column} className="px-4 py-3">{column}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {items.map((candidate) => (
              <tr key={candidate.candidateId}>
                <td className="px-4 py-3 font-semibold text-stone-950">{candidate.ticker} · <span className={sideTone(candidate.action)}>{sideLabel(candidate.action)}</span></td>
                <td className="px-4 py-3 text-stone-600">{candidate.groupKey}</td>
                <td className="px-4 py-3 text-stone-600">{candidate.signalCount}</td>
                <td className="px-4 py-3 text-stone-600">{candidate.priceDriftPct.toFixed(2)}%</td>
                <td className="px-4 py-3 text-stone-600">${candidate.proposedNotional.toFixed(2)}</td>
                <td className="px-4 py-3 text-stone-600">{candidateStatusLabel(candidate.status)}</td>
                <td className="px-4 py-3 text-stone-600">{formatDateTime(candidate.lastSeenAt)}</td>
                <td className="px-4 py-3 text-stone-600">{candidate.portfolioDecisionReason ?? candidate.confidence}</td>
              </tr>
            ))}
            {!items.length ? <tr><td className="px-4 py-6 text-stone-500" colSpan={8}>暂无长桥候选。开启组合策略并完成评估后，非观望信号会先进入候选池。</td></tr> : null}
          </tbody>
        </table>
      </div>
      <PaginationControls page={page?.page ?? 1} totalPages={page?.totalPages ?? 1} total={page?.total ?? 0} onPageChange={onPageChange} />
    </div>
  )
}

function LongbridgeFilterChips<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label?: string
  items: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label ? <span className="w-16 shrink-0 text-xs font-semibold text-stone-500">{label}</span> : null}
      {items.map((item) => (
        <button
          key={item.value}
          className={`rounded-xl px-3 py-2 text-xs font-bold transition ${item.value === value ? 'bg-sky-400 text-stone-950 shadow-lg shadow-sky-500/20' : 'bg-white/90 text-stone-600 hover:bg-stone-100'}`}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function LongbridgeFilterSelect({
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
  const [open, setOpen] = useState(false)
  const selected = items.find((item) => item.value === value) ?? items[0]
  return (
    <div className="relative flex flex-wrap items-center gap-2 text-xs font-semibold text-stone-500">
      <span className="w-16 shrink-0">{label}</span>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center justify-between rounded-xl border border-stone-200 bg-white px-3 py-2 text-left text-xs font-bold text-stone-950"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{selected?.label ?? '全部标的'}</span>
        <ChevronDown size={14} className={`ml-2 shrink-0 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="absolute left-16 right-0 top-10 z-30 max-h-72 overflow-y-auto rounded-2xl border border-stone-200 bg-white p-2 shadow-2xl shadow-sky-950/15">
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-bold ${item.value === value ? 'bg-sky-50 text-sky-800' : 'text-stone-700 hover:bg-stone-50'}`}
              onClick={() => {
                onChange(item.value)
                setOpen(false)
              }}
            >
              <span className="w-4">{item.value === value ? '✓' : ''}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CompactField({ label, value, note, valueClassName }: { label: string; value: ReactNode; note?: ReactNode; valueClassName?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold text-stone-500">{label}</p>
      <p className={`mt-1 truncate font-semibold text-stone-950 ${valueClassName ?? ''}`}>{value}</p>
      {note ? <p className="mt-1 truncate text-xs text-stone-500">{note}</p> : null}
    </div>
  )
}

function PaginationControls({ page, totalPages, total, onPageChange }: { page: number; totalPages: number; total: number; onPageChange: (page: number) => void }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600">
      <span>共 {total} 条，第 {page}/{totalPages} 页</span>
      <div className="flex gap-2">
        <button className="rounded-xl border border-stone-200 bg-white px-3 py-1 font-semibold disabled:opacity-50" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
        <button className="rounded-xl border border-stone-200 bg-white px-3 py-1 font-semibold disabled:opacity-50" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
      </div>
    </div>
  )
}

function sideLabel(side: string) {
  const labels: Record<string, string> = {
    HOLD: '观望',
    BUY: '买入',
    SELL_SHORT: '卖空',
    SELL_TO_CLOSE: '平仓卖出',
  }
  return labels[side] ?? side
}

function sideTone(side: string) {
  if (side === 'SELL_TO_CLOSE') return 'text-emerald-600'
  if (side === 'SELL_SHORT') return 'text-emerald-600'
  if (side === 'BUY') return 'text-red-600'
  return 'text-stone-700'
}

function pendingStatusLabel(status: string) {
  const labels: Record<string, string> = {
    PENDING_CONFIRMATION: '待确认',
    CONFIRMED_SUBMITTING: '提交中',
    SUBMITTED: '已提交',
    REJECTED_BY_USER: '已拒绝',
    EXPIRED: '已过期',
    BLOCKED_BY_RISK: '风控关闭',
    SUBMIT_FAILED: '提交失败',
  }
  return labels[status] ?? status
}

function pendingStatusTone(status: string) {
  if (status === 'PENDING_CONFIRMATION') return 'bg-sky-100 text-sky-800'
  if (status === 'SUBMITTED') return 'bg-emerald-100 text-emerald-800'
  if (status === 'SUBMIT_FAILED' || status === 'BLOCKED_BY_RISK') return 'bg-rose-100 text-rose-800'
  return 'bg-stone-100 text-stone-700'
}

function signalStatusTone(status: string) {
  if (status === 'SUBMITTED') return 'bg-emerald-100 text-emerald-800'
  if (status === 'REJECTED_BY_USER' || status === 'EXPIRED' || status === 'HOLD') return 'bg-stone-100 text-stone-700'
  if (status === 'CANDIDATE_POOL' || status === 'CONFIRMED_SUBMITTING') return 'bg-sky-100 text-sky-800'
  if (status === 'SUBMIT_FAILED' || status === 'BLOCKED_BY_RISK') return 'bg-rose-100 text-rose-800'
  if (status === 'SKIPPED') return 'bg-amber-100 text-amber-800'
  return 'bg-sky-500 text-white'
}

function signalStatusLabel(status: string) {
  const labels: Record<string, string> = {
    HOLD: '观望',
    CANDIDATE_POOL: '候选池中',
    PENDING_CONFIRMATION: '待确认',
    CONFIRMED_SUBMITTING: '提交中',
    SUBMITTED: '已提交',
    REJECTED_BY_USER: '已拒绝',
    EXPIRED: '已过期',
    BLOCKED_BY_RISK: '风控关闭',
    SUBMIT_FAILED: '提交失败',
    SKIPPED: '风控拦截',
  }
  return labels[status] ?? status
}

function candidateStatusLabel(status: string) {
  const labels: Record<string, string> = {
    ACTIVE: '生效中',
    WATCH: '观察',
    PROMOTED: '已推进',
    SUPPRESSED: '已暂缓',
    EXPIRED: '已过期',
    DISABLED_BY_MODE_SWITCH: '模式切换停用',
  }
  return labels[status] ?? status
}

function formatDateTime(value?: string) {
  if (!value) return '不可用'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatFee(fee?: LiveOrderFeeContext) {
  if (!fee || fee.feeAmount === null || fee.feeAmount === undefined) return '不可用'
  const symbol = fee.currency === 'HKD' ? 'HK$' : '$'
  return `${symbol}${fee.feeAmount.toFixed(2)}`
}

function formatOrderMoney(value: string | null, currency: string) {
  if (value === null || value === '') return '未成交'
  const symbol = currency === 'HKD' ? 'HK$' : currency === 'USD' ? '$' : `${currency} `
  return `${symbol}${value}`
}

function formatDecisionMode(mode?: string) {
  if (mode === 'candidate_pool') return '候选池裁决'
  if (mode === 'legacy_direct') return '大模型直推'
  return mode ?? 'Longbridge'
}

function tickerFilterItems(tickers: string[]) {
  const unique = [...new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean))]
  return [
    ...ALL_TICKER_FILTER,
    ...unique.sort((left, right) => left.localeCompare(right)).map((ticker) => ({ value: ticker, label: ticker })),
  ]
}
