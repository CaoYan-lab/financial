import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { RawCompanyData } from '../../shared/types'
import Badge from '@/components/common/Badge'
import type { ReportLanguage } from '@/components/report/ReportToolbar'
import { displayValue } from '@/utils/displayText'

type Props = {
  rows: RawCompanyData[]
  language?: ReportLanguage
}

type ColumnKey = keyof RawCompanyData

const columns: Array<{
  key: ColumnKey
  zh: string
  en: string
  groupZh: string
  groupEn: string
  critical?: boolean
}> = [
  { key: 'rank', zh: '排名', en: 'Rank', groupZh: '身份', groupEn: 'Identity', critical: true },
  { key: 'ticker', zh: '代码', en: 'Ticker', groupZh: '身份', groupEn: 'Identity', critical: true },
  { key: 'companyName', zh: '公司', en: 'Company', groupZh: '身份', groupEn: 'Identity', critical: true },
  { key: 'country', zh: '国家', en: 'Country', groupZh: '身份', groupEn: 'Identity', critical: true },
  { key: 'currentPrice', zh: '价格', en: 'Price', groupZh: '市场', groupEn: 'Market', critical: true },
  { key: 'marketCap', zh: '市值', en: 'Market Cap', groupZh: '市场', groupEn: 'Market', critical: true },
  { key: 'peRatio', zh: '市盈率', en: 'P/E', groupZh: '市场', groupEn: 'Market' },
  { key: 'rsi14', zh: 'RSI', en: 'RSI', groupZh: '技术', groupEn: 'Technical' },
  { key: 'ma50', zh: '50日线', en: '50 MA', groupZh: '技术', groupEn: 'Technical' },
  { key: 'ma200', zh: '200日线', en: '200 MA', groupZh: '技术', groupEn: 'Technical' },
  { key: 'ivRank', zh: 'IV 排名', en: 'IV Rank', groupZh: '期权', groupEn: 'Options' },
  { key: 'iv30', zh: '30日 IV', en: 'IV 30D', groupZh: '期权', groupEn: 'Options' },
  { key: 'nextEarningsDate', zh: '财报', en: 'Earnings', groupZh: '事件', groupEn: 'Events' },
  { key: 'capitalPerContract', zh: '每手资金', en: 'Capital', groupZh: '期权', groupEn: 'Options' },
  { key: 'sevenDayNews', zh: '7日新闻', en: '7-Day News', groupZh: '事件', groupEn: 'Events' },
]

