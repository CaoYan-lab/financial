import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Eye, X, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ManagedOrder, ManagedOrderListResponse } from '../../shared/managedOrderTypes'
import { displaySide } from '@/utils/simulationDisplay'

export default function ManagedOrdersPanel({
  platformLabel,
  data,
  autoCancelEnabled,
  saving,
  cancelingOrderId,
  detailBasePath,
  accent = 'sky',
  onToggleAutoCancel,
  onCancel,
}: {
  platformLabel: string
  data?: ManagedOrderListResponse
  autoCancelEnabled: boolean
  saving: boolean
  cancelingOrderId?: string
  detailBasePath: string
  accent?: 'amber' | 'sky'
  onToggleAutoCancel: (enabled: boolean) => Promise<unknown>
  onCancel: (orderId: string) => Promise<unknown>
}) {
  const [confirming, setConfirming] = useState<ManagedOrder>()
  const activeOrders = data?.orders.filter((order) => !order.terminalAt) ?? []
  const theme = accent === 'amber'
    ? {
        border: 'border-orange-200',
        eyebrow: 'text-orange-700',
        primary: 'bg-orange-600 hover:bg-orange-500',
        icon: 'text-orange-600',
        action: 'border-orange-200 text-orange-700 hover:bg-orange-50',
      }
    : {
        border: 'border-sky-200',
        eyebrow: 'text-sky-700',
        primary: 'bg-sky-600 hover:bg-sky-500',
        icon: 'text-sky-600',
        action: 'border-sky-200 text-sky-700 hover:bg-sky-50',
      }
  return (
    <section className={`rounded-3xl border bg-white/90 p-6 backdrop-blur ${theme.border}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={`text-xs font-semibold tracking-[0.25em] ${theme.eyebrow}`}>系统挂单监管</p>
          <h2 className="mt-2 text-xl font-semibold">{platformLabel} 挂单与自动撤单</h2>
          <p className="mt-2 text-sm text-stone-600">
            仅监管本系统提交的订单；模型只提供建议，后端复核券商状态后才能撤销剩余数量。
          </p>
        </div>
        <button
          className={`rounded-2xl px-5 py-3 text-sm font-bold text-white transition disabled:opacity-50 ${autoCancelEnabled ? 'bg-rose-600 hover:bg-rose-500' : theme.primary}`}
          disabled={saving}
          onClick={() => void onToggleAutoCancel(!autoCancelEnabled)}
        >
          {saving ? '保存中...' : autoCancelEnabled ? '关闭自动撤单' : '开启自动撤单'}
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <StatusItem ok={data?.supervisor?.running === true} text={data?.supervisor?.running ? '监管器运行中' : '监管器未运行'} iconClassName={theme.icon} />
        <StatusItem ok={!autoCancelEnabled} text={autoCancelEnabled ? '高置信度建议与硬规则可自动撤单' : '影子模式，仅记录建议'} iconClassName={theme.icon} />
        <StatusItem ok text={`非终态订单 ${activeOrders.length} 笔`} iconClassName={theme.icon} />
      </div>

      <div className="mt-5 overflow-x-auto rounded-2xl border border-stone-200">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-stone-50 text-xs text-stone-500">
            <tr>
              <th className="px-4 py-3">标的 / 方向</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">委托 / 成交 / 剩余</th>
              <th className="px-4 py-3">委托价 / 成交均价</th>
              <th className="px-4 py-3">挂单时长</th>
              <th className="px-4 py-3">最近决策</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-200">
            {activeOrders.map((order) => (
              <tr key={`${order.platform}:${order.orderId}`}>
                <td className="px-4 py-3">
                  <strong>{order.ticker} · {displaySide(order.side, 'zh')}</strong>
                  <span className="mt-1 block text-xs text-stone-500">{order.orderId}</span>
                </td>
                <td className="px-4 py-3">{managedStatusLabel(order.status)}</td>
                <td className="px-4 py-3">{order.submittedQuantity} / {order.executedQuantity} / {order.remainingQuantity}</td>
                <td className="px-4 py-3">{money(order.submittedPrice)} / {money(order.executedPrice)}</td>
                <td className="px-4 py-3">{ageLabel(order.submittedAt)}</td>
                <td className="max-w-[260px] px-4 py-3">
                  <span>{order.latestDecision ? `${decisionLabel(order.latestDecision.action)} · ${confidenceLabel(order.latestDecision.confidence)}` : '等待复核'}</span>
                  {order.latestDecision?.reason ? <span className="mt-1 block truncate text-xs text-stone-500" title={order.latestDecision.reason}>{order.latestDecision.reason}</span> : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Link
                      className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border bg-white transition ${theme.action}`}
                      aria-label={`查看 ${order.ticker} 组合订单详情`}
                      title="查看券商订单详情"
                      to={`${detailBasePath}/${encodeURIComponent(order.orderId)}?ticker=${encodeURIComponent(order.ticker)}&pendingOrderId=${encodeURIComponent(order.pendingOrderId)}&submittedAt=${encodeURIComponent(order.submittedAt)}`}
                    >
                      <Eye size={15} />
                    </Link>
                    <button
                      className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!order.canCancel || Boolean(order.cancelRequestId) || cancelingOrderId === order.orderId}
                      onClick={() => setConfirming(order)}
                    >
                      <XCircle size={14} />
                      {cancelingOrderId === order.orderId ? '撤单中...' : order.status === 'PARTIALLY_FILLED' ? '撤销剩余' : '撤单'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!activeOrders.length ? <p className="p-5 text-sm text-stone-500">当前没有本系统创建的非终态挂单。</p> : null}
      </div>

      {data?.events.length ? (
        <details className="mt-4 rounded-2xl border border-stone-200 bg-stone-50/70 p-4">
          <summary className="cursor-pointer text-sm font-semibold">最近监管记录</summary>
          <div className="mt-3 divide-y divide-stone-200">
            {data.events.slice(0, 10).map((event) => (
              <div key={event.id ?? `${event.orderId}-${event.createdAt}`} className="grid gap-1 py-3 text-xs sm:grid-cols-[170px_180px_1fr]">
                <span className="text-stone-500">{formatTime(event.createdAt)}</span>
                <span>{event.orderId}</span>
                <span>{eventLabel(event.eventType)}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {confirming ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-3xl border border-rose-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-rose-700">确认真实撤单</p>
                <h3 className="mt-2 text-lg font-semibold">{confirming.ticker} · {confirming.orderId}</h3>
              </div>
              <button className="grid h-9 w-9 place-items-center rounded-xl border border-stone-200" title="关闭" onClick={() => setConfirming(undefined)}>
                <X size={16} />
              </button>
            </div>
            <p className="mt-4 text-sm leading-6 text-stone-700">
              将向券商撤销尚未成交的 {confirming.remainingQuantity} 股。已经成交的 {confirming.executedQuantity} 股不会被撤回。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-xl border border-stone-200 px-4 py-2 text-sm font-semibold" onClick={() => setConfirming(undefined)}>取消</button>
              <button
                className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-500"
                onClick={async () => {
                  const target = confirming
                  setConfirming(undefined)
                  await onCancel(target.orderId)
                }}
              >
                确认撤销剩余数量
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function StatusItem({ ok, text, iconClassName }: { ok: boolean; text: string; iconClassName: string }) {
  const Icon = ok ? CheckCircle2 : AlertTriangle
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
      <Icon className={ok ? iconClassName : 'text-amber-600'} size={16} />
      {text}
    </div>
  )
}

function managedStatusLabel(status: ManagedOrder['status']) {
  const labels: Record<ManagedOrder['status'], string> = {
    TRACKING: '挂单中',
    PARTIALLY_FILLED: '部分成交',
    CANCEL_RECOMMENDED: '建议撤单',
    CANCEL_REQUESTED: '撤单已请求',
    CANCEL_PENDING: '撤单处理中',
    FILLED: '全部成交',
    CANCELED: '已撤单',
    PARTIALLY_CANCELED: '部分成交后撤单',
    REJECTED: '已拒绝',
    EXPIRED: '已过期',
    UNKNOWN: '状态待确认',
  }
  return labels[status]
}

function decisionLabel(action: 'KEEP' | 'CANCEL') {
  return action === 'CANCEL' ? '建议撤单' : '继续等待'
}

function confidenceLabel(value: string) {
  if (value === 'high') return '高置信度'
  if (value === 'medium') return '中置信度'
  return '低置信度'
}

function money(value: number | null) {
  return value === null ? '无' : `$${value.toFixed(2)}`
}

function ageLabel(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  return `${Math.floor(seconds / 3600)} 小时`
}

function formatTime(value: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : value
}

function eventLabel(value: string) {
  const labels: Record<string, string> = {
    registered: '订单已纳入系统监管',
    reconciled: '券商状态已同步',
    sync_failed: '券商状态同步失败',
    rule_triggered: '硬规则建议撤单',
    model_decided: '模型完成挂单复核',
    cancel_requested: '已生成撤单请求',
    cancel_accepted: '券商已受理撤单',
    cancel_rejected: '券商未受理撤单',
    cancel_terminal: '撤单终态已确认',
    cancel_uncertain: '撤单结果待确认',
  }
  return labels[value] ?? value
}
