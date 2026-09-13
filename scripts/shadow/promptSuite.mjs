import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { compactSchema, evidenceCatalog } from './compactContract.mjs'

export const suiteVersion = 'dual-broker-shadow-v2.4-candidate-evidence'
export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

// This module only builds messages. It imports no broker, database or order service.
export function buildShadowV2Messages(role, broker, facts) {
  const prompts = JSON.parse(readFileSync(new URL('./compactPrompts.json', import.meta.url), 'utf8'))
  if (!['single', 'portfolio', 'managed'].includes(role) || !['futu', 'longbridge'].includes(broker)) throw new Error('Unknown role/broker')
  const brokerPolicy = broker === 'futu'
    ? '当前券商为富途。不得采用长桥原始 risk_level 的数值含义。风险准入只使用本次后端规范化的 riskState.openingRiskStatus；本轮为合成影子数据，不表示生产系统已完成映射。'
    : '当前券商为长桥。风险准入使用有效融资字段及本次后端规范化的 riskState.openingRiskStatus；本轮为合成影子数据。'
  const system = `${broker === 'futu' ? '富途证券' : '长桥证券'}影子分析。\n${prompts.common}\n${prompts[role]}`
  return [
    { role: 'system', content: `${system}\n${brokerPolicy}` },
    { role: 'user', content: JSON.stringify({ ...facts, evidenceCatalog: evidenceCatalog(facts), outputSchema: compactSchema(role, facts) }) },
  ]
}

export function enrichLegacy(messages, facts) {
  const result = structuredClone(messages)
  const payload = JSON.parse(result[1].content)
  // Both enriched arms receive identical facts; no evaluator labels are transmitted.
  result[1].content = JSON.stringify({ ...payload, shadowContext: facts, evidenceCatalog: evidenceCatalog(facts) })
  return result
}
