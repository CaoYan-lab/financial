import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import Badge from '@/components/common/Badge'
import { useLiveTrading } from '@/hooks/useLiveTrading'
import { displayOrderPriceWithType, displaySignalModel, displaySide } from '@/utils/simulationDisplay'

export default function LiveOrderDetailView() {
  const { orderId = '' } = useParams()
  const { data, error } = useLiveTrading()
  const pending = data?.pendingOrders.find((order) => order.id === orderId || order.signal.id === orderId)
  const submitted = data?.submittedOrders.find((order) => order.pendingOrderId === orderId || order.orderId === orderId || order.signalId === orderId)
  const signal = pending?.signal ?? data?.latestSignals.find((item) => item.id === submitted?.signalId)

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <Link className="text-sm font-semibold text-amber-700 hover:text-amber-800" to="/live-trading">返回实盘量化</Link>
        <header className="rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur">
          <p className="text-xs font-semibold tracking-[0.25em] text-rose-700">LIVE ORDER DETAIL</p>
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
                    {pending.status} · {pending.intent.quantity} 股 · {displayOrderPriceWithType(`$${pending.intent.limitPrice.toFixed(2)}`, pending.intent.orderType, 'zh')}
                  </p>
              </>
            ) : '订单已不在当前待确认队列，可能已提交或被拒绝。'}
          </Step>
          <Step title="3. 用户确认" active={Boolean(pending?.confirmation)}>
            {pending?.confirmation ? `${pending.confirmation.confirmationId} · ${pending.confirmation.confirmedAt}` : '尚未确认或确认记录不在当前 dashboard。'}
          </Step>
          <Step title="4. Futu REAL 订单" active={Boolean(submitted)}>
            {submitted ? (
              <>
                <p>{submitted.orderId} · {submitted.ok ? '已提交' : '提交失败'}</p>
                <p className="mt-2 text-stone-600">{submitted.error ?? `${submitted.quantity} 股 · ${submitted.limitPrice}`}</p>
              </>
            ) : '尚未产生 REAL 订单。'}
          </Step>
          <Step title="5. 费用" active={Boolean(submitted?.feeContext || pending?.intent.feeContext)}>
            {submitted?.feeContext ? `${submitted.feeContext.source} · ${submitted.feeContext.feeAmount ?? 'unavailable'}` : pending?.intent.feeContext ? `${pending.intent.feeContext.source} · ${pending.intent.feeContext.feeAmount ?? 'unavailable'}` : '暂无费用上下文'}
          </Step>
        </section>
      </div>
    </main>
  )
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
