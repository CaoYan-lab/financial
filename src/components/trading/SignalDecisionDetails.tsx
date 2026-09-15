import type { QuantSignal } from '../../../shared/types'

export default function SignalDecisionDetails({ signal }: { signal: QuantSignal }) {
  const evidence = signal.evidence ?? []
  const counterEvidence = signal.counterEvidence ?? []

  return (
    <div className="mt-3 border-t border-stone-200 pt-3 text-stone-600">
      <div className="grid gap-3 md:grid-cols-2">
        <DecisionSection label="风险评估" value={signal.riskAssessment || '未提供风险评估。'} />
        <DecisionSection label="退出或重新评估条件" value={signal.exitCondition || '未提供结构化退出条件。'} />
      </div>

      <div className="mt-3 grid gap-3 border-t border-stone-200 pt-3 md:grid-cols-2">
        <EvidenceSection label="支持证据" items={evidence} empty="未记录结构化支持证据。" />
        <EvidenceSection label="关键反证" items={counterEvidence} empty="模型未列出关键反证。" />
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-2 border-t border-stone-200 pt-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="font-semibold text-stone-500">后续动作</dt>
        <dd>{followUpLabel(signal.requestedFollowUp)}</dd>
        <dt className="font-semibold text-stone-500">实际数据窗口</dt>
        <dd>{signal.dataWindow}</dd>
      </dl>
    </div>
  )
}

function DecisionSection({ label, value }: { label: string; value: string }) {
  return (
    <section>
      <h3 className="text-xs font-semibold text-stone-500">{label}</h3>
      <p className="mt-1 leading-6">{value}</p>
    </section>
  )
}

function EvidenceSection({
  label,
  items,
  empty,
}: {
  label: string
  items: NonNullable<QuantSignal['evidence']>
  empty: string
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold text-stone-500">{label}</h3>
      {items.length ? (
        <ul className="mt-1 space-y-1 leading-6">
          {items.map(item => <li key={`${item.id}:${item.path}`}><strong>{item.id}</strong>：{item.summary}</li>)}
        </ul>
      ) : (
        <p className="mt-1 leading-6">{empty}</p>
      )}
    </section>
  )
}

function followUpLabel(value: QuantSignal['requestedFollowUp']) {
  return ({
    NONE: '无需额外动作',
    REFRESH_DATA: '刷新账户与行情数据',
    REVIEW_OPEN_ORDERS: '复核未完成订单',
    REVIEW_PENDING_INTENT: '复核待确认交易意图',
    MANUAL_REVIEW: '需要人工复核',
  } as const)[value ?? 'NONE']
}
