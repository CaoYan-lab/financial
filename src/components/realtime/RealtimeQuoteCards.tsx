import MetricCard from '@/components/common/MetricCard'
import ProfitValue from '@/components/common/ProfitValue'
import type { UiLanguage } from '@/stores/uiStore'
import type { RealtimeStockMock } from '@/mocks/realtimeStockMock'

export default function RealtimeQuoteCards({ stock, language, isRealtime }: { stock: RealtimeStockMock; language: UiLanguage; isRealtime: boolean }) {
  const volumeHelper = isRealtime ? (language === 'zh' ? 'Futu 回调成交量' : 'Futu callback volume') : language === 'zh' ? '视觉占位成交量' : 'Mock volume'

  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard label={language === 'zh' ? '最新价' : 'Last Price'} value={stock.price} accent="cyan" helper={stock.quoteUpdatedAt} />
      <MetricCard
        label={language === 'zh' ? '涨跌额' : 'Change'}
        value={<ProfitValue value={stock.change} language={language} />}
        accent={stock.change.startsWith('-') ? 'emerald' : 'red'}
        valueClassName="text-inherit"
      />
      <MetricCard
        label={language === 'zh' ? '涨跌幅' : 'Change %'}
        value={<ProfitValue value={stock.changePercent} language={language} />}
        accent={stock.changePercent.startsWith('-') ? 'emerald' : 'red'}
        valueClassName="text-inherit"
      />
      <MetricCard label={language === 'zh' ? '成交量' : 'Volume'} value={stock.volume} accent="slate" helper={volumeHelper} />
      <MetricCard label={language === 'zh' ? '开盘价' : 'Open'} value={stock.open} />
      <MetricCard label={language === 'zh' ? '最高价' : 'High'} value={stock.high} accent="red" />
      <MetricCard label={language === 'zh' ? '最低价' : 'Low'} value={stock.low} accent="emerald" />
      <MetricCard
        label={language === 'zh' ? '数据模式' : 'Data Mode'}
        value={isRealtime ? (language === 'zh' ? 'Futu 回调' : 'Futu Callback') : language === 'zh' ? '视觉占位' : 'Mock Visual'}
        accent={isRealtime ? 'emerald' : 'amber'}
      />
    </section>
  )
}
