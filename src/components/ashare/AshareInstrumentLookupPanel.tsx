import Badge from '@/components/common/Badge'
import { useAshareInstrumentLookup } from '@/hooks/ashare/useAshareInstrumentLookup'

export default function AshareInstrumentLookupPanel({ onUniverseUpdated }: { onUniverseUpdated?: () => void }) {
  const {
    query,
    setQuery,
    lookupResult,
    universeResult,
    loading,
    subscribingTicker,
    error,
    lookup,
    subscribe,
  } = useAshareInstrumentLookup()

  return (
    <section id="lookup" className="rounded-3xl border border-orange-200/70 bg-white/90 p-6 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.24em] text-orange-700">查询订阅</p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-stone-950">真实 A股代码查询</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
            输入 SH/SZ 代码、6 位数字、股票名称，或“科创板 / STAR”，后端通过 A 股独立 API 查询 Futu 真实代码；点击 + 后才写入 A 股股票池。
          </p>
        </div>
        <Badge tone="amber">独立股票池</Badge>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <input
          className="rounded-2xl border border-orange-200 bg-white px-4 py-3 text-sm font-semibold text-stone-950 outline-none focus:border-orange-400"
          placeholder="输入 A 股代码或名称，如 SH.600519 / 平安银行 / 科创板"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="rounded-2xl bg-orange-500 px-5 py-3 text-sm font-black text-white shadow-sm shadow-orange-200 hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading}
          onClick={lookup}
          type="button"
        >
          {loading ? '查询中...' : '查询 Futu 真实代码'}
        </button>
      </div>

      {error ? <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <div className="mt-5 space-y-3">
        {(lookupResult?.candidates ?? []).map((candidate) => (
          <article key={candidate.futuCode} className="grid gap-3 rounded-2xl border border-orange-100 bg-orange-50/40 p-4 text-sm md:grid-cols-[1.1fr_1fr_0.8fr_auto] md:items-center">
            <div>
              <p className="text-xs font-bold text-stone-500">名称</p>
              <p className="mt-1 font-black text-stone-950">{candidate.name}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-stone-500">真实订阅代码</p>
              <p className="mt-1 font-mono font-black text-stone-950">{candidate.futuCode}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-stone-500">币种 / 类型 / 板块</p>
              <p className="mt-1 font-bold text-stone-700">{candidate.tradingCurrency} · {candidate.assetType} · {formatAshareBoard(candidate.board)}</p>
            </div>
            <button
              className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-black text-white hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={Boolean(subscribingTicker)}
              onClick={async () => {
                const result = await subscribe(candidate)
                if (result?.ok) onUniverseUpdated?.()
              }}
              type="button"
            >
              {subscribingTicker === candidate.ticker ? '订阅中...' : '+ 订阅进股票池'}
            </button>
          </article>
        ))}
        {lookupResult?.ok && lookupResult.candidates.length === 0 ? (
          <div className="rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3 text-sm font-semibold text-stone-600">
            未查询到匹配标的。可以尝试输入完整简称、6 位代码或 SH./SZ. 代码。
          </div>
        ) : null}
      </div>

      {universeResult ? (
        <p className="mt-4 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-semibold text-orange-800">
          A 股股票池已更新，当前共 {universeResult.universe.length} 个标的。
        </p>
      ) : null}
    </section>
  )
}

function formatAshareBoard(board?: string) {
  const labels: Record<string, string> = {
    SH_MAIN: '沪市主板',
    STAR: '科创板',
    SZ_MAIN: '深市主板',
    CHINEXT: '创业板',
    BSE: '北交所',
    UNKNOWN: '未知板块',
  }
  return labels[board ?? 'UNKNOWN'] ?? board ?? '未知板块'
}
