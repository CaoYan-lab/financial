import { LongbridgeEmptyCard, LongbridgePageShell } from './LongbridgePageShell'

export default function LongbridgePromptView() {
  return (
    <LongbridgePageShell
      eyebrow="Longbridge Prompt"
      title="长桥策略 Prompt"
      description="对应 Futu 的 Prompt 查看页。后续展示 Longbridge live prompt pack，文案中必须明确数据来源为 Longbridge Skill / CLI / MCP。"
    >
      <LongbridgeEmptyCard title="Prompt Pack 待接入" description="需要新增 llm_autonomous_stock_trader_longbridge_live_safe_v1.yaml，并移除 Futu REAL、Futu OpenD、Futu 购买力等平台文案。" />
    </LongbridgePageShell>
  )
}
