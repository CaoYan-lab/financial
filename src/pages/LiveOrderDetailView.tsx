import { useEffect, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import Badge from '@/components/common/Badge'
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
    ?? (/^\d+$/.test(orderId) ? orderId : undefined)
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
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <Link className="text-sm font-semibold text-amber-700 hover:text-amber-800" to="/live-trading">返回实盘量化</Link>
        <header className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
          <p className="text-xs font-semibold tracking-[0.25em] text-rose-700">实盘交易</p>
          <h1 className="mt-2 text-3xl font-semibold">实盘订单详情链路</h1>
          <p className="mt-2 text-sm text-stone-600">策略信号 → 待确认订单 → 用户确认 → Futu REAL 订单状态 → 费用回填。</p>
        </header>

        {error ? <div className="rounded-2xl border border-rose-300/40 bg-rose-500/15 px-4 py-3 text-sm text-rose-700">{error}</div> : null}
        {!pending && !submitted && !signal ? <div className="rounded-3xl border border-amber-300/30 bg-amber-500/10 p-6 text-amber-800">未在当前实盘 dashboard 中找到该订单链路，请刷新或从待确认队列进入。</div> : null}

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
          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 text-sm text-stone-500">
            正在从 Futu OpenD 读取订单、成交和费用...
          </section>
        ) : null}
        {futuOrderDetailError ? (
          <section className="rounded-3xl border border-rose-300/40 bg-rose-500/10 p-6 text-sm text-rose-700">
            {futuOrderDetailError}
          </section>
        ) : null}
        {submitFailed && submitted ? (
          <section className="rounded-3xl border border-rose-200 bg-white/90 p-6">
            <div className="border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              <p className="font-semibold">订单提交失败，券商未生成可查询的真实订单。</p>
              <p className="mt-2 whitespace-pre-wrap">{submitted.error ?? 'Futu 未返回具体失败原因。'}</p>
            </div>
            <div className="mt-5 grid overflow-hidden rounded-2xl border border-stone-200 sm:grid-cols-2 lg:grid-cols-4">
              <DetailField label="订单状态" value="提交失败" />
              <DetailField label="标的" value={submitted.ticker || pending?.intent.ticker || '无'} />
              <DetailField label="方向" value={sideLabel(submitted.side, pending?.intent.reason)} />
              <DetailField label="订单类型" value={displayOrderType(submitted.orderType || pending?.intent.orderType || '', 'zh')} />
              <DetailField label="委托数量" value={`${submitted.quantity || pending?.intent.quantity || 0} 股`} />
              <DetailField label="委托价格" value={submitted.limitPrice || String(pending?.intent.limitPrice ?? '无')} />
              <DetailField label="交易时段" value={displayOrderSession(submitted.orderSession || pending?.intent.orderSession, 'zh')} />
              <DetailField label="失败时间" value={formatDateTime(submitted.submittedAt)} />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <DetailField label="确认编号" value={pending?.confirmation?.confirmationId ?? '无'} />
              <DetailField label="信号编号" value={submitted.signalId} />
            </div>
          </section>
        ) : null}
        {liveDetail ? (
          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">Futu 实盘成交</p>
                <h2 className="mt-2 text-2xl font-semibold">成交与费用明细</h2>
              </div>
              <button
                className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-bold text-stone-700 hover:bg-stone-50"
                onClick={() => void loadFutuOrderDetail({
                  orderId: liveDetail.order.orderId,
                  ticker: liveDetail.order.ticker,
                  submittedAt: brokerSubmittedAt,
                })}
              >
                刷新详情
              </button>
            </div>

            <div className="mt-5 grid overflow-hidden rounded-2xl border border-stone-200 sm:grid-cols-2 lg:grid-cols-4">
              <DetailField label="方向" value={displaySide(liveDetail.order.side, 'zh')} />
              <DetailField label="订单类型" value={displayOrderType(liveDetail.order.orderType, 'zh')} />
              <DetailField label="成交均价" value={liveDetail.order.filledAveragePrice} />
              <DetailField label="成交金额" value={liveDetail.order.dealtAmount} />
              <DetailField label="剩余数量" value={`${liveDetail.order.remainingQuantity} 股`} />
              <DetailField label="交易币种" value={liveDetail.order.currency} />
              <DetailField label="创建时间" value={formatDateTime(liveDetail.order.createTime)} />
              <DetailField label="更新时间" value={formatDateTime(liveDetail.order.updatedTime)} />
            </div>

            <div className="mt-6 overflow-x-auto rounded-2xl border border-stone-200">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-stone-50 text-xs text-stone-500">
                  <tr>
                    <th className="px-4 py-3">成交编号</th>
                    <th className="px-4 py-3">方向</th>
                    <th className="px-4 py-3">数量</th>
                    <th className="px-4 py-3">成交价格</th>
                    <th className="px-4 py-3">成交时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {liveDetail.deals.map((deal) => (
                    <tr key={deal.dealId}>
                      <td className="px-4 py-3">{deal.dealId}</td>
                      <td className="px-4 py-3">{displaySide(deal.side, 'zh')}</td>
                      <td className="px-4 py-3">{deal.quantity}</td>
                      <td className="px-4 py-3">{deal.price}</td>
                      <td className="px-4 py-3">{formatDateTime(deal.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!liveDetail.deals.length ? <p className="p-4 text-sm text-stone-500">当前订单暂无成交记录。</p> : null}
            </div>

            {liveDetail.order.feeContext?.feeDetails.length ? (
              <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {liveDetail.order.feeContext.feeDetails.map((fee) => (
                  <DetailField key={fee.item} label={fee.item} value={`${liveDetail.order.feeContext?.currency ?? ''} ${fee.amount}`} />
                ))}
              </div>
            ) : null}
            {liveDetail.warnings.length ? (
              <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                {liveDetail.warnings.join('；')}
              </div>
            ) : null}
          </section>
        ) : null}
        {managedEvents.length ? (
          <section className="rounded-3xl border border-stone-200 bg-white/90 p-6">
            <h2 className="text-xl font-semibold">挂单监管时间线</h2>
            <div className="mt-4 divide-y divide-stone-200">
              {managedEvents.map((event) => (
                <div key={event.id ?? `${event.eventType}-${event.createdAt}`} className="grid gap-2 py-3 text-sm sm:grid-cols-[180px_180px_1fr]">
                  <span className="text-stone-500">{formatDateTime(event.createdAt)}</span>
                  <span>{managedEventLabel(event.eventType)}</span>
                  <span className="break-words text-stone-600">{displayManagedOrderEventDetail(event.detail)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-r border-stone-200 p-4">
      <p className="text-xs font-semibold text-stone-500">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-stone-950">{value || '无'}</p>
    </div>
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
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        <Badge tone={active ? 'emerald' : 'slate'}>{active ? '已关联' : '待补齐'}</Badge>
      </div>
      <div className="mt-4 text-sm text-stone-600">{children}</div>
    </section>
  )
}
