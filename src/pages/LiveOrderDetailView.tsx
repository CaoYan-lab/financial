import { useEffect, type ReactNode } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import Badge from '@/components/common/Badge'
import {
  OrderDetailField,
  OrderDetailFieldGrid,
  OrderDetailPanel,
  OrderDetailTable,
} from '@/components/OrderDetailSurface'
import { useLiveTrading } from '@/hooks/useLiveTrading'
import { displayManagedOrderEventDetail, displayOrderPriceWithType, displayOrderSession, displayOrderType, displayPendingOrderStatus, displaySignalModel, displaySide } from '@/utils/simulationDisplay'

export default function LiveOrderDetailView() {
  const { orderId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const {
    data,
    error,
    history,
    futuOrders,
    futuOrderDetail,
    loadingFutuOrderDetailId,
    futuOrderDetailError,
    managedOrders,
    loadFutuOrderDetail,
    clearFutuOrderDetail,
  } = useLiveTrading()
  const pending =
    data?.pendingOrders.find((order) => order.id === orderId || order.signal.id === orderId)
    ?? history['pending-orders']?.items.find(
      (order) =>
        order.id === orderId
        || order.signal.id === orderId
        || order.submittedOrder?.orderId === orderId,
    )
  const submitted =
    data?.submittedOrders.find((order) => order.pendingOrderId === orderId || order.orderId === orderId || order.signalId === orderId)
    ?? pending?.submittedOrder
  const signal = pending?.signal ?? data?.latestSignals.find((item) => item.id === submitted?.signalId)
  const listedFutuOrder = futuOrders?.orders.find((order) => order.orderId === orderId || order.orderId === submitted?.orderId)
  const brokerOrderId =
    submitted?.orderId
    ?? pending?.submittedOrder?.orderId
    ?? searchParams.get('brokerOrderId')
    ?? listedFutuOrder?.orderId
    ?? (searchParams.get('ticker') ? orderId : undefined)
  const brokerTicker =
    submitted?.ticker
    ?? pending?.intent.ticker
    ?? searchParams.get('ticker')
    ?? listedFutuOrder?.ticker
  const brokerSubmittedAt =
    submitted?.submittedAt
    ?? pending?.submittedOrder?.submittedAt
    ?? searchParams.get('submittedAt')
    ?? listedFutuOrder?.createTime
  const liveDetail = futuOrderDetail?.ok ? futuOrderDetail : undefined
  const submitFailed = submitted?.ok === false
  const managedEvents = managedOrders?.events.filter((event) => event.orderId === brokerOrderId) ?? []

  useEffect(() => {
    clearFutuOrderDetail()
    if (submitFailed || !brokerOrderId || !brokerTicker || brokerOrderId === 'unavailable') return
    void loadFutuOrderDetail({
      orderId: brokerOrderId,
      ticker: brokerTicker,
      submittedAt: brokerSubmittedAt,
    })
    return clearFutuOrderDetail
  }, [brokerOrderId, brokerSubmittedAt, brokerTicker, clearFutuOrderDetail, loadFutuOrderDetail, submitFailed])

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <Link className="inline-flex items-center gap-2 rounded-2xl border border-orange-200 bg-white/90 px-4 py-2 text-sm font-semibold text-orange-700 shadow-sm hover:bg-orange-50" to="/live-trading">
          <ArrowLeft size={16} />
          返回 Futu 实盘
        </Link>
        <header className="rounded-3xl border border-orange-300/30 bg-white/90 p-6 shadow-2xl shadow-rose-200/30 backdrop-blur">
          <p className="text-xs font-semibold tracking-[0.25em] text-orange-700">系统订单与券商订单</p>
          <h1 className="mt-2 text-3xl font-semibold">{brokerTicker ?? signal?.ticker ?? 'Futu'} · 组合订单详情</h1>
          <p className="mt-2 break-all text-sm text-stone-600">券商订单号：{brokerOrderId ?? '未生成'} · 策略信号 → 待确认订单 → 用户确认 → Futu REAL 订单 → 费用回填</p>
        </header>

        {error ? <div className="rounded-2xl border border-rose-300/40 bg-rose-500/15 px-4 py-3 text-sm text-rose-700">{error}</div> : null}
        {!pending && !submitted && !signal && !listedFutuOrder ? <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5 text-sm text-orange-800">未找到关联的系统订单；如果该订单由 Futu 客户端或其他系统创建，仍可查看下方券商真实订单。</div> : null}

        <section className="grid gap-4 md:grid-cols-2">
          <Step title="1. 策略信号" active={Boolean(signal)}>
            {signal ? (
              <>
                  <p>{signal.ticker} · <span className={sideTone(signal.side, signal.reason)}>{sideLabel(signal.side, signal.reason)}</span> · {displaySignalModel(signal.modelLabel, signal.model, 'zh')}</p>
                <p className="mt-2 text-stone-600">{signal.reason}</p>
              </>
            ) : '暂无信号数据'}
          </Step>
          <Step title="2. 待确认订单" active={Boolean(pending)}>
            {pending ? (
              <>
                  <p>{pending.id}</p>
                  <p className="mt-2 text-stone-600">
                    <span className={sideTone(pending.intent.side, pending.intent.reason || pending.signal.reason)}>{sideLabel(pending.intent.side, pending.intent.reason || pending.signal.reason)}</span>
                    {' · '}
                    {displayPendingOrderStatus(pending.status)} · {pending.intent.quantity} 股 · {displayOrderPriceWithType(`$${pending.intent.limitPrice.toFixed(2)}`, pending.intent.orderType, 'zh')}
                  </p>
              </>
            ) : '订单已不在当前待确认队列，可能已提交或被拒绝。'}
          </Step>
          <Step title="3. 用户确认" active={Boolean(pending?.confirmation)}>
            {pending?.confirmation ? `${pending.confirmation.confirmationId} · ${pending.confirmation.confirmedAt}` : '尚未确认或确认记录不在当前 dashboard。'}
          </Step>
          <Step title="4. Futu REAL 订单" active={Boolean(liveDetail || submitted || listedFutuOrder)}>
            {liveDetail ? (
              <>
                <p>{liveDetail.order.orderId} · {liveDetail.order.orderStatusLabel}</p>
                <p className="mt-2 text-stone-600">
                  成交 {liveDetail.order.filledQuantity}/{liveDetail.order.quantity} · {displayOrderPriceWithType(liveDetail.order.price, liveDetail.order.orderType, 'zh')}
                </p>
                <p className="mt-2 text-xs text-stone-500">更新：{formatDateTime(liveDetail.order.updatedTime)}</p>
              </>
            ) : submitted ? (
              <>
                <p>{submitted.orderId} · {submitted.ok ? '已提交' : '提交失败'}</p>
                <p className="mt-2 text-stone-600">{submitted.error ?? `${submitted.quantity} 股 · ${submitted.limitPrice}`}</p>
              </>
            ) : '尚未产生 REAL 订单。'}
          </Step>
          <Step title="5. 费用" active={Boolean(liveDetail?.order.feeContext || submitted?.feeContext || pending?.intent.feeContext)}>
            {liveDetail?.order.feeContext
              ? feeSummary(liveDetail.order.feeContext)
              : submitted?.feeContext
                ? feeSummary(submitted.feeContext)
                : pending?.intent.feeContext
                  ? feeSummary(pending.intent.feeContext)
                  : '暂无费用上下文'}
          </Step>
        </section>

        {loadingFutuOrderDetailId ? (
          <section className="rounded-2xl border border-orange-200 bg-white/90 p-6 text-sm text-stone-500">
            正在从 Futu OpenD 读取订单、成交和费用...
          </section>
        ) : null}
        {futuOrderDetailError ? (
          <section className="rounded-3xl border border-rose-300/40 bg-rose-500/10 p-6 text-sm text-rose-700">
            {futuOrderDetailError}
          </section>
        ) : null}
        {submitFailed && submitted ? (
          <OrderDetailPanel accent="amber" eyebrow="券商订单" title="订单提交失败">
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              <p className="font-semibold">订单提交失败，券商未生成可查询的真实订单。</p>
              <p className="mt-2 whitespace-pre-wrap">{submitted.error ?? 'Futu 未返回具体失败原因。'}</p>
            </div>
            <div className="mt-5">
              <OrderDetailFieldGrid accent="amber" columns="sm:grid-cols-2 lg:grid-cols-4">
                <OrderDetailField label="订单状态" value="提交失败" />
                <OrderDetailField label="标的" value={submitted.ticker || pending?.intent.ticker || '无'} />
                <OrderDetailField label="方向" value={sideLabel(submitted.side, pending?.intent.reason)} />
                <OrderDetailField label="订单类型" value={displayOrderType(submitted.orderType || pending?.intent.orderType || '', 'zh')} />
                <OrderDetailField label="委托数量" value={`${submitted.quantity || pending?.intent.quantity || 0} 股`} />
                <OrderDetailField label="委托价格" value={submitted.limitPrice || String(pending?.intent.limitPrice ?? '无')} />
                <OrderDetailField label="交易时段" value={displayOrderSession(submitted.orderSession || pending?.intent.orderSession, 'zh')} />
                <OrderDetailField label="失败时间" value={formatDateTime(submitted.submittedAt)} />
                <OrderDetailField label="确认编号" value={pending?.confirmation?.confirmationId ?? '无'} />
                <OrderDetailField label="信号编号" value={submitted.signalId} />
              </OrderDetailFieldGrid>
            </div>
          </OrderDetailPanel>
        ) : null}
        {liveDetail ? (
          <>
            <OrderDetailPanel
              accent="amber"
              eyebrow="券商订单"
              title="Futu 真实订单详情"
              action={(
              <button
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-orange-200 bg-white text-orange-700 transition hover:bg-orange-50"
                aria-label="刷新 Futu 订单详情"
                title="刷新 Futu 订单详情"
                onClick={() => void loadFutuOrderDetail({
                  orderId: liveDetail.order.orderId,
                  ticker: liveDetail.order.ticker,
                  submittedAt: brokerSubmittedAt,
                })}
              >
                <RefreshCw size={16} />
              </button>
              )}
            >
              <OrderDetailFieldGrid accent="amber" columns="sm:grid-cols-2 lg:grid-cols-4">
                <OrderDetailField label="券商状态" value={liveDetail.order.orderStatusLabel} />
                <OrderDetailField label="标的" value={liveDetail.order.ticker} />
                <OrderDetailField label="方向" value={displaySide(liveDetail.order.side, 'zh')} />
                <OrderDetailField label="订单类型" value={displayOrderType(liveDetail.order.orderType, 'zh')} />
                <OrderDetailField label="委托 / 成交" value={`${liveDetail.order.quantity} / ${liveDetail.order.filledQuantity}`} />
                <OrderDetailField label="委托价格" value={liveDetail.order.price} />
                <OrderDetailField label="成交均价" value={liveDetail.order.filledAveragePrice} />
                <OrderDetailField label="成交金额" value={liveDetail.order.dealtAmount} />
                <OrderDetailField label="剩余数量" value={`${liveDetail.order.remainingQuantity} 股`} />
                <OrderDetailField label="交易币种" value={liveDetail.order.currency} />
                <OrderDetailField label="创建时间" value={formatDateTime(liveDetail.order.createTime)} />
                <OrderDetailField label="更新时间" value={formatDateTime(liveDetail.order.updatedTime)} />
              </OrderDetailFieldGrid>

              {liveDetail.order.feeContext?.feeDetails.length ? (
                <div className="mt-5">
                  <OrderDetailFieldGrid accent="amber" columns="sm:grid-cols-2 lg:grid-cols-3">
                    {liveDetail.order.feeContext.feeDetails.map((fee) => (
                      <OrderDetailField key={fee.item} label={fee.item} value={`${liveDetail.order.feeContext?.currency ?? ''} ${fee.amount}`} />
                    ))}
                  </OrderDetailFieldGrid>
                </div>
              ) : null}
              {liveDetail.warnings.length ? (
                <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  {liveDetail.warnings.join('；')}
                </div>
              ) : null}
            </OrderDetailPanel>

            <OrderDetailTable
              accent="amber"
              title={`成交记录（${liveDetail.deals.length}）`}
              headers={['成交编号', '方向', '数量', '成交价格', '成交时间']}
              rows={liveDetail.deals.map((deal) => [
                deal.dealId,
                displaySide(deal.side, 'zh'),
                deal.quantity,
                deal.price,
                formatDateTime(deal.createdAt),
              ])}
              emptyText="当前订单暂无成交记录。"
              minWidth="min-w-[680px]"
            />
          </>
        ) : null}
        {managedEvents.length ? (
          <OrderDetailPanel accent="amber" eyebrow="系统监管" title={`挂单监管时间线（${managedEvents.length}）`}>
            <div className="mt-4 divide-y divide-stone-200">
              {managedEvents.map((event) => (
                <div key={event.id ?? `${event.eventType}-${event.createdAt}`} className="grid gap-2 py-3 text-sm sm:grid-cols-[180px_180px_1fr]">
                  <span className="text-stone-500">{formatDateTime(event.createdAt)}</span>
                  <span>{managedEventLabel(event.eventType)}</span>
                  <span className="break-words text-stone-600">{displayManagedOrderEventDetail(event.detail)}</span>
                </div>
              ))}
            </div>
          </OrderDetailPanel>
        ) : null}
      </div>
    </main>
  )
}

function feeSummary(fee: { source: string; feeAmount: number | null; currency: string; warning?: string }) {
  if (fee.feeAmount === null) return fee.warning ?? '真实费用尚未返回'
  return `${fee.currency} ${fee.feeAmount.toFixed(2)} · ${fee.source === 'actual_post_trade' ? '真实费用' : '预估费用'}`
}

function formatDateTime(value?: string) {
  if (!value || value === 'unavailable') return '暂无'
  const timestamp = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'))
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function managedEventLabel(value: string) {
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
  return labels[value] ?? value
}

function sideLabel(side: string, reason?: string) {
  if (side === 'BUY' && isShortCover(side, reason)) return '平仓买入'
  return displaySide(side, 'zh')
}

function sideTone(side: string, reason?: string) {
  if (side === 'SELL_TO_CLOSE' || isShortCover(side, reason)) return 'text-emerald-600'
  if (side === 'BUY' || side === 'SELL_SHORT') return 'text-red-600'
  return 'text-stone-600'
}

function isShortCover(side: string, reason?: string) {
  return side === 'BUY' && /回补|平仓|空头|short/i.test(reason ?? '')
}

function Step({ title, active, children }: { title: string; active: boolean; children: ReactNode }) {
  return (
    <OrderDetailPanel
      accent="amber"
      title={title}
      action={<Badge tone={active ? 'emerald' : 'slate'}>{active ? '已关联' : '待补齐'}</Badge>}
    >
      <div className="text-sm text-stone-600">{children}</div>
    </OrderDetailPanel>
  )
}
