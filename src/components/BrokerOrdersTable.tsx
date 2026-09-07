import { Eye, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'

export type BrokerOrderRow = {
  orderId: string
  ticker: string
  name?: string
  status: string
  side: string
  orderType: string
  quantity: string
  filledQuantity: string
  price: string
  filledPrice: string
  session: string
  updatedAt: string
  detailHref: string
}

type FilterItem = { value: string; label: string }

export default function BrokerOrdersTable({
  platform,
  rows,
  page,
  totalPages,
  total,
  loading,
  compact = false,
  accent = 'sky',
  filters,
  onRefresh,
  onPageChange,
}: {
  platform: string
  rows: BrokerOrderRow[]
  page: number
  totalPages: number
  total: number
  loading?: boolean
  compact?: boolean
  accent?: 'sky' | 'amber'
  filters?: {
    ticker: string
    status: string
    side: string
    tickerItems: FilterItem[]
    statusItems: FilterItem[]
    sideItems: FilterItem[]
    onChange: (patch: { ticker?: string; status?: string; side?: string }) => void
  }
  onRefresh: () => void
  onPageChange: (page: number) => void
}) {
  const theme = accent === 'amber'
    ? {
        eyebrow: 'text-orange-700',
        action: 'border-orange-200 text-orange-700 hover:bg-orange-50',
        empty: 'border-orange-200 bg-orange-50 text-orange-800',
        active: 'bg-orange-400 text-stone-950 shadow-orange-500/20',
      }
    : {
        eyebrow: 'text-sky-700',
        action: 'border-sky-200 text-sky-700 hover:bg-sky-50',
        empty: 'border-sky-200 bg-sky-50 text-sky-800',
        active: 'bg-sky-400 text-stone-950 shadow-sky-500/20',
      }
  return (
    <section className={compact ? 'min-w-0 rounded-3xl border border-stone-200 bg-white/90 p-6 backdrop-blur' : 'border-y border-stone-200 bg-white/90 py-5'}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={`text-xs font-semibold tracking-[0.25em] ${theme.eyebrow}`}>券商订单</p>
          <h2 className="mt-2 text-2xl font-semibold">{platform} 券商订单清单（{total}）</h2>
          <p className="mt-2 text-sm text-stone-600">直接读取券商账户订单，不受待确认订单生命周期限制。</p>
        </div>
        <button
          className="inline-flex h-9 w-9 items-center justify-center border border-stone-200 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          disabled={loading}
          title="刷新券商订单清单"
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? 'animate-spin' : ''} size={16} />
        </button>
      </div>

      {filters ? <BrokerOrderFilters filters={filters} activeClassName={theme.active} /> : null}

      {compact ? (
        <div className="mt-5 space-y-3">
          {rows.map((order) => (
            <article key={order.orderId} className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <strong className="text-base text-stone-950">{order.ticker} · {order.side}</strong>
                  <span className="mt-1 block truncate text-xs text-stone-500" title={order.name}>{order.name || order.orderId}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-xl bg-stone-100 px-3 py-2 text-xs font-bold text-stone-700">{order.status}</span>
                  <Link
                    className={`inline-flex h-9 w-9 items-center justify-center border bg-white ${theme.action}`}
                    aria-label={`查看 ${order.ticker} 组合订单详情`}
                    title="查看组合订单详情"
                    to={order.detailHref}
                  >
                    <Eye size={15} />
                  </Link>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-stone-200 pt-3 text-xs">
                <CompactValue label="类型 / 时段" value={`${order.orderType} · ${order.session}`} />
                <CompactValue label="委托 / 成交" value={`${order.quantity} / ${order.filledQuantity}`} />
                <CompactValue label="委托价 / 成交均价" value={`${order.price} / ${order.filledPrice}`} />
                <CompactValue label="更新时间" value={formatDateTime(order.updatedAt)} />
              </div>
            </article>
          ))}
          {!rows.length ? <p className={`rounded-2xl border p-5 text-sm ${theme.empty}`}>当前筛选条件下没有券商订单。</p> : null}
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto border border-stone-200">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-stone-50 text-xs text-stone-500">
              <tr>
                <th className="px-4 py-3">标的</th>
                <th className="px-4 py-3">方向 / 类型</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">委托 / 成交</th>
                <th className="px-4 py-3">委托价 / 成交均价</th>
                <th className="px-4 py-3">交易时段</th>
                <th className="px-4 py-3">更新时间</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200">
              {rows.map((order) => (
                <tr key={order.orderId} className="hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <strong>{order.ticker}</strong>
                    <span className="mt-1 block max-w-40 truncate text-xs text-stone-500" title={order.name}>{order.name || order.orderId}</span>
                  </td>
                  <td className="px-4 py-3">{order.side}<span className="mt-1 block text-xs text-stone-500">{order.orderType}</span></td>
                  <td className="px-4 py-3 font-semibold">{order.status}</td>
                  <td className="px-4 py-3">{order.quantity} / {order.filledQuantity}</td>
                  <td className="px-4 py-3">{order.price} / {order.filledPrice}</td>
                  <td className="px-4 py-3">{order.session}</td>
                  <td className="px-4 py-3">{formatDateTime(order.updatedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      className="inline-flex h-9 w-9 items-center justify-center border border-amber-200 bg-white text-amber-800 hover:bg-amber-50"
                      aria-label={`查看 ${order.ticker} 订单详情`}
                      title="查看订单详情"
                      to={order.detailHref}
                    >
                      <Eye size={15} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <p className="p-5 text-sm text-stone-500">当前日期范围内没有券商订单。</p> : null}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 text-sm text-stone-600">
        <span>共 {total} 条，第 {page}/{totalPages} 页</span>
        <div className="flex gap-2">
          <button className="border border-stone-200 bg-white px-3 py-2 font-semibold disabled:opacity-40" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
          <button className="border border-stone-200 bg-white px-3 py-2 font-semibold disabled:opacity-40" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
        </div>
      </div>
    </section>
  )
}

function BrokerOrderFilters({
  filters,
  activeClassName,
}: {
  filters: NonNullable<Parameters<typeof BrokerOrdersTable>[0]['filters']>
  activeClassName: string
}) {
  return (
    <div className="mt-5 space-y-3">
      <label className="flex items-center gap-2 text-xs font-semibold text-stone-500">
        <span className="w-16 shrink-0">标的</span>
        <select
          className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2 font-bold text-stone-950"
          value={filters.ticker}
          onChange={(event) => filters.onChange({ ticker: event.target.value })}
        >
          {filters.tickerItems.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <FilterChips label="订单状态" items={filters.statusItems} value={filters.status} activeClassName={activeClassName} onChange={(status) => filters.onChange({ status })} />
      <FilterChips label="方向" items={filters.sideItems} value={filters.side} activeClassName={activeClassName} onChange={(side) => filters.onChange({ side })} />
    </div>
  )
}

function FilterChips({
  label,
  items,
  value,
  activeClassName,
  onChange,
}: {
  label: string
  items: FilterItem[]
  value: string
  activeClassName: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 shrink-0 text-xs font-semibold text-stone-500">{label}</span>
      {items.map((item) => (
        <button
          key={item.value}
          className={`rounded-xl px-3 py-2 text-xs font-bold transition ${item.value === value ? `${activeClassName} shadow-lg` : 'bg-white text-stone-600 hover:bg-stone-100'}`}
          aria-label={`${label}：${item.label}`}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function CompactValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold text-stone-500">{label}</p>
      <p className="mt-1 break-words font-semibold text-stone-800">{value || '无'}</p>
    </div>
  )
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : value || '无'
}
