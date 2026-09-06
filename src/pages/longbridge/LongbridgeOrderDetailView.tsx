import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { localizeLongbridgeOrderError } from '../../../shared/orderErrorMessages'
import type { LongbridgeCombinedOrderDetailResponse } from '../../../shared/longbridgeTypes'
import {
  displayManagedOrderEventDetail,
  displayOrderSession,
  displayOrderType,
  displayPendingOrderStatus,
  displaySide,
} from '@/utils/simulationDisplay'
import LongbridgeWorkbenchNav from './LongbridgeWorkbenchNav'

export default function LongbridgeOrderDetailView() {
  const { orderId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const pendingOrderId = searchParams.get('pendingOrderId') ?? undefined
  const submittedAt = searchParams.get('submittedAt') ?? undefined
  const [detail, setDetail] = useState<LongbridgeCombinedOrderDetailResponse>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const loadDetail = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const params = new URLSearchParams()
      if (pendingOrderId) params.set('pendingOrderId', pendingOrderId)
      if (submittedAt) params.set('submittedAt', submittedAt)
      const suffix = params.size ? `?${params.toString()}` : ''
      const response = await fetch(`/api/longbridge/live-trading/orders/${encodeURIComponent(orderId)}/detail${suffix}`)
      const payload = await response.json().catch(() => undefined) as LongbridgeCombinedOrderDetailResponse | undefined
      if (!payload?.ok) throw new Error(payload?.error ?? `组合订单详情请求失败，HTTP ${response.status}。`)
      setDetail(payload)
    } catch (requestError) {
      setError(localizeLongbridgeOrderError(
        requestError instanceof Error ? requestError.message : '组合订单详情加载失败。',
      ))
    } finally {
      setLoading(false)
    }
  }, [orderId, pendingOrderId, submittedAt])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const systemOrder = detail?.systemOrder
  const brokerOrder = detail?.brokerOrder
  const managedOrder = detail?.managedOrder
  const ticker = brokerOrder?.symbol ?? systemOrder?.intent.ticker ?? managedOrder?.ticker ?? '长桥订单'

  return (
    <main className="min-h-screen bg-stone-50 text-stone-950">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <LongbridgeWorkbenchNav />
        <Link className="inline-flex items-center gap-2 text-sm font-semibold text-sky-700" to="/longbridge/live-trading">
          <ArrowLeft size={16} />
          返回长桥实盘
        </Link>

        <header className="border-y border-stone-200 bg-white py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-sky-700">系统订单与券商订单</p>
              <h1 className="mt-2 text-2xl font-semibold">{ticker} · 组合订单详情</h1>
              <p className="mt-2 break-all text-sm text-stone-500">券商订单号：{detail?.orderId || orderId}</p>
            </div>
            <button
              className="inline-flex h-9 w-9 items-center justify-center border border-stone-200 bg-white text-stone-700 disabled:opacity-50"
              disabled={loading}
              title="刷新组合订单详情"
              aria-label="刷新组合订单详情"
              onClick={() => void loadDetail()}
            >
              <RefreshCw className={loading ? 'animate-spin' : ''} size={16} />
            </button>
          </div>
        </header>

        {loading && !detail ? <div className="border border-stone-200 bg-white p-6 text-sm text-stone-500">正在读取组合订单详情...</div> : null}
        {error ? <div className="border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}

        {detail ? (
          <>
            <section className="grid overflow-hidden border border-stone-200 bg-white sm:grid-cols-3">
              <Field label="关联状态" value={systemOrder && brokerOrder ? '系统订单与券商订单已关联' : systemOrder ? '仅有系统订单' : '未关联系统订单'} />
              <Field label="系统订单号" value={systemOrder?.id ?? '未关联'} />
              <Field label="券商订单号" value={brokerOrder?.orderId ?? detail.orderId ?? '未生成'} />
            </section>

            <section className="grid items-start gap-6 lg:grid-cols-2">
              <OrderPanel eyebrow="系统订单" title="待确认订单详情">
                {systemOrder ? (
                  <>
                    <div className="grid overflow-hidden border border-stone-200 sm:grid-cols-2">
                      <Field label="系统状态" value={displayPendingOrderStatus(systemOrder.status)} />
                      <Field label="标的 / 方向" value={`${systemOrder.intent.ticker} · ${displaySide(systemOrder.intent.side, 'zh')}`} />
                      <Field label="订单类型" value={displayOrderType(systemOrder.intent.orderType, 'zh')} />
                      <Field label="交易时段" value={displayOrderSession(systemOrder.intent.orderSession, 'zh')} />
                      <Field label="委托数量" value={`${systemOrder.intent.quantity} 股`} />
                      <Field label="委托价格" value={systemOrder.intent.orderType === 'MARKET' ? '市价' : `$${systemOrder.intent.limitPrice.toFixed(2)}`} />
                      <Field label="生成时间" value={dateTime(systemOrder.createdAt)} />
                      <Field label="确认时间" value={dateTime(systemOrder.confirmation?.confirmedAt)} />
                      <Field label="信号编号" value={systemOrder.intent.signalId} />
                      <Field label="决策链路" value={decisionMode(systemOrder.decisionMode)} />
                    </div>
                    <TextBlock label="策略理由" text={systemOrder.intent.reason || systemOrder.signal.reason} />
                    <TextBlock label="风险提示" text={systemOrder.riskWarnings.join('；') || '无'} />
                    {systemOrder.submittedOrder?.error ? (
                      <Notice text={localizeLongbridgeOrderError(systemOrder.submittedOrder.error)} />
                    ) : null}
                  </>
                ) : (
                  <EmptyState text="该订单可能由长桥客户端或其他系统创建，未找到关联的待确认订单。" />
                )}
              </OrderPanel>

              <OrderPanel eyebrow="券商订单" title="长桥真实订单详情">
                {brokerOrder ? (
                  <>
                    <div className="grid overflow-hidden border border-stone-200 sm:grid-cols-2">
                      <Field label="券商状态" value={brokerOrder.statusLabel} />
                      <Field label="证券名称" value={brokerOrder.stockName || brokerOrder.symbol} />
                      <Field label="方向" value={brokerOrder.sideLabel} />
                      <Field label="订单类型" value={brokerOrder.orderTypeLabel} />
                      <Field label="委托 / 成交" value={`${brokerOrder.quantity} / ${brokerOrder.executedQuantity}`} />
                      <Field label="委托价格" value={money(brokerOrder.price, brokerOrder.currency)} />
                      <Field label="成交均价" value={money(brokerOrder.executedPrice, brokerOrder.currency)} />
                      <Field label="有效期 / 时段" value={`${brokerOrder.timeInForceLabel} · ${brokerOrder.outsideRthLabel}`} />
                      <Field label="提交时间" value={dateTime(brokerOrder.submittedAt)} />
                      <Field label="更新时间" value={dateTime(brokerOrder.updatedAt)} />
                      <Field label="费用合计" value={money(brokerOrder.totalCharge, brokerOrder.chargeCurrency)} />
                      <Field label="备注" value={brokerOrder.remark || '无'} />
                    </div>
                    {brokerOrder.message ? <Notice text={localizeLongbridgeOrderError(brokerOrder.message)} /> : null}
                  </>
                ) : (
                  <EmptyState text={detail.error ? localizeLongbridgeOrderError(detail.error) : '券商未生成可查询的真实订单。'} />
                )}
              </OrderPanel>
            </section>

            {brokerOrder ? (
              <>
                <DetailTable
                  title={`成交记录（${brokerOrder.executions.length}）`}
                  headers={['成交编号', '数量', '成交价格', '成交时间']}
                  rows={brokerOrder.executions.map((item) => [item.tradeId, item.quantity, money(item.price, brokerOrder.currency), dateTime(item.tradeDoneAt)])}
                />
                <DetailTable
                  title={`券商状态过程（${brokerOrder.history.length}）`}
                  headers={['状态', '数量', '价格', '时间', '说明']}
                  rows={brokerOrder.history.map((item) => [
                    item.statusLabel,
                    item.quantity,
                    money(item.price, brokerOrder.currency),
                    dateTime(item.time),
                    localizeLongbridgeOrderError(item.message),
                  ])}
                />
                <DetailTable
                  title={`费用明细（${brokerOrder.charges.length}）`}
                  headers={['类别', '项目', '金额', '币种']}
                  rows={brokerOrder.charges.map((item) => [item.category, item.name, item.amount, item.currency])}
                />
              </>
            ) : null}

            <DetailTable
              title={`系统监管过程（${detail.managedEvents.length}）`}
              headers={['时间', '事件', '来源', '详情']}
              rows={detail.managedEvents.map((event) => [
                dateTime(event.createdAt),
                eventLabel(event.eventType),
                sourceLabel(event.source),
                displayManagedOrderEventDetail(event.detail),
              ])}
            />
          </>
        ) : null}
      </div>
    </main>
  )
}

