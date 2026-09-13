import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hash } from './promptSuite.mjs'
import { evaluate } from './evaluate.mjs'
import { bindRequest } from './compactContract.mjs'

const dataset = JSON.parse(readFileSync(resolve(process.argv[2] ?? '.data/shadow-trading/blinded-frozen/dataset.json'), 'utf8'))
const out = resolve(process.argv[3] ?? '.data/shadow-trading/blinded-8192')
const manifest = JSON.parse(readFileSync(resolve(out, 'manifest.json'), 'utf8'))
const rows = readFileSync(resolve(out, 'responses.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
if (hash(dataset) !== manifest.datasetHash) throw new Error('Dataset hash mismatch')
if (new Set(rows.map(r => r.requestKey)).size !== rows.length) throw new Error('Duplicate responses')
for (const row of rows) {
  const request = dataset.requests.find(r => r.id === row.id && r.arm === row.arm)
  if (!request || request.promptHash !== row.promptHash || hash(request.messages) !== request.promptHash) throw new Error('Response/request mismatch')
  const scenario = dataset.scenarios.find(s => s.id === row.id)
  if (['shadow-facts-v2.3', 'shadow-facts-v2.4'].includes(scenario.facts.schemaVersion)) {
    if (JSON.stringify(row.binding) !== JSON.stringify(bindRequest(request, scenario.facts))) throw new Error('Request binding mismatch')
    if (JSON.stringify(row.evaluation) !== JSON.stringify(evaluate(scenario, row.output, row.arm))) throw new Error('Evaluation drift')
  }
}
const arms = ['legacy', 'legacy_enriched', 'v2']
const brokers = ['longbridge', 'futu']
const groups = []
for (const broker of brokers) for (const arm of arms) {
  const group = rows.filter(r => r.broker === broker && r.arm === arm)
  const expected = dataset.scenarios.filter(s => s.broker === broker)
  const valid = r => Boolean(r && !r.error && r.evaluation.evaluable)
  const metric = category => {
    const cases = expected.filter(s => s.category === category)
    const samples = group.filter(r => r.category === category)
    return {
      total: cases.length * manifest.repeats,
      usable: samples.filter(valid).length,
      unsuccessful: samples.filter(r => valid(r) && (r.evaluation.invalidTrade || r.evaluation.missedControl)).length,
      unavailable: cases.length * manifest.repeats - samples.filter(valid).length,
      successes: samples.filter(r => valid(r) && !r.evaluation.invalidTrade && !r.evaluation.missedControl).length,
    }
  }
  const blocked = metric('blocked')
  const actionRows = group.filter(r => !r.error).map(r => ({
    ...r, actionEvaluation: evaluate(dataset.scenarios.find(s => s.id === r.id), r.output, 'legacy'),
  })).filter(r => r.actionEvaluation.evaluable)
  const actionBlocked = actionRows.filter(r => r.category === 'blocked')
  const durations = group.filter(r => !r.error).map(r => r.durationMs).sort((a, b) => a - b)
  groups.push({
    broker, arm, attempted: group.length, expected: expected.length * manifest.repeats,
    transportFailures: group.filter(r => r.error).length,
    contractFailures: group.filter(r => !r.error && !r.evaluation.evaluable).length,
    blocked, opportunity: metric('opportunity'), reduction: metric('reduction'),
    riskCancel: metric('risk_cancel'), protective: metric('protective'),
    blockedInvalidRange: [blocked.unsuccessful / blocked.total, (blocked.unsuccessful + blocked.unavailable) / blocked.total],
    actionOnlyBlocked: {
      usable: actionBlocked.length,
      invalid: actionBlocked.filter(r => r.actionEvaluation.invalidTrade).length,
      warning: '忽略新版附加契约，仅用于动作诊断，不能作为执行准入结果',
    },
    successfulResponseMedianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
  })
}
const failures = rows.filter(r => r.error || !r.evaluation.evaluable).map(r => ({ id: r.id, arm: r.arm, repeat: r.repeat, error: r.error, issues: r.evaluation.errors }))
const rankingChecks = rows.filter(r => dataset.scenarios.find(s => s.id === r.id)?.oracle.expectedPromotedIds).map(r => {
  const expected = dataset.scenarios.find(s => s.id === r.id).oracle.expectedPromotedIds
  const actual = r.output?.promotedCandidates?.map(c => c.candidateId) ?? []
  return { id: r.id, arm: r.arm, expected, actual,
    status: r.error || !r.evaluation.evaluable ? 'unavailable' : !actual.length ? 'not_selected'
      : JSON.stringify(actual) === JSON.stringify(expected) ? 'matched' : 'different_selection',
  }
})
const snapshot = {
  manifest, completed: rows.length, expected: dataset.requests.length * manifest.repeats,
  models: [...new Set(rows.map(r => r.responseModel).filter(Boolean))],
  usage: rows.reduce((a, r) => ({ input: a.input + (r.usage?.input_tokens ?? 0), output: a.output + (r.usage?.output_tokens ?? 0) }), { input: 0, output: 0 }),
  groups, failures, rankingChecks,
}
writeFileSync(resolve(out, 'audit.json'), JSON.stringify(snapshot, null, 2))
const lines = [
  '# 盲化影子测试审计',
  '',
  `完成 ${snapshot.completed}/${snapshot.expected}；模型 ${snapshot.models.join(', ')}；数据摘要 ${manifest.datasetHash}。`,
  '',
  '## 全分母指标',
  '',
  '| 券商 | 组别 | 阻断场景无效建议/可评估 | 不可评估 | 无效率保守范围 | 合格机会有效建议/总数 | 必要减仓有效建议/总数 | 风险开仓单正确撤单/总数 | 保护单与未知订单正确保持/总数 |',
  '|---|---|---:|---:|---|---:|---:|---:|---:|',
  ...groups.map(g => `| ${g.broker} | ${g.arm} | ${g.blocked.unsuccessful}/${g.blocked.usable} | ${g.blocked.unavailable} | ${g.blockedInvalidRange.map(x => `${(100 * x).toFixed(1)}%`).join(' 至 ')} | ${g.opportunity.successes}/${g.opportunity.total} | ${g.reduction.successes}/${g.reduction.total} | ${g.riskCancel.successes}/${g.riskCancel.total} | ${g.protective.successes}/${g.protective.total} |`),
  '',
  '保守范围不是置信区间：下界将不可评估样本视为未产生无效建议，上界将其全部视为失败。不可评估样本不算成功观望；成功对照分母包含接口失败和契约失败，反映端到端可用性。',
  '',
  '## 仅动作诊断',
  '',
  '以下忽略新版附加元数据与证据契约，使用各组相同的基础动作校验。只用于区分决策内容和输出可靠性，不改变主指标，不表示允许执行。',
  '',
  ...groups.map(g => `- ${g.broker} / ${g.arm}：动作可识别的阻断场景中，无效建议 ${g.actionOnlyBlocked.invalid}/${g.actionOnlyBlocked.usable}。`),
  '',
  '## 同分选择对照',
  '',
  '独立于原无效交易指标：未晋级不算同分规则通过；该预期是开发集对照，不是强制交易指令。',
  ...rankingChecks.map(r => `- ${r.id} / ${r.arm}：${r.status}；实际 ${r.actual.join(',') || '无'}；对照 ${r.expected.join(',')}。`),
  '',
  '## 不可评估样本',
  '',
  ...failures.map(f => `- ${f.id} / ${f.arm} / ${f.repeat}：${f.error ?? f.issues.join(', ')}`),
  '',
  '## 逐场景结果',
  '',
  '| 场景 | 当前提示词 | 当前提示词加同等数据 | 新版同等数据 |',
  '|---|---|---|---|',
]
for (const scenario of dataset.scenarios) {
  const cells = arms.map(arm => {
    const samples = rows.filter(r => r.id === scenario.id && r.arm === arm)
    return samples.map(r => {
      if (r.error) return `不可评估:${r.error}`
      if (!r.evaluation.evaluable) return `契约失败:${r.evaluation.errors.join(',')}`
      const output = r.role === 'single' ? `${r.output.action} ${r.output.orderQuantity}` :
        r.role === 'portfolio' ? `晋级${r.output.promotedCandidates.length}` : r.output.decisions[0].action
      return `${output} / ${r.evaluation.invalidTrade ? '违规' : r.evaluation.missedControl ? '未选择对照动作' : '符合场景'}`
    }).join('; ') || '未完成'
  })
  lines.push(`| ${scenario.id} | ${cells.join(' | ')} |`)
}
lines.push('', '本报告只检验合成规则场景，不验证真实市场收益；样本量有限，每种场景在两家券商下复用，不能视作独立随机行情样本。')
writeFileSync(resolve(out, 'audit.md'), `${lines.join('\n')}\n`)
console.log(JSON.stringify(snapshot))
