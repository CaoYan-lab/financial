import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import AppNav from '@/components/common/AppNav'
import Badge from '@/components/common/Badge'
import { useUiStore } from '@/stores/uiStore'
import { displayOrderPriceWithType, displayOrderSession, displaySide, displaySignalModel } from '@/utils/simulationDisplay'
import type { FutuSimulationOrder, QuantSignal, SimulatedOrderResult, SimulationLinkedOrderDetailResponse } from '../../shared/types'

type DetailRouteState = {
  ticker?: string
  startDate?: string
  endDate?: string
}

export default function SimulationOrderDetailView() {
  const language = useUiStore((state) => state.language)
  const params = useParams()
  const location = useLocation()
  const state = (location.state ?? {}) as DetailRouteState
  const [detail, setDetail] = useState<SimulationLinkedOrderDetailResponse>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const endpoint = useMemo(() => {
    if (params.historyId) return `/api/simulation/history/orders/${encodeURIComponent(params.historyId)}/detail`
    if (params.orderId) {
      const search = new URLSearchParams()
      if (state.ticker) search.set('ticker', state.ticker)
      if (state.startDate) search.set('startDate', state.startDate)
      if (state.endDate) search.set('endDate', state.endDate)
      const query = search.toString()
      return `/api/simulation/futu-orders/${encodeURIComponent(params.orderId)}/detail${query ? `?${query}` : ''}`
    }
    return ''
  }, [params.historyId, params.orderId, state.endDate, state.startDate, state.ticker])

  useEffect(() => {
    if (!endpoint) return
    setLoading(true)
    fetch(endpoint)
      .then((response) => {
        if (!response.ok) throw new Error(`Detail request failed with HTTP ${response.status}.`)
        return response.json() as Promise<SimulationLinkedOrderDetailResponse>
      })
      .then((payload) => {
        setDetail(payload)
        setError(undefined)
      })
      .catch((requestError) => {
        setError(requestError instanceof Error ? requestError.message : 'Unable to load simulation order detail.')
      })
      .finally(() => setLoading(false))
  }, [endpoint])

  const title = language === 'zh' ? '模拟订单联动详情' : 'Linked Simulation Order Detail'
  const summaryOrder = detail?.historyOrder
  const summaryFutuOrder = detail?.futuOrder
  const ticker = summaryOrder?.ticker ?? summaryFutuOrder?.ticker ?? 'unavailable'
  const side = summaryOrder?.side ?? summaryFutuOrder?.side ?? 'unavailable'

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <section className="rounded-[2rem] border border-amber-100 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap gap-2">
                <Badge tone="violet">SIMULATE</Badge>
                <Badge tone="cyan">{detail?.source === 'futu-order' ? 'Futu Order' : 'History Order'}</Badge>
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-stone-950">{title}</h1>
              <p className="mt-3 text-sm text-stone-600">
                {language === 'zh'
                  ? '本页只通过订单列表行点击进入，集中展示历史模拟订单、历史策略信号与 Futu 订单状态的关联关系。'
                  : 'This page is opened only from order table rows and links the paper order, signal and Futu order status.'}
              </p>
            </div>
            <Link className="rounded-2xl border border-amber-200 bg-white px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50" to="/simulation">
              {language === 'zh' ? '返回模拟盘' : 'Back to Simulation'}
            </Link>
          </div>
        </section>

        {loading ? <StatusMessage text={language === 'zh' ? '加载详情中...' : 'Loading detail...'} /> : null}
        {error ? <StatusMessage tone="red" text={error} /> : null}
        {detail?.warnings.length ? <WarningPanel warnings={detail.warnings} /> : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label={language === 'zh' ? '标的' : 'Ticker'} value={ticker} />
          <SummaryCard label={language === 'zh' ? '方向' : 'Side'} value={displaySide(side, language)} />
          <SummaryCard label={language === 'zh' ? '数量' : 'Quantity'} value={summaryOrder?.quantity ?? summaryFutuOrder?.quantity ?? 'unavailable'} />
          <SummaryCard label={language === 'zh' ? 'Futu Order ID' : 'Futu Order ID'} value={summaryOrder?.orderId ?? summaryFutuOrder?.orderId ?? 'unavailable'} />
        </section>

        <div className="grid gap-6 xl:grid-cols-3">
          <HistoryOrderPanel order={detail?.historyOrder} language={language} />
          <SignalPanel signal={detail?.signal} language={language} />
          <FutuOrderPanel order={detail?.futuOrder} language={language} />
        </div>
      </div>
    </main>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.2em] text-stone-500">{label}</p>
      <p className="mt-2 break-words font-mono text-lg font-semibold text-stone-950">{value}</p>
    </div>
  )
}