function OrderPanel({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
      <p className="text-xs font-semibold tracking-[0.2em] text-sky-700">{eyebrow}</p>
      <h2 className="mt-2 text-xl font-semibold">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b border-r border-stone-200 p-4"><p className="text-xs text-stone-500">{label}</p><p className="mt-1 break-words font-semibold">{value || '无'}</p></div>
}

function TextBlock({ label, text }: { label: string; text: string }) {
  return <div className="border border-stone-200 bg-stone-50 p-4 text-sm"><p className="font-semibold text-stone-700">{label}</p><p className="mt-2 leading-6 text-stone-600">{text}</p></div>
}

function EmptyState({ text }: { text: string }) {
  return <p className="border border-stone-200 bg-stone-50 p-4 text-sm text-stone-500">{text}</p>
}

function Notice({ text }: { text: string }) {
  return <div className="border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{text}</div>
}

function DetailTable({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  return (
    <section className="bg-white py-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3 overflow-x-auto border border-stone-200">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-stone-50 text-xs text-stone-500"><tr>{headers.map((header) => <th key={header} className="px-4 py-3">{header}</th>)}</tr></thead>
          <tbody className="divide-y divide-stone-200">
            {rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell} className="px-4 py-3">{value || '无'}</td>)}</tr>)}
          </tbody>
        </table>
        {!rows.length ? <p className="p-4 text-sm text-stone-500">暂无记录。</p> : null}
      </div>
    </section>
  )
}

function money(value: string | null, currency: string) {
  if (value === null || value === '') return '未成交'
  return `${currency === 'USD' ? '$' : `${currency} `}${value}`
}

function dateTime(value?: string | null) {
  if (!value) return '无'
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : value
}

function decisionMode(value?: string) {
  if (value === 'candidate_pool') return '候选池组合裁决'
  if (value === 'legacy_direct') return '老逻辑直推'
  return '系统策略'
}

function eventLabel(value: string) {
  const labels: Record<string, string> = {
    registered: '纳入系统监管',
    reconciled: '券商状态同步',
    sync_failed: '券商状态同步失败',
    rule_triggered: '硬规则触发',
    model_decided: '模型复核完成',
    cancel_requested: '撤单已请求',
    cancel_accepted: '券商已受理',
    cancel_rejected: '券商未受理',
    cancel_terminal: '撤单终态确认',
    cancel_uncertain: '撤单结果待确认',
  }
  return labels[value] ?? '未知事件'
}

function sourceLabel(value: string) {
  return ({ reconcile: '状态同步', hard_rule: '硬规则', model: '模型', manual: '人工', system: '系统' } as Record<string, string>)[value] ?? '系统'
}
