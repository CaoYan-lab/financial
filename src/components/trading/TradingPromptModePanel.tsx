import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import type {
  TradingPromptBroker,
  TradingPromptComparisonResponse,
  TradingPromptComparisonResult,
  TradingPromptReleaseStatus,
} from '../../../shared/tradingPromptTypes'

const modeNames = { legacy: '旧版', shadow: '新版影子', live: '新版实盘', blocked: '已阻断' }
const roleNames = { single: '单票', portfolio: '组合', managed: '挂单' }

export default function TradingPromptModePanel({ broker }: { broker: TradingPromptBroker }) {
  const [status, setStatus] = useState<TradingPromptReleaseStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [comparison, setComparison] = useState<TradingPromptComparisonResponse | null>(null)
  const [selection, setSelection] = useState<'legacy' | 'shadow' | 'live' | null>(null)
  const url = `/api/${broker === 'longbridge' ? 'longbridge/' : ''}live-trading/prompt-mode`
  const request = useCallback(async (mode?: 'legacy' | 'shadow' | 'live', revision?: number) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(url, mode ? {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, expectedRevision: revision, confirmed: true }),
      } : undefined)
      if (response.status === 401) { window.location.assign('/login'); return }
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '模式配置读取失败')
      setStatus(body)
      window.dispatchEvent(new CustomEvent('trading-prompt-mode-changed', {
        detail: { broker, status: body },
      }))
      setSelection(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : '模式配置暂不可用')
    } finally { setBusy(false) }
  }, [broker, url])
  const requestComparison = useCallback(async () => {
    try {
      const response = await fetch(`${url}/comparison/latest`)
      if (!response.ok) return
      setComparison(await response.json())
    } catch {
      // Comparison history is supplementary and must not block prompt mode controls.
    }
  }, [url])
  useEffect(() => {
    setStatus(null)
    void Promise.all([request(), requestComparison()])
  }, [request, requestComparison])
  const overridden = Boolean(status && Object.keys(status.environmentOverrides).length)
  const effectiveSelection = status && new Set(Object.values(status.effectiveModes)).size === 1
    ? status.effectiveModes.single
    : status?.selectedMode
  return <section className="border-y border-stone-200 bg-white px-4 py-4 text-sm text-stone-900" aria-label="交易提示词模式">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 font-semibold"><ShieldAlert size={16} />交易提示词</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="提示词模式" value={selection ?? effectiveSelection ?? 'legacy'} disabled={!status || busy || overridden}
          onChange={event => setSelection(event.target.value as 'legacy' | 'shadow' | 'live')}
          className="rounded border border-stone-300 bg-white px-3 py-2">
          <option value="legacy">旧版</option>
          <option value="shadow">新版影子</option>
          <option value="live" disabled={!status?.liveAvailable}>新版实盘</option>
        </select>
        <button type="button" title="刷新验收状态" aria-label="刷新验收状态" disabled={busy}
          className="p-2 disabled:opacity-50" onClick={() => { void Promise.all([request(), requestComparison()]) }}><RefreshCw size={16} /></button>
      </div>
    </div>
    {status && <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-stone-600">
      {(['single', 'portfolio', 'managed'] as const).map(role => <span key={role}>{roleNames[role]}：{modeNames[status.effectiveModes[role]]}{status.environmentOverrides[role] ? '（环境配置）' : ''}</span>)}
    </div>}
    {status && <ul className="mt-3 space-y-1 text-amber-600">{status.blockers.map(item => <li key={item}>{item}</li>)}</ul>}
    {selection && status && <div role="alertdialog" aria-label="确认提示词切换" className="mt-4 border-t border-stone-200 pt-3">
      <p>确认切换为{modeNames[selection]}？自动下单与自动撤单设置保持不变，已有订单继续受原监管规则处理。</p>
      <div className="mt-3 flex gap-3">
        <button type="button" disabled={busy} onClick={() => { void request(selection, status.revision) }} className="rounded border px-3 py-2">确认切换</button>
        <button type="button" disabled={busy} onClick={() => setSelection(null)} className="px-3 py-2">取消</button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-3 text-red-600">{error}</p>}
    {comparison?.run ? <ComparisonResults broker={broker} data={comparison} /> : null}
  </section>
}

function ComparisonResults({ broker, data }: { broker: TradingPromptBroker; data: TradingPromptComparisonResponse }) {
  const run = data.run!
  const tickers = [...new Set(data.results.map(item => item.ticker))].sort()
  return <div className="mt-5 border-t border-stone-200 pt-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="font-semibold">版本对比测试</h3>
        <p className="mt-1 text-xs text-stone-500">
          {broker === 'futu' ? '富途' : '长桥'} · {run.status === 'COMPLETED' ? '已完成' : run.status === 'RUNNING' ? '运行中' : '失败'}
          {' · '}{run.completedCases}/{run.totalCases} 项 · 通过 {run.passedCases} · 未通过 {run.failedCases}
        </p>
      </div>
      <span className="text-xs text-stone-500">{new Date(run.startedAt).toLocaleString('zh-CN')}</span>
    </div>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[960px] border-collapse text-left text-xs">
        <thead className="border-y border-stone-200 bg-stone-50 text-stone-600">
          <tr><th className="px-2 py-2">标的</th><th className="px-2 py-2">旧版</th><th className="px-2 py-2">旧版理由</th><th className="px-2 py-2">新版</th><th className="px-2 py-2">新版理由</th></tr>
        </thead>
        <tbody>
          {tickers.map(ticker => {
            const legacy = data.results.find(item => item.ticker === ticker && item.mode === 'legacy')
            const live = data.results.find(item => item.ticker === ticker && item.mode === 'live')
            return <tr key={ticker} className="border-b border-stone-100 align-top">
              <td className="px-2 py-3 font-semibold">{ticker}</td>
              <ResultStatus result={legacy} />
              <ResultDetail result={legacy} />
              <ResultStatus result={live} />
              <ResultDetail result={live} />
            </tr>
          })}
        </tbody>
      </table>
    </div>
  </div>
}

function ResultStatus({ result }: { result?: TradingPromptComparisonResult }) {
  if (!result) return <td className="px-2 py-3 text-stone-400">待执行</td>
  return <td className={`px-2 py-3 font-semibold ${result.requestOk ? 'text-emerald-700' : 'text-red-600'}`}>
    {actionName(result.action)} · {result.requestOk ? '通过' : '未通过'}
    <span className="mt-1 block font-normal text-stone-500">{(result.durationMs / 1000).toFixed(1)}秒</span>
  </td>
}

function ResultDetail({ result }: { result?: TradingPromptComparisonResult }) {
  if (!result) return <td className="px-2 py-3 text-stone-400">暂无</td>
  return <td className="max-w-[360px] px-2 py-3 text-stone-600">
    <p className="line-clamp-3 leading-5">{result.reason}</p>
    <details className="mt-2">
      <summary className="cursor-pointer text-stone-900">查看完整结果</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all bg-stone-50 p-2 text-[11px]">{JSON.stringify(result, null, 2)}</pre>
    </details>
  </td>
}

function actionName(action: string) {
  return ({ HOLD: '观望', BUY: '买入', SELL_SHORT: '卖空', SELL_TO_CLOSE: '平仓卖出' } as Record<string, string>)[action] ?? action
}
