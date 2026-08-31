import { LongbridgeEmptyCard, LongbridgePageShell } from './LongbridgePageShell'

export default function LongbridgeOpportunityHistoryView() {
  return (
    <LongbridgePageShell
      eyebrow="Longbridge Opportunities"
      title="长桥机会历史"
      description="对应 Futu 的 Top5 机会历史页。后续机会来源为 Longbridge 行情、基本面、研究和情报能力。"
    >
      <LongbridgeEmptyCard title="暂无长桥机会历史" description="当前不会读取 Futu /opportunities。接入 Longbridge 报告生成后，这里展示独立的机会快照和历史分组。" />
    </LongbridgePageShell>
  )
}