function StatusMessage({ text, tone = 'slate' }: { text: string; tone?: 'slate' | 'red' }) {
  const className = tone === 'red' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-stone-200 bg-white/90 text-stone-600'
  return <p className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${className}`}>{text}</p>
}

function WarningPanel({ warnings }: { warnings: string[] }) {
  return (
    <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
      <p className="font-semibold">关联提示</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  )
}

function HistoryOrderPanel({ order, language }: { order?: SimulatedOrderResult; language: 'zh' | 'en' }) {
  return (
    <DetailPanel title={language === 'zh' ? '历史模拟订单（大模型决策）' : 'Paper Order History'}>
      {order ? (
        <>
          <Field label="History ID" value={String(order.historyId ?? 'unavailable')} />
          <Field label="Order ID" value={order.orderId} />
          <Field label="Signal ID" value={order.signalId} />
          <Field label={language === 'zh' ? '方向' : 'Side'} value={displaySide(order.side, language)} />
          <Field label={language === 'zh' ? '数量' : 'Quantity'} value={order.quantity} />
          <Field label={language === 'zh' ? '交易时段' : 'Session'} value={displayOrderSession(order.orderSession, language)} />
          <Field label={language === 'zh' ? '委托价' : 'Order Price'} value={displayOrderPriceWithType(order.limitPrice, order.orderType, language)} />
          <Field label={language === 'zh' ? '提交时间' : 'Submitted'} value={order.submittedAt} />
          <Field label={language === 'zh' ? '状态' : 'Status'} value={order.ok ? 'OK' : order.error ?? 'Error'} />
          <Field label={language === 'zh' ? '模型确认' : 'LLM Review'} value={order.llmDecision ? (order.llmDecision.approved ? 'Approved' : 'Blocked') : 'unavailable'} />
          <Field label={language === 'zh' ? '模型理由' : 'Reason'} value={order.llmDecision?.reason ?? 'unavailable'} />
          <Field label={language === 'zh' ? '风险提示' : 'Risk'} value={order.llmDecision?.riskAssessment ?? 'unavailable'} />
          <JsonDetails title="Raw Response" value={order.rawResponse} />
        </>
      ) : (
        <EmptyDetail text={language === 'zh' ? '未找到关联历史模拟订单。' : 'No linked paper order found.'} />
      )}
    </DetailPanel>
  )
}

function SignalPanel({ signal, language }: { signal?: QuantSignal; language: 'zh' | 'en' }) {
  return (
    <DetailPanel title={language === 'zh' ? '历史策略信号' : 'Signal History'}>
      {signal ? (
        <>
          <Field label="History ID" value={String(signal.historyId ?? 'unavailable')} />
          <Field label="Signal ID" value={signal.id} />
          <Field label={language === 'zh' ? '标的' : 'Ticker'} value={signal.ticker} />
          <Field label={language === 'zh' ? '模型' : 'Model'} value={displaySignalModel(signal.modelLabel, signal.model, language)} />
          <Field label={language === 'zh' ? '动作' : 'Action'} value={displaySide(signal.side, language)} />
          <Field label={language === 'zh' ? '置信度' : 'Confidence'} value={signal.confidence} />
          <Field label={language === 'zh' ? '数量' : 'Quantity'} value={signal.quantity} />
          <Field label={language === 'zh' ? '限价' : 'Limit'} value={signal.limitPrice} />
          <Field label={language === 'zh' ? '生成时间' : 'Generated'} value={signal.generatedAt} />
          <Field label={language === 'zh' ? '模型理由' : 'Reason'} value={signal.reason} />
          <Field label={language === 'zh' ? '风险提示' : 'Risk'} value={signal.riskAssessment} />
          <Field label={language === 'zh' ? '数据窗口' : 'Data Window'} value={signal.dataWindow} />
          <Field label={language === 'zh' ? '趋势方向' : 'Trend Direction'} value={signal.trendContext?.trendDirection ?? 'unavailable'} />
          <Field label={language === 'zh' ? '趋势强度' : 'Trend Strength'} value={signal.trendContext?.trendStrength ?? 'unavailable'} />
          <Field label={language === 'zh' ? '趋势一致性' : 'Trend Alignment'} value={signal.trendAlignment ?? 'unavailable'} />
          <Field label={language === 'zh' ? '交易周期' : 'Trade Horizon'} value={signal.tradeHorizon ?? 'unavailable'} />
          <Field label={language === 'zh' ? '非噪声依据' : 'Why Not Noise'} value={signal.whyNotNoise ?? 'unavailable'} />
          <Field label={language === 'zh' ? '趋势摘要' : 'Trend Summary'} value={signal.trendContext?.summary ?? 'unavailable'} />
          <JsonDetails title="Raw Model Output" value={signal.rawModelOutput} />
        </>
      ) : (
        <EmptyDetail text={language === 'zh' ? '未找到关联历史策略信号。' : 'No linked signal found.'} />
      )}
    </DetailPanel>
  )
}

function FutuOrderPanel({ order, language }: { order?: FutuSimulationOrder; language: 'zh' | 'en' }) {
  return (
    <DetailPanel title={language === 'zh' ? 'Futu 订单状态' : 'Futu Order Status'}>
      {order ? (
        <>
          <Field label="Order ID" value={order.orderId} />
          <Field label={language === 'zh' ? '标的' : 'Ticker'} value={`${order.ticker} / ${order.code}`} />
          <Field label={language === 'zh' ? '方向' : 'Side'} value={displaySide(order.side, language)} />
          <Field label={language === 'zh' ? '状态' : 'Status'} value={order.orderStatusLabel || order.orderStatus} />
          <Field label={language === 'zh' ? '数量' : 'Quantity'} value={order.quantity} />
          <Field label={language === 'zh' ? '已成交' : 'Filled'} value={order.filledQuantity} />
          <Field label={language === 'zh' ? '剩余' : 'Remaining'} value={order.remainingQuantity} />
          <Field label={language === 'zh' ? '委托价' : 'Order Price'} value={displayOrderPriceWithType(order.price, order.orderType, language)} />
          <Field label={language === 'zh' ? '成交均价' : 'Avg Fill'} value={order.filledAveragePrice} />
          <Field label={language === 'zh' ? '成交金额' : 'Dealt Amount'} value={order.dealtAmount} />
          <Field label={language === 'zh' ? '创建时间' : 'Created'} value={order.createTime} />
          <Field label={language === 'zh' ? '更新时间' : 'Updated'} value={order.updatedTime} />
          <Field label={language === 'zh' ? '备注' : 'Remark'} value={order.remark || 'unavailable'} />
          <JsonDetails title="Raw Response" value={order.rawResponse} />
        </>
      ) : (
        <EmptyDetail text={language === 'zh' ? '未找到关联 Futu 订单状态。' : 'No linked Futu order status found.'} />
      )}
    </DetailPanel>
  )
}

function DetailPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm">
      <h2 className="text-2xl font-semibold text-stone-950">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-100 bg-stone-50 px-4 py-3">
      <p className="text-xs font-semibold text-stone-500">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold leading-6 text-stone-800">{value}</p>
    </div>
  )
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  if (!value) return null
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <details className="rounded-2xl border border-stone-100 bg-stone-50 px-4 py-3">
      <summary className="cursor-pointer text-xs font-semibold text-stone-500">{title}</summary>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-stone-700">{content}</pre>
    </details>
  )
}

function EmptyDetail({ text }: { text: string }) {
  return <p className="rounded-2xl border border-stone-100 bg-stone-50 px-4 py-5 text-sm text-stone-500">{text}</p>
}
