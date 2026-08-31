import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import AssetPrivacyToggle from '@/components/common/AssetPrivacyToggle'
import Badge from '@/components/common/Badge'
import MetricCard from '@/components/common/MetricCard'
import ProfitValue from '@/components/common/ProfitValue'
import TradeStrategyConfigPanel from '@/components/trading/TradeStrategyConfigPanel'
import PositionsPanel from '@/components/workspace/PositionsPanel'
import { useSimulationTrading } from '@/hooks/useSimulationTrading'
import { useUiStore } from '@/stores/uiStore'
import { maskAssetValue } from '@/utils/displayText'
import { displayOrderPriceWithType, displayOrderSession, displaySide, displaySignalModel } from '@/utils/simulationDisplay'
import type { SimulationHistoryPage } from '../../shared/types'

type PageMeta = Pick<SimulationHistoryPage<unknown>, 'page' | 'pageSize' | 'total' | 'totalPages'>

export default function SimulationTradingView() {
  const language = useUiStore((state) => state.language)
  const assetPrivacyHidden = useUiStore((state) => state.assetPrivacyHidden)
  const navigate = useNavigate()
  const { data, history, futuOrders, tradeStrategyConfig, loading, savingConfig, refreshing, lastRefreshedAt, error, start, stop, runOnce, refresh, loadHistory, loadFutuOrders, saveLlmConfig, saveTradeStrategyConfig } = useSimulationTrading()
  const account = data?.account
  const engine = data?.engine
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedConcurrency, setSelectedConcurrency] = useState(1)
  const [interactionError, setInteractionError] = useState<string>()

  useEffect(() => {
    if (!data?.llmRuntimeConfig) return
    setSelectedModel(data.llmRuntimeConfig.model)
    setSelectedConcurrency(data.llmRuntimeConfig.concurrency)
  }, [data?.llmRuntimeConfig])

  const futuOrderRows = futuOrders?.orders ?? []
  const signalRows = history.signals?.items ?? data?.latestSignals ?? []
  const historyOrderRows = history.orders?.items ?? data?.latestOrders ?? []

  const openFutuOrderDetail = (rowIndex: number) => {
    const order = futuOrderRows[rowIndex]
    if (!order) return
    setInteractionError(undefined)
    navigate(`/simulation/futu-orders/${encodeURIComponent(order.orderId)}`, {
      state: {
        ticker: order.ticker,
        startDate: futuOrders?.startDate,
        endDate: futuOrders?.endDate,
      },
    })
  }

  const openHistoryOrderDetail = (rowIndex: number) => {
    const order = historyOrderRows[rowIndex]
    if (!order) return
    if (!order.historyId) {
      setInteractionError(language === 'zh' ? '该订单尚未完成历史落库，请刷新后重试。' : 'This order is not persisted yet; refresh and try again.')
      return
    }
    setInteractionError(undefined)
    navigate(`/simulation/orders/${order.historyId}`)
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <section className="rounded-[2rem] border border-amber-100 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap gap-2">
                <Badge tone="violet">SIMULATE</Badge>
                <Badge tone={engine?.running ? 'emerald' : 'amber'}>{engine?.running ? (language === 'zh' ? '运行中' : 'Running') : language === 'zh' ? '手动启动' : 'Manual Start'}</Badge>
                <Badge tone="cyan">{language === 'zh' ? '用户股票池实时回调' : 'User Universe Realtime'}</Badge>
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-stone-950">{language === 'zh' ? 'Futu 模拟盘量化交易' : 'Futu Paper Quant Trading'}</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-600">
                {language === 'zh'
                  ? '本页使用 Futu SIMULATE 账户执行大模型自主正股/ETF交易。行情来自用户票池的实时报价、分时、K 线和摆盘回调；允许模拟盘正股/ETF买入、卖空和平仓，不做期权、不碰实盘。'
                  : 'This page runs LLM autonomous stock/ETF trading in Futu SIMULATE. Market data comes from the user universe quote, ticker, K-line and order book callbacks; simulated long, short and close only.'}
              </p>
              {error ? <p className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p> : null}
              {interactionError ? <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">{interactionError}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-2xl bg-orange-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500 disabled:opacity-60" disabled={loading || engine?.running} onClick={start}>
                {language === 'zh' ? '启动' : 'Start'}
              </button>
              <button className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-stone-100 disabled:opacity-60" disabled={loading || !engine?.running} onClick={stop}>
                {language === 'zh' ? '停止' : 'Stop'}
              </button>
              <button className="rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-60" disabled={loading} onClick={runOnce}>
                {language === 'zh' ? '单轮评估' : 'Run Once'}
              </button>
              <button className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60" disabled={loading} onClick={() => refresh()}>
                {language === 'zh' ? '刷新' : 'Refresh'}
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label={language === 'zh' ? '模拟账户' : 'Paper Account'} value={account?.selectedAccountId ?? 'unavailable'} accent="cyan" helper={account?.trading.warning} />
            <MetricCard label={language === 'zh' ? '总资产' : 'Total Assets'} value={assetPrivacyHidden ? maskAssetValue() : account?.summary.totalAssets ?? 'unavailable'} accent="cyan" helper={account?.summary.currency} action={<AssetPrivacyToggle />} />
            <MetricCard label={language === 'zh' ? '现金' : 'Cash'} value={assetPrivacyHidden ? maskAssetValue() : account?.summary.cash ?? 'unavailable'} accent="slate" helper={language === 'zh' ? '模拟账户现金' : 'Paper account cash'} />
            <MetricCard label={language === 'zh' ? '购买力' : 'Buying Power'} value={assetPrivacyHidden ? maskAssetValue() : account?.summary.buyingPower ?? 'unavailable'} accent="emerald" />
            <MetricCard label={language === 'zh' ? '当日盈亏' : 'Daily P/L'} value={assetPrivacyHidden ? maskAssetValue() : <ProfitValue value={account?.summary.dailyPnL ?? 'unavailable'} language={language} />} accent="amber" valueClassName="text-inherit" />
            <MetricCard label={language === 'zh' ? '总盈亏' : 'Total P/L'} value={assetPrivacyHidden ? maskAssetValue() : <ProfitValue value={account?.summary.totalPnL ?? 'unavailable'} language={language} />} accent="red" valueClassName="text-inherit" />
          <MetricCard label={language === 'zh' ? '策略' : 'Strategy'} value={engine?.strategy ?? 'LLM_AUTONOMOUS_STOCK_TRADER'} accent="slate" helper={language === 'zh' ? '大模型自主交易' : 'LLM autonomous trading'} />
          <MetricCard label={language === 'zh' ? '评估间隔' : 'Evaluation Interval'} value={engine ? `${engine.runIntervalMs / 1000}s` : '60s'} accent="cyan" helper={engine?.lastRunAt || (language === 'zh' ? '启动后持续运行，后端重启会重置' : 'Continuous after start; backend restart resets state')} />
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <InfoPanel
            title={language === 'zh' ? '大模型交易票池' : 'LLM Trading Universe'}
            items={(data?.universe ?? []).map((item) => `${item.ticker} · ${item.label} · ${marketSessionLabel(item, language)}`)}
            emptyText={language === 'zh' ? '暂无股票池' : 'No universe'}
          />
          <InfoPanel
            title={language === 'zh' ? '模型建议数据窗口' : 'Model Data Window'}
            items={
              engine?.dataWindow
                ? [
                    `${language === 'zh' ? '1 分钟 K 线' : '1m K-line'}：${engine.dataWindow.kline1mBars}`,
                    `${language === 'zh' ? '分时点' : 'Ticker points'}：${engine.dataWindow.tickerPoints}`,
                    `${language === 'zh' ? '摆盘深度' : 'Order book depth'}：${engine.dataWindow.orderBookDepth}`,
                    `${language === 'zh' ? '评估间隔' : 'Interval'}：${engine.dataWindow.pollIntervalSeconds}s`,
                    engine.dataWindow.reason,
                  ]
                : [language === 'zh' ? '启动后先询问大模型需要多长时间窗口的数据。' : 'The model will advise the data window when the engine starts.']
            }
            emptyText={language === 'zh' ? '暂无数据窗口' : 'No data window'}
          />
        </section>

        <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-amber-800">{language === 'zh' ? '大模型配置' : 'LLM Config'}</p>
              <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '运行时模型与并发' : 'Runtime Model and Concurrency'}</h2>
              <p className="mt-2 text-sm text-stone-600">
                {language === 'zh'
                  ? `当前模型：${data?.llmRuntimeConfig.modelLabel ?? 'unavailable'}；当前并发：${data?.llmRuntimeConfig.concurrency ?? 0} / 最大 ${data?.llmRuntimeConfig.maxConcurrency ?? data?.universe.length ?? 0}。保存后从下一轮评估生效。`
                  : `Current model: ${data?.llmRuntimeConfig.modelLabel ?? 'unavailable'}; concurrency: ${data?.llmRuntimeConfig.concurrency ?? 0} / max ${data?.llmRuntimeConfig.maxConcurrency ?? data?.universe.length ?? 0}. Changes take effect next evaluation.`}
              </p>
            </div>
            <Badge tone="violet">{data?.llmRuntimeConfig.updatedAt ?? 'unavailable'}</Badge>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-[1.2fr_0.8fr_auto]">
            <label className="text-sm font-semibold text-stone-700">
              {language === 'zh' ? '模型' : 'Model'}
              <select className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                {(data?.modelOptions ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold text-stone-700">
              {language === 'zh' ? '并发' : 'Concurrency'}
              <select className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900" value={selectedConcurrency} onChange={(event) => setSelectedConcurrency(Number(event.target.value))}>
                {Array.from({ length: data?.llmRuntimeConfig.maxConcurrency ?? data?.universe.length ?? 1 }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="self-end rounded-2xl bg-orange-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500 disabled:opacity-60"
              disabled={savingConfig || !selectedModel}
              onClick={() => saveLlmConfig({ model: selectedModel, concurrency: selectedConcurrency })}
            >
              {savingConfig ? (language === 'zh' ? '保存中' : 'Saving') : language === 'zh' ? '保存配置' : 'Save Config'}
            </button>
          </div>
        </section>

        <TradeStrategyConfigPanel
          title={language === 'zh' ? '交易策略与 Prompt 版本' : 'Trade Strategy and Prompt Versions'}
          subtitle={language === 'zh' ? '模拟盘策略选择独立保存，可用于验证不同风控与 Prompt 组合。' : 'Simulation strategy selection is saved independently for testing risk and prompt variants.'}
          config={tradeStrategyConfig}
          saving={savingConfig}
          onSave={saveTradeStrategyConfig}
        />

        <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-amber-800">{language === 'zh' ? '模拟交易引擎' : 'Paper Trading Engine'}</p>
              <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '运行状态' : 'Runtime Status'}</h2>
            </div>
            <Badge tone={engine?.running ? 'emerald' : 'slate'}>{engine?.running ? (language === 'zh' ? '运行中' : 'Running') : language === 'zh' ? '已停止' : 'Stopped'}</Badge>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatusLine label={language === 'zh' ? 'Universe' : 'Universe'} value={`${engine?.universe.length ?? 0}`} />
            <StatusLine label={language === 'zh' ? '信号数' : 'Signals'} value={`${engine?.signalCount ?? 0}`} />
            <StatusLine label={language === 'zh' ? '订单数' : 'Orders'} value={`${engine?.submittedOrderCount ?? 0}`} />
            <StatusLine label={language === 'zh' ? '下一轮' : 'Next Run'} value={engine?.nextRunAt || 'unavailable'} />
          </div>
          {engine?.lastError ? <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{engine.lastError}</p> : null}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold tracking-[0.25em] text-amber-800">{language === 'zh' ? '模拟持仓' : 'Paper Positions'}</p>
              <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? 'SIMULATE 持仓层级' : 'SIMULATE Position Hierarchy'}</h2>
            </div>
            <Badge tone="cyan">{language === 'zh' ? `${account?.positions.length ?? 0} 条` : `${account?.positions.length ?? 0} positions`}</Badge>
          </div>
          <PositionsPanel positions={account?.positions ?? []} />
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <TablePanel
            title={language === 'zh' ? 'Futu 订单状态' : 'Futu Order Status'}
            headers={
              language === 'zh'
                ? ['标的', '方向', '状态', '数量', '已成交', '剩余', '委托价', '成交均价', '创建时间', '更新时间', '备注']
                : ['Ticker', 'Side', 'Status', 'Qty', 'Filled', 'Remaining', 'Order Price', 'Avg Fill', 'Created', 'Updated', 'Remark']
            }
            rows={futuOrderRows.map((order) => [
              order.ticker,
              displaySide(order.side, language),
              order.orderStatusLabel || order.orderStatus,
              order.quantity,
              order.filledQuantity,
              order.remainingQuantity,
              displayOrderPriceWithType(order.price, order.orderType, language),
              order.filledAveragePrice,
              order.createTime,
              order.updatedTime,
              order.remark,
            ])}
            page={futuOrders}
            onPageChange={(page) => loadFutuOrders(page)}
            onRowClick={openFutuOrderDetail}
            onRefresh={refresh}
            autoRefreshEnabled
            refreshing={refreshing}
            lastRefreshedAt={lastRefreshedAt}
            language={language}
          />
          <TablePanel
            title={language === 'zh' ? '历史策略信号' : 'Signal History'}
            headers={language === 'zh' ? ['标的', '模型', '动作', '数量', '限价', '置信度', '模型理由', '风险提示', '数据窗口'] : ['Ticker', 'Model', 'Action', 'Qty', 'Limit', 'Confidence', 'Reason', 'Risk', 'Window']}
            rows={signalRows.map((signal) => [
              signal.ticker,
              displaySignalModel(signal.modelLabel, signal.model, language),
              displaySide(signal.side, language),
              signal.quantity,
              signal.limitPrice,
              signal.confidence,
              signal.reason,
              signal.riskAssessment,
              signal.dataWindow,
            ])}
            page={history.signals}
            onPageChange={(page) => loadHistory('signals', page)}
            onRefresh={refresh}
            autoRefreshEnabled={engine?.running === true}
            refreshing={refreshing}
            lastRefreshedAt={lastRefreshedAt}
            language={language}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <TablePanel
            title={language === 'zh' ? '历史模拟订单（大模型决策）' : 'Paper Order History (LLM Decisions)'}
            headers={language === 'zh' ? ['标的', '方向', '数量', '交易时段', '委托价', '模型确认', '状态'] : ['Ticker', 'Side', 'Qty', 'Session', 'Order Price', 'LLM Review', 'Status']}
            rows={historyOrderRows.map((order) => [
                order.ticker,
                displaySide(order.side, language),
                order.quantity,
                displayOrderSession(order.orderSession, language),
                displayOrderPriceWithType(order.limitPrice, order.orderType, language),
                order.llmDecision ? (order.llmDecision.approved ? (language === 'zh' ? '已批准' : 'Approved') : language === 'zh' ? '已阻断' : 'Blocked') : 'unavailable',
                order.ok ? `OK · ${order.submittedAt}` : order.error ?? 'Error',
              ])}
            page={history.orders}
            onPageChange={(page) => loadHistory('orders', page)}
            onRowClick={openHistoryOrderDetail}
            onRefresh={refresh}
            autoRefreshEnabled={engine?.running === true}
            refreshing={refreshing}
            lastRefreshedAt={lastRefreshedAt}
            language={language}
          />
          <TablePanel
            title={language === 'zh' ? '历史跳过原因与错误日志' : 'Skipped Tickers and Error History'}
            headers={language === 'zh' ? ['标的', '原因', '时间'] : ['Ticker', 'Reason', 'Time']}
            rows={(history.skipped?.items ?? data?.skippedTickers ?? []).map((item) => [item.ticker, item.reason, item.updatedAt])}
            page={history.skipped}
            onPageChange={(page) => loadHistory('skipped', page)}
            onRefresh={refresh}
            autoRefreshEnabled={engine?.running === true}
            refreshing={refreshing}
            lastRefreshedAt={lastRefreshedAt}
            language={language}
          />
        </div>
      </div>
    </main>
  )
}

function InfoPanel({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }) {
  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm">
      <h2 className="text-2xl font-semibold text-stone-950">{title}</h2>
      <div className="mt-4 flex flex-wrap gap-2">
        {items.length ? items.map((item) => <span key={item} className="rounded-full border border-amber-100 bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-900">{item}</span>) : <span className="text-sm text-stone-500">{emptyText}</span>}
      </div>
    </section>
  )
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
      <p className="text-xs font-semibold text-stone-500">{label}</p>
      <p className="mt-1 break-words font-mono text-sm font-semibold text-stone-900">{value}</p>
    </div>
  )
}