export default function UniverseTable({ rows, language = 'zh' }: Props) {
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() => new Set(columns.map((column) => column.key)))
  const activeColumns = columns.filter((column) => visibleColumns.has(column.key))
  const unavailableRatios = useMemo(() => {
    return columns.reduce<Record<string, number>>((result, column) => {
      result[column.key] = rows.length
        ? rows.filter((row) => String(row[column.key]).toLowerCase().includes('unavailable')).length / rows.length
        : 0
      return result
    }, {})
  }, [rows])

  const setColumnVisible = (key: ColumnKey, visible: boolean) => {
    const column = columns.find((item) => item.key === key)
    if (column?.critical && !visible) return
    setVisibleColumns((current) => {
      const next = new Set(current)
      if (visible) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const hideUnavailableColumns = () => {
    setVisibleColumns(new Set(columns.filter((column) => column.critical || unavailableRatios[column.key] < 0.5).map((column) => column.key)))
  }

  return (
    <section id="raw" className="rounded-3xl border border-stone-200 bg-white/90 p-6 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-stone-500">{language === 'zh' ? '原始数据优先' : 'Raw Data First'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '30 行纯数据表' : '30-Row Raw Data Table'}</h2>
          <p className="mt-2 text-sm text-stone-500">
            {language === 'zh' ? '此表只展示事实数据，不混入评级和交易判断。' : 'This table contains factual data only, without ratings or trading judgments.'}
          </p>
        </div>
        <Badge tone="cyan">{language === 'zh' ? `${rows.length} 行 · 显示 ${activeColumns.length}/${columns.length} 列` : `${rows.length} rows · ${activeColumns.length}/${columns.length} columns`}</Badge>
      </div>

      <div className="mt-5 rounded-3xl border border-stone-200 bg-stone-50 p-4">
        <div className="flex flex-wrap gap-2">
          <button className="rounded-2xl bg-amber-500 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400" onClick={hideUnavailableColumns}>
            {language === 'zh' ? '隐藏不可用列' : 'Hide Unavailable Columns'}
          </button>
          <button className="rounded-2xl border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100" onClick={() => setVisibleColumns(new Set(columns.map((column) => column.key)))}>
            {language === 'zh' ? '显示全部列' : 'Show All Columns'}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {columns.map((column) => (
            <label key={column.key} className={`inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs ${column.critical ? 'border-stone-200 bg-white text-stone-500' : 'border-stone-200 bg-white text-stone-700'}`}>
              <input
                type="checkbox"
                checked={visibleColumns.has(column.key)}
                disabled={column.critical}
                onChange={(event) => setColumnVisible(column.key, event.target.checked)}
              />
              <span>{column[language]}</span>
              {unavailableRatios[column.key] >= 0.5 ? <span className="text-amber-700">{language === 'zh' ? '不可用多' : 'many unavailable'}</span> : null}
            </label>
          ))}
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="min-w-[1200px] border-separate border-spacing-0 text-left text-sm">
          <thead className="sticky top-0 bg-white text-xs tracking-wide text-stone-500">
            <tr>
              {activeColumns.map((column, index) => (
                <th
                  key={`${column.key}-group`}
                  className={`border-b border-stone-200 px-3 py-2 ${index === 0 ? 'sticky left-0 z-10 bg-white' : ''} ${index === 1 ? 'sticky left-16 z-10 bg-white' : ''}`}
                >
                  {language === 'zh' ? column.groupZh : column.groupEn}
                </th>
              ))}
            </tr>
            <tr>
              {activeColumns.map((column, index) => (
                <th
                  key={column.key}
                  className={`border-b border-stone-200 px-3 py-3 font-semibold text-stone-700 tabular-nums ${index === 0 ? 'sticky left-0 z-10 bg-white' : ''} ${index === 1 ? 'sticky left-16 z-10 bg-white' : ''}`}
                >
                  {column[language]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className="border-b border-stone-900 text-stone-600">
                {activeColumns.map((column, index) => (
                  <Cell key={column.key} language={language} strong={column.key === 'ticker'} stickyLeft={index === 0 ? 'left-0' : index === 1 ? 'left-16' : undefined}>
                    {column.key === 'ticker' ? (
                      <Link className="text-amber-800 hover:text-amber-500" to={`/stocks/${row.ticker}`}>
                        {row.ticker}
                      </Link>
                    ) : (
                      row[column.key] as ReactNode
                    )}
                  </Cell>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Cell({ children, language, strong = false, stickyLeft }: { children: ReactNode; language: ReportLanguage; strong?: boolean; stickyLeft?: string }) {
  if (typeof children !== 'string' && typeof children !== 'number') {
    return (
      <td className={`border-b border-stone-100 px-3 py-3 align-top text-stone-700 tabular-nums ${stickyLeft ? `sticky ${stickyLeft} z-10 bg-white` : ''} ${strong ? 'font-semibold tracking-tight text-stone-950' : ''}`}>
        {children}
      </td>
    )
  }
  const value = String(children)
  const unavailable = value.toLowerCase().includes('unavailable')
  const shownValue = displayValue(value, language)
  return (
    <td className={`border-b border-stone-100 px-3 py-3 align-top text-stone-700 tabular-nums ${stickyLeft ? `sticky ${stickyLeft} z-10 bg-white` : ''} ${strong ? 'font-semibold tracking-tight text-stone-950' : ''}`}>
      {unavailable ? <Badge tone="amber">{shownValue}</Badge> : shownValue}
    </td>
  )
}
