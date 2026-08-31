import MetricCard from '@/components/common/MetricCard'
import AssetPrivacyToggle from '@/components/common/AssetPrivacyToggle'
import ProfitValue from '@/components/common/ProfitValue'
import { useUiStore } from '@/stores/uiStore'
import { displayValue, maskAssetValue, parseSignedNumber, profitTone } from '@/utils/displayText'
import type { AccountSummary, Position } from '../../../shared/types'

export default function AccountSummaryPanel({ summary, positions = [] }: { summary?: AccountSummary; positions?: Position[] }) {
  const language = useUiStore((state) => state.language)
  const assetPrivacyHidden = useUiStore((state) => state.assetPrivacyHidden)
  const positionsDailyPnL = sumPositionsPnL(positions, 'todayPnL')
  const positionsTotalPnL = sumPositionsPnL(positions)
  const accountCurrency = summary?.currency && summary.currency !== 'unavailable' ? summary.currency : 'HKD'
  const pnlCurrency = positionCurrencies(positions) || 'USD'
  const assetHelper = language === 'zh' ? `账户币种：${accountCurrency}` : `Account currency: ${accountCurrency}`
  const pnlHelper = language === 'zh' ? `持仓盈亏币种：${pnlCurrency}` : `Position P/L currency: ${pnlCurrency}`
  const dailyPnL = positionsDailyPnL ?? summary?.dailyPnL
  const totalPnL = positionsTotalPnL ?? summary?.totalPnL
  const assetValue = (value: unknown) => (assetPrivacyHidden ? maskAssetValue() : displayValue(value, language))

  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? '账户' : 'Account'}</p>
      <h2 className="mt-2 text-2xl font-semibold text-stone-950">{language === 'zh' ? '账户资产总览' : 'Account Summary'}</h2>
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <MetricCard label={language === 'zh' ? '总资产' : 'Total Assets'} value={assetValue(summary?.totalAssets)} accent="emerald" helper={assetHelper} action={<AssetPrivacyToggle />} />
        <MetricCard label={language === 'zh' ? '现金' : 'Cash'} value={assetValue(summary?.cash)} accent="cyan" helper={assetHelper} />
        <MetricCard label={language === 'zh' ? '购买力' : 'Buying Power'} value={assetValue(summary?.buyingPower)} helper={assetHelper} />
        <MetricCard label={language === 'zh' ? '可用资金' : 'Available Funds'} value={assetValue(summary?.availableFunds)} helper={assetHelper} />
        <MetricCard
          label={language === 'zh' ? '当日盈亏' : 'Daily P/L'}
          value={assetPrivacyHidden ? maskAssetValue() : <ProfitValue value={dailyPnL} language={language} />}
          accent={profitAccent(dailyPnL)}
          helper={pnlHelper}
          valueClassName="text-inherit"
        />
        <MetricCard
          label={language === 'zh' ? '总盈亏' : 'Total P/L'}
          value={assetPrivacyHidden ? maskAssetValue() : <ProfitValue value={totalPnL} language={language} />}
          accent={profitAccent(totalPnL)}
          helper={pnlHelper}
          valueClassName="text-inherit"
        />
      </div>
    </section>
  )
}

function profitAccent(value: unknown): 'emerald' | 'red' | 'slate' {
  const tone = profitTone(value)
  if (tone === 'profit') return 'red'
  if (tone === 'loss') return 'emerald'
  return 'slate'
}

function sumPositionsPnL(positions: Position[], field: 'todayPnL' | 'unrealizedPnL' = 'unrealizedPnL'): string | undefined {
  let total = 0
  let count = 0

  for (const position of positions) {
    const parsed = parseSignedNumber(position[field])
    if (parsed === undefined) continue
    total += parsed
    count += 1
  }

  if (!count) return undefined
  const sign = total < 0 ? '-' : ''
  return `$${sign}${Math.abs(total).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function positionCurrencies(positions: Position[]): string | undefined {
  const currencies = [...new Set(positions.map((position) => position.currency).filter((currency) => currency && currency !== 'unavailable'))]
  if (!currencies.length) return undefined
  return currencies.join('/')
}
