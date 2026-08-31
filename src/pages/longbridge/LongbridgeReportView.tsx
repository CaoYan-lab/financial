import { useParams } from 'react-router-dom'
import { LongbridgeEmptyCard, LongbridgePageShell } from './LongbridgePageShell'

export default function LongbridgeReportView() {
  const { batchId } = useParams()

  return (
    <LongbridgePageShell
      eyebrow="Longbridge Report Detail"
      title="长桥报告详情"
      description="对应 Futu 报告详情页。该路由用于展示 Longbridge 独立报告，不读取 /api/report 或 Futu 报告数据库。"
    >
      <LongbridgeEmptyCard
        title={`报告批次：${batchId ?? 'unavailable'}`}
        description="后续会展示由 Longbridge quote、kline、news、filing、fundamentals、research 数据生成的 Markdown 报告。"
      />
    </LongbridgePageShell>
  )
}
