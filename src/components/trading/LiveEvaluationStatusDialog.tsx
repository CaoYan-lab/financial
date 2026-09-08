import { useEffect } from 'react'
import { CheckCircle2, Clock3, X, XCircle } from 'lucide-react'
import type {
  LiveEvaluationStatus,
  LiveEvaluationTickerStatus,
  TradeExecutionMode,
  TradeStrategyConfigResponse,
} from '../../../shared/types'

export default function LiveEvaluationStatusDialog({
  status,
  strategyConfig,
  accent,
  onClose,
}: {
  status: LiveEvaluationStatus
  strategyConfig?: TradeStrategyConfigResponse
  accent: 'futu' | 'longbridge'
  onClose: () => void
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const accentText = accent === 'futu' ? 'text-orange-700' : 'text-sky-700'
  const activeStrategyId = strategyConfig?.selection.strategyId

  return (
    <div
      className="fixed inset-0 z-[10000] grid place-items-center bg-stone-950/40 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-stone-200 bg-white p-5 shadow-2xl md:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-status-title"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className={`text-xs font-bold ${accentText}`}>实盘评估状态</p>
            <h2 id="evaluation-status-title" className="mt-1 text-xl font-bold text-stone-950">策略与标的详情</h2>
            <p className="mt-1 text-sm text-stone-600">{status.summary}</p>
          </div>
          <button
            type="button"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-stone-500 hover:bg-stone-100"
            onClick={onClose}
            title="关闭"
            aria-label="关闭详情说明"
          >
            <X size={19} />
          </button>
        </header>

        <section className="mt-6">
          <h3 className="text-sm font-bold text-stone-950">当前策略</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <DetailCell label="当前策略版本" value={strategyConfig?.activeStrategy.label ?? '未加载'} />
            <DetailCell label="当前提示词版本" value={strategyConfig?.activePromptPack.label ?? '未加载'} />
            <DetailCell label="执行模式" value={executionModeLabel(strategyConfig?.selection.executionMode)} />
          </div>
          <div className="mt-3 rounded-2xl border border-stone-200 bg-stone-50 p-4">
            <p className="text-xs font-bold text-stone-500">全部策略版本</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {(strategyConfig?.strategyOptions ?? []).map((strategy) => {
                const active = strategy.id === activeStrategyId
                return (
                  <div key={strategy.id} className={`rounded-2xl border p-3 ${active ? activeStrategyClass(accent) : 'border-stone-200 bg-white'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-bold text-stone-950">{strategy.label}</p>
                      {active ? <span className="shrink-0 text-xs font-bold">当前启用</span> : null}
                    </div>
                    <p className="mt-1 text-sm leading-5 text-stone-600">{strategy.summary}</p>
                  </div>
                )
              })}
              {!strategyConfig?.strategyOptions.length ? (
                <p className="text-sm text-stone-500">策略配置尚未加载。</p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h3 className="text-sm font-bold text-stone-950">全部标的状态</h3>
            <p className="text-xs text-stone-500">更新时间：{formatTime(status.updatedAt)}</p>
          </div>
          <div className="mt-3 overflow-hidden rounded-2xl border border-stone-200">
            <div className="hidden grid-cols-[minmax(0,1fr)_90px_110px_minmax(0,2fr)] gap-3 bg-stone-50 px-4 py-3 text-xs font-bold text-stone-500 md:grid">
              <span>标的</span>
              <span>市场</span>
              <span>当前状态</span>
              <span>评估说明</span>
            </div>
            <div className="divide-y divide-stone-200">
              {status.items.map((item) => (
                <TickerStatusRow key={item.ticker} item={item} />
              ))}
            </div>
          </div>
        </section>
      </section>
    </div>
  )
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
      <p className="text-xs font-bold text-stone-500">{label}</p>
      <p className="mt-1 text-sm font-bold text-stone-950">{value}</p>
    </div>
  )
}

function TickerStatusRow({ item }: { item: LiveEvaluationTickerStatus }) {
  const Icon = item.evaluationState === 'ACTIVE'
    ? CheckCircle2
    : item.evaluationState === 'ERROR'
      ? XCircle
      : Clock3
  const stateLabel = item.evaluationState === 'ACTIVE'
    ? '正在评估'
    : item.evaluationState === 'ERROR'
      ? '状态异常'
      : '暂不评估'
  const tone = item.evaluationState === 'ACTIVE'
    ? 'text-emerald-700'
    : item.evaluationState === 'ERROR'
      ? 'text-rose-700'
      : 'text-amber-700'

  return (
    <div className="grid gap-2 bg-white px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_90px_110px_minmax(0,2fr)] md:items-center md:gap-3">
      <p className="font-bold text-stone-950">{item.ticker}</p>
      <p className="text-stone-600">{item.market}</p>
      <p className="text-stone-700">{item.marketLabel}</p>
      <div className={`flex items-start gap-2 ${tone}`}>
        <Icon className="mt-0.5 shrink-0" size={16} aria-hidden="true" />
        <p><strong>{stateLabel}</strong><span className="text-stone-500"> · {item.reason}</span></p>
      </div>
    </div>
  )
}

function executionModeLabel(mode?: TradeExecutionMode): string {
  if (mode === 'candidate_pool') return '候选池组合裁决'
  if (mode === 'trading_agent') return '多角色交易代理'
  if (mode === 'legacy_direct') return '大模型直推'
  return '未加载'
}

function activeStrategyClass(accent: 'futu' | 'longbridge'): string {
  return accent === 'futu'
    ? 'border-orange-300 bg-orange-50 text-orange-800'
    : 'border-sky-300 bg-sky-50 text-sky-800'
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '未知'
  return parsed.toLocaleString('zh-CN', { hour12: false })
}