function TablePanel({
  title,
  headers,
  rows,
  page,
  onPageChange,
  onRowClick,
  onRefresh,
  autoRefreshEnabled = true,
  refreshing = false,
  lastRefreshedAt,
  language = 'zh',
}: {
  title: string
  headers: string[]
  rows: string[][]
  page?: PageMeta
  onPageChange?: (page: number) => void
  onRowClick?: (rowIndex: number) => void
  onRefresh?: () => void
  autoRefreshEnabled?: boolean
  refreshing?: boolean
  lastRefreshedAt?: string
  language?: 'zh' | 'en'
}) {
  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold text-stone-950">{title}</h2>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${autoRefreshEnabled ? 'border-amber-100 bg-amber-50 text-amber-800' : 'border-stone-200 bg-stone-50 text-stone-500'}`}>
            {autoRefreshEnabled ? (language === 'zh' ? '30 秒自动刷新' : 'Auto 30s') : language === 'zh' ? '停止状态不自动刷新' : 'No auto refresh while stopped'}
          </span>
          {lastRefreshedAt ? <span className="text-xs font-semibold text-stone-500">{language === 'zh' ? `更新：${formatRefreshTime(lastRefreshedAt)}` : `Updated: ${formatRefreshTime(lastRefreshedAt)}`}</span> : null}
          {page ? (
            <span className="text-sm font-semibold text-stone-500">
              {language === 'zh' ? `第 ${page.page} / ${page.totalPages} 页 · 共 ${page.total} 条` : `Page ${page.page} / ${page.totalPages} · ${page.total} records`}
            </span>
          ) : null}
          {onRefresh ? (
            <button className="rounded-xl border border-amber-200 bg-white px-3 py-1.5 text-sm font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50" disabled={refreshing} onClick={onRefresh}>
              {refreshing ? (language === 'zh' ? '刷新中' : 'Refreshing') : language === 'zh' ? '手动刷新' : 'Refresh'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs font-semibold text-stone-500">
            <tr>
              {headers.map((header) => (
                <th key={header} className="border-b border-stone-200 px-3 py-3">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.length ? (
              rows.map((row, rowIndex) => (
                <tr
                  key={`${title}-${rowIndex}`}
                  className={
                    onRowClick
                      ? 'group relative z-0 cursor-pointer transition-transform duration-200 ease-out hover:z-10 hover:-translate-y-1 active:translate-y-0 active:scale-[0.998] focus-visible:z-10 focus-visible:-translate-y-1 focus-visible:outline-none'
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  onClick={onRowClick ? () => onRowClick(rowIndex) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onRowClick(rowIndex)
                          }
                        }
                      : undefined
                  }
                >
                  {row.map((cell, index) => {
                    const clickableCellClass = onRowClick
                      ? [
                          'transition-all duration-200 ease-out',
                          'group-hover:bg-amber-100 group-hover:text-stone-950',
                          'group-hover:shadow-[0_16px_38px_rgba(8,145,178,0.28)]',
                          'group-hover:ring-2 group-hover:ring-amber-400/80',
                          'group-focus-visible:bg-amber-100 group-focus-visible:text-stone-950',
                          'group-focus-visible:shadow-[0_16px_38px_rgba(8,145,178,0.28)]',
                          'group-focus-visible:ring-2 group-focus-visible:ring-amber-500',
                          index === 0 ? 'group-hover:rounded-l-2xl group-focus-visible:rounded-l-2xl' : '',
                          index === row.length - 1 ? 'group-hover:rounded-r-2xl group-focus-visible:rounded-r-2xl' : '',
                        ].join(' ')
                      : ''
                    return (
                      <td key={`${title}-${rowIndex}-${index}`} className={`max-w-[360px] px-3 py-3 align-top text-stone-700 ${clickableCellClass}`}>
                        {cell}
                      </td>
                    )
                  })}
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-3 py-5 text-center text-stone-500" colSpan={headers.length}>暂无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {page && onPageChange ? (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className="rounded-xl border border-stone-200 px-3 py-1.5 text-sm font-semibold text-stone-700 disabled:opacity-50" disabled={page.page <= 1} onClick={() => onPageChange(page.page - 1)}>
            {language === 'zh' ? '上一页' : 'Previous'}
          </button>
          <button className="rounded-xl border border-stone-200 px-3 py-1.5 text-sm font-semibold text-stone-700 disabled:opacity-50" disabled={page.page >= page.totalPages} onClick={() => onPageChange(page.page + 1)}>
            {language === 'zh' ? '下一页' : 'Next'}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function formatRefreshTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function marketSessionLabel(item: { marketSession?: { labelZh: string; labelEn: string; tradable: boolean; state: string } }, language: 'zh' | 'en'): string {
  const session = item.marketSession
  if (!session) return language === 'zh' ? '交易时段未知' : 'Session unknown'
  const label = language === 'zh' ? session.labelZh : session.labelEn
  const suffix = session.tradable ? (language === 'zh' ? '可交易' : 'Tradable') : language === 'zh' ? '不可交易' : 'Not tradable'
  return `${label} · ${suffix}`
}
