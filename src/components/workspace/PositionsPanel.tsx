import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Badge from '@/components/common/Badge'
import ProfitValue from '@/components/common/ProfitValue'
import { useUiStore } from '@/stores/uiStore'
import { displayAssetType, displayValue, maskAssetValue, parseSignedNumber } from '@/utils/displayText'
import type { Position } from '../../../shared/types'

export default function PositionsPanel({ positions }: { positions: Position[] }) {
  const language = useUiStore((state) => state.language)
  const assetPrivacyHidden = useUiStore((state) => state.assetPrivacyHidden)
  const groups = useMemo(() => groupPositions(positions), [positions])
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    setOpenKeys(new Set(groups.slice(0, 5).map((group) => group.key)))
  }, [groups])

  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '持仓' : 'Positions'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '持仓层级' : 'Position Hierarchy'}</h2>
        </div>
        <Badge tone="cyan">{language === 'zh' ? `${positions.length} 条持仓` : `${positions.length} positions`}</Badge>
      </div>

      <div className="mt-5 space-y-4">
        {groups.map((group) => {
          const open = openKeys.has(group.key)
          return (
            <article key={group.key} className="rounded-3xl border border-stone-200 bg-stone-50 p-4">
              <button
                className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
                onClick={() =>
                  setOpenKeys((current) => {
                    const next = new Set(current)
                    if (open) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  })
                }
              >
                <div>
                  <p className="text-xl font-bold tracking-tight text-stone-950 tabular-nums">{group.key}</p>
                  <p className="text-sm text-stone-500">{group.name}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="cyan">{language === 'zh' ? `正股 ${group.stockCount}` : `${group.stockCount} stocks`}</Badge>
                  <Badge tone="amber">{language === 'zh' ? `期权 ${group.optionCount}` : `${group.optionCount} options`}</Badge>
                  <Badge tone="emerald">{language === 'zh' ? `市值 ${group.marketValue}` : `Market Value ${group.marketValue}`}</Badge>
                  <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-semibold text-stone-600">
                    {language === 'zh' ? '今日盈亏' : 'Today P/L'}
                      {assetPrivacyHidden ? <span className="tabular-nums text-stone-700">{maskAssetValue()}</span> : <ProfitValue value={group.todayPnL} language={language} />}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-semibold text-stone-600">
                    {language === 'zh' ? '总盈亏' : 'Total P/L'}
                      {assetPrivacyHidden ? <span className="tabular-nums text-stone-700">{maskAssetValue()}</span> : <ProfitValue value={group.totalPnL} language={language} />}
                  </span>
                  <Badge tone="slate">{open ? (language === 'zh' ? '收起' : 'Collapse') : language === 'zh' ? '展开' : 'Expand'}</Badge>
                </div>
              </button>
              <Link
                className="mt-3 inline-flex rounded-2xl bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 shadow-sm hover:bg-amber-500"
                to={`/stocks/${group.key}`}
              >
                {language === 'zh' ? '实时行情' : 'Realtime'}
              </Link>

              {open ? (
                <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200 bg-white">
                  <table className="min-w-[920px] text-left text-sm">
                    <thead className="bg-stone-50 text-xs font-semibold text-stone-500">
                      <tr>
                        {(language === 'zh'
                          ? ['类型', '合约/代码', '数量', '市值', '成本', '现价', '今日盈亏', '总盈亏', '占比']
                          : ['Type', 'Contract/Ticker', 'Qty', 'Market Value', 'Cost', 'Price', 'Today P/L', 'Total P/L', 'Ratio']
                        ).map((header) => (
                          <th key={header} className="border-b border-stone-200 px-3 py-3">{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((position) => (
                        <tr key={position.code || position.ticker} className="border-b border-stone-100 text-stone-700">
                          <td className="px-3 py-3"><Badge tone={assetTone(position)}>{displayAssetType(position.assetType, language)}</Badge></td>
                          <td className="px-3 py-3">
                            <Link className="font-semibold tracking-tight text-amber-700 tabular-nums hover:text-amber-500" to={`/stocks/${position.underlyingTicker || position.ticker}`}>
                              {displayValue(position.contractSummary || position.ticker, language)}
                            </Link>
                            <p className="text-xs text-stone-500">{displayValue(position.name, language)}</p>
                          </td>
                          <td className="px-3 py-3 tabular-nums">{displayValue(position.quantity, language)}</td>
                          <td className="px-3 py-3 tabular-nums">{displayValue(position.marketValue, language)}</td>
                          <td className="px-3 py-3 tabular-nums">{displayValue(position.averageCost, language)}</td>
                          <td className="px-3 py-3 tabular-nums">{displayValue(position.currentPrice, language)}</td>
                            <td className="px-3 py-3">{assetPrivacyHidden ? <span className="font-semibold tabular-nums text-stone-700">{maskAssetValue()}</span> : <ProfitValue value={position.todayPnL} language={language} variant="pill" />}</td>
                            <td className="px-3 py-3">{assetPrivacyHidden ? <span className="font-semibold tabular-nums text-stone-700">{maskAssetValue()}</span> : <ProfitValue value={position.unrealizedPnL} language={language} variant="pill" />}</td>
                          <td className="px-3 py-3"><ProfitValue value={position.positionRatio} language={language} variant="pill" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </article>
          )
        })}
        {!positions.length ? <p className="py-6 text-sm text-stone-500">{language === 'zh' ? '暂无可展示持仓，或账户权限不足。' : 'No positions available, or account permission is insufficient.'}</p> : null}
      </div>
    </section>
  )
}

function groupPositions(positions: Position[]) {
  const grouped = new Map<string, Position[]>()
  for (const position of positions) {
    const key = position.underlyingTicker || position.ticker
    grouped.set(key, [...(grouped.get(key) ?? []), position])
  }
  return [...grouped.entries()]
    .map(([key, items]) => {
      const marketValues = sumMoney(items.map((item) => item.marketValue))
      const todayPnlValues = sumMoney(items.map((item) => item.todayPnL))
      const pnlValues = sumMoney(items.map((item) => item.unrealizedPnL))

      return {
        key,
        name: items.find((item) => item.assetType === 'STOCK')?.name ?? (items.some((item) => item.assetType === 'OPTION') ? key : items[0]?.name) ?? key,
        stockCount: items.filter((item) => item.assetType === 'STOCK').length,
        optionCount: items.filter((item) => item.assetType === 'OPTION').length,
        marketValue: marketValues.count ? formatMoney(marketValues.total) : items.find((item) => item.assetType === 'STOCK')?.marketValue ?? items[0]?.marketValue ?? 'unavailable',
        todayPnL: todayPnlValues.count ? formatMoney(todayPnlValues.total) : 'unavailable',
        totalPnL: pnlValues.count ? formatMoney(pnlValues.total) : 'unavailable',
        marketValueNumeric: marketValues.count ? marketValues.total : numericMoney(items.find((item) => item.assetType === 'STOCK')?.marketValue ?? items[0]?.marketValue ?? 'unavailable'),
        items,
      }
    })
    .sort((a, b) => b.marketValueNumeric - a.marketValueNumeric)
}

function numericMoney(value: string): number {
  return parseSignedNumber(value) ?? 0
}

function sumMoney(values: string[]): { total: number; count: number } {
  return values.reduce(
    (result, value) => {
      const parsed = parseSignedNumber(value)
      if (parsed === undefined) return result
      return { total: result.total + parsed, count: result.count + 1 }
    },
    { total: 0, count: 0 },
  )
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `$${sign}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function assetTone(position: Position): 'cyan' | 'emerald' | 'amber' | 'slate' {
  if (position.assetType === 'STOCK') return 'cyan'
  if (position.optionType === 'CALL') return 'emerald'
  if (position.optionType === 'PUT') return 'amber'
  return 'slate'
}
