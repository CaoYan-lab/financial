import { describe, expect, it } from 'vitest'
import { createScenarios, validateFacts } from '../scripts/shadow/scenarios.mjs'
import { bindRequest, compactSchema, evidenceCatalog, validateCompactOutput } from '../scripts/shadow/compactContract.mjs'
import { buildShadowV2Messages, enrichLegacy } from '../scripts/shadow/promptSuite.mjs'
import { evaluate, parseResponse, summarize } from '../scripts/shadow/evaluate.mjs'
import { candidateMetrics, compareCandidates, validateCandidateEvidence } from '../scripts/shadow/candidateEvidence.mjs'

describe('双券商影子测试隔离与计分', () => {
  const scenarios = createScenarios()
  it('生成32个确定性场景并隔离预期标签', () => {
    expect(scenarios).toHaveLength(32)
    expect(createScenarios()).toEqual(scenarios)
    expect(new Set(scenarios.map(s => s.id)).size).toBe(32)
    for (const s of scenarios) {
      const messages = buildShadowV2Messages(s.role, s.broker, s.facts)
      const payload = JSON.parse(messages[1].content)
      expect(payload).not.toHaveProperty('oracle')
      expect(payload).not.toHaveProperty('category')
      expect(s.facts.contextId).toMatch(/^[a-f0-9]{20}$/)
      expect(JSON.stringify(messages)).not.toContain(s.id)
      expect(messages[0].content).toContain(s.broker === 'futu' ? '富途证券' : '长桥证券')
      if (s.broker === 'futu') expect(messages[0].content).toContain('不得采用长桥原始')
    }
  })
  it('相同事实不篡改旧提示词', () => {
    const legacy = [{ role: 'system', content: 'old' }, { role: 'user', content: '{"task":"old"}' }]
    const copy = enrichLegacy(legacy, scenarios[0].facts)
    expect(legacy[1].content).toBe('{"task":"old"}')
    expect(JSON.parse(copy[1].content).shadowContext).toEqual(scenarios[0].facts)
  })
  it('香港时间、币种、交易单位一致', () => {
    for (const s of scenarios.filter(s => s.id.endsWith('hk-insufficient-lot'))) {
      expect(s.facts.instrument.lotSize).toBe(100)
      expect(s.facts.account.money.equity.currency).toBe('HKD')
      expect(s.facts.dataQuality.quote.sourceAt).toBe(s.facts.runtime.decisionAt)
      expect(Date.parse(s.facts.marketData.recentKlineBars.at(-1).time)).toBeLessThanOrEqual(Date.parse(s.facts.runtime.decisionAt))
    }
  })
  it('格式或接口失败不计为成功观望', () => {
    const evaluation = evaluate(scenarios[0], null, 'v2')
    expect(evaluation.evaluable).toBe(false)
    const [group] = summarize([{ broker: 'longbridge', arm: 'v2', role: 'single', category: 'blocked', evaluation, error: 'TIMEOUT' }])
    expect(group.transportFailures).toBe(1)
    expect(group.blockedCases).toBe(0)
    expect(group.invalidRate).toBeNull()
    expect(parseResponse('{"action":')).toBeNull()
  })
  it('预警开仓被判无效，观望不是无效交易', () => {
    const scenario = scenarios[0]
    const buy = { approved: true, action: 'BUY', ticker: 'AAPL', orderQuantity: 1, limitPrice: 100 }
    expect(evaluate(scenario, buy, 'legacy').invalidTrade).toBe(true)
    expect(evaluate(scenario, { ...buy, action: 'HOLD', orderQuantity: 0 }, 'legacy').invalidTrade).toBe(false)
  })
  it('新版正确HOLD可评估，漏版本或编造证据路径不可评估', () => {
    const s = structuredClone(scenarios[0])
    delete s.facts.schemaVersion
    const output = {
      promptVersion: 'dual_broker_single_v2', contextId: s.facts.contextId,
      approved: false, action: 'HOLD', ticker: 'AAPL', orderQuantity: 0, limitPrice: null,
      confidence: 'high', reason: '风险阻断', riskAssessment: '不新增敞口',
      validUntil: s.facts.runtime.maxValidUntil, positionEffect: 'NONE',
      evidence: [{ path: 'riskState.openingRiskStatus', observation: 'BLOCKED' }],
      counterEvidence: [], unknowns: [], blockingReasons: ['融资预警'],
    }
    expect(evaluate(s, output, 'v2').evaluable).toBe(true)
    expect(evaluate(s, { ...output, promptVersion: undefined }, 'v2').errors).toContain('context_or_version')
    expect(evaluate(s, { ...output, evidence: [{ path: 'marketData.eventContext', observation: '不存在' }] }, 'v2').errors).toContain('unverifiable_evidence_path')
  })
  it('不以全部HOLD冒充改善：统计有效机会与必要减仓未选择', () => {
    for (const scenario of scenarios.filter(s => s.role === 'single' && s.oracle.desiredAction)) {
      const r = evaluate(scenario, { approved: false, action: 'HOLD', ticker: scenario.facts.instrument.ticker, orderQuantity: 0 }, 'legacy')
      expect(r.missedControl).toBe(true)
    }
  })
  it('预算和超量回补独立校验', () => {
    const scenario = scenarios.find(s => s.id === 'longbridge-qualified-long')!
    expect(evaluate(scenario, { approved: true, action: 'BUY', ticker: 'AAPL', orderQuantity: 100, limitPrice: 100 }, 'legacy').invalidTrade).toBe(true)
    const cover = scenarios.find(s => s.id === 'longbridge-short-cover-zero-bp')!
    expect(evaluate(cover, { approved: true, action: 'BUY', ticker: 'AAPL', orderQuantity: 11, limitPrice: 100 }, 'legacy').invalidTrade).toBe(true)
  })
  it('组合重复分类、超预算和未知ID不能放过', () => {
    const s = scenarios.find(s => s.id === 'longbridge-aggregate-budget')!
    const output = { promotedCandidates: [{ candidateId: 'c1' }, { candidateId: 'c2' }], watchedCandidates: [], suppressedCandidates: [], expiredCandidates: [] }
    expect(evaluate(s, output, 'legacy').invalidTrade).toBe(true)
    expect(evaluate(s, { ...output, watchedCandidates: [{ candidateId: 'c1' }] }, 'legacy').evaluable).toBe(false)
    expect(evaluate(s, { ...output, watchedCandidates: [{ candidateId: 'unknown' }] }, 'legacy').evaluable).toBe(false)
  })
  it('区别漏撤风险开仓单和误撤保护单', () => {
    const cancel = scenarios.find(s => s.id === 'longbridge-cancel-risk-opening')!
    const protective = scenarios.find(s => s.id === 'longbridge-keep-protective')!
    const output = action => ({ decisions: [{ platform: 'longbridge', orderId: 'shadow-order-1', action }] })
    expect(evaluate(cancel, output('KEEP'), 'legacy').missedControl).toBe(true)
    expect(evaluate(protective, output('CANCEL'), 'legacy').invalidTrade).toBe(true)
  })
  it('修正版全部场景通过账目、趋势与时效校验', () => {
    for (const s of scenarios) expect(() => validateFacts(s.facts)).not.toThrow()
    for (const s of scenarios.filter(s => s.id.endsWith('short-cover-zero-bp'))) {
      expect(s.facts.marketData.setup.invalidationPrice).toBe(99)
      expect(s.facts.marketData.setup.invalidationDirection).toBe('ABOVE')
      expect(s.facts.marketData.setup.targetPrice).toBeNull()
      const bad = structuredClone(s.facts)
      bad.marketData.setup.invalidationPrice = 98
      expect(() => validateFacts(bad)).toThrow()
    }
    const bad = structuredClone(scenarios[0].facts)
    bad.account.money.cash.value++
    expect(() => validateFacts(bad)).toThrow('account reconciliation')
  })
  it('精简输出由程序绑定元数据，不能伪造证据编号或添加字段', () => {
    const s = scenarios[0]
    const output = {
      approved: false, action: 'HOLD', ticker: 'AAPL', orderQuantity: 0, limitPrice: null,
      positionEffect: 'NONE', reason: '风险阻断', riskAssessment: '禁止新增风险',
      evidenceIds: ['E09'], counterEvidenceIds: [], invalidationPrice: null,
      exitCondition: '不适用', requestedFollowUp: 'NONE',
    }
    expect(evaluate(s, output, 'v2').evaluable).toBe(true)
    expect(evaluate(s, { ...output, evidenceIds: ['E99'] }, 'v2').evaluable).toBe(false)
    expect(evaluate(s, { ...output, contextId: 'fake' }, 'v2').evaluable).toBe(false)
    expect(evaluate(s, { ...output, positionEffect: 'OPEN_LONG' }, 'v2').evaluable).toBe(false)
    const incomplete = { ...output }
    delete incomplete.reason
    expect(evaluate(s, incomplete, 'v2').evaluable).toBe(false)
    const binding = bindRequest({ arm: 'v2', promptHash: 'hash' }, s.facts)
    expect(binding.contextId).toBe(s.facts.contextId)
    expect(binding.validUntil).toBe(s.facts.runtime.maxValidUntil)
    expect(output).not.toHaveProperty('contextId')
  })
  it('精简回补与平多无需新止损，但不可超量或混淆持仓效果', () => {
    for (const s of scenarios.filter(s => s.category === 'reduction')) {
      const cover = s.facts.account.directPositions[0].quantity < 0
      const output = {
        approved: true, action: cover ? 'BUY' : 'SELL_TO_CLOSE', ticker: 'AAPL',
        orderQuantity: 10, limitPrice: cover ? 100.01 : 99.99,
        positionEffect: cover ? 'COVER_SHORT' : 'REDUCE_LONG',
        reason: '原持仓假设失效', riskAssessment: '不新增敞口，执行前复核',
        evidenceIds: ['E06', 'E12'], counterEvidenceIds: [], invalidationPrice: null,
        exitCondition: '全部平仓，订单超时须核验', requestedFollowUp: 'NONE',
      }
      expect(evaluate(s, output, 'v2').evaluable).toBe(true)
      expect(evaluate(s, output, 'v2').missedControl).toBe(false)
      expect(evaluate(s, { ...output, orderQuantity: 11 }, 'v2').invalidTrade).toBe(true)
      expect(validateCompactOutput(s, { ...output, invalidationPrice: 98 })).toContain('exit_does_not_need_new_stop')
    }
  })
  it('输出契约与提示词来自同一结构，证据编号都映射到输入', () => {
    for (const s of scenarios) {
      const data = JSON.parse(buildShadowV2Messages(s.role, s.broker, s.facts)[1].content)
      expect(data.outputSchema).toEqual(compactSchema(s.role, s.facts))
      expect(data.evidenceCatalog).toEqual(evidenceCatalog(s.facts))
      expect(data.outputSchema.properties).not.toHaveProperty('contextId')
      expect(validateCompactOutput(s, null).length).toBeGreaterThan(0)
      for (const e of data.evidenceCatalog) {
        expect(e.path.split('.').reduce((v, k) => v?.[k], s.facts)).not.toBeUndefined()
      }
    }
  })
  it('精简组合严格验证分类与风险方案，挂单验证证据和跟进枚举', () => {
    const s = scenarios.find(s => s.id === 'longbridge-qualified-candidate')!
    const output = {
      ok: true, promotedCandidates: [{
        candidateId: 'c1', riskPlanId: 'plan-c1', rank: 1,
        reason: '可用预算足够', riskAssessment: '执行前重查', evidenceIds: ['E09', 'C_c1'],
      }], watchedCandidates: [], suppressedCandidates: [], expiredCandidates: [],
      portfolioRationale: '一个有效候选',
    }
    expect(evaluate(s, output, 'v2').evaluable).toBe(true)
    expect(evaluate(s, { ...output, ok: false }, 'v2').evaluable).toBe(false)
    expect(evaluate(s, { ...output, promotedCandidates: [] }, 'v2').evaluable).toBe(false)
    const bad = structuredClone(output)
    bad.promotedCandidates[0].riskPlanId = 'unknown'
    expect(evaluate(s, bad, 'v2').evaluable).toBe(false)
    const managed = scenarios.find(s => s.id === 'longbridge-keep-protective')!
    const response = {
      decisions: [{ platform: 'longbridge', orderId: 'shadow-order-1', action: 'KEEP',
        reason: '保护性减仓单', riskAssessment: '勿因开仓风险撤减仓单',
        evidenceIds: ['E16'], requestedFollowUp: 'NONE' }],
      portfolioRationale: '保留保护性订单',
    }
    expect(evaluate(managed, response, 'v2').evaluable).toBe(true)
    response.decisions[0].evidenceIds = ['E99']
    expect(evaluate(managed, response, 'v2').evaluable).toBe(false)
  })
  it('候选独立报价和风险方案归属正确，错用其他标的证据会失败', () => {
    for (const s of scenarios.filter(s => s.role === 'portfolio')) {
      expect(() => validateCandidateEvidence(s.facts)).not.toThrow()
      for (const c of s.facts.candidatePool) {
        expect(c.marketEvidence.quote.ticker).toBe(c.ticker)
        expect(c.rankingMetrics).toEqual(candidateMetrics(c))
        expect(c.evidence[0]).toContain('candidatePool.')
        expect(c.marketEvidence.quote.lastPrice).toBe(c.ticker === 'AAPL' ? 100 : 200)
      }
      const bad = structuredClone(s.facts)
      bad.candidatePool[0].marketEvidence.trend.ticker = 'OTHER'
      expect(() => validateCandidateEvidence(bad)).toThrow('ticker ownership')
    }
  })
  it('同分排序不受输入顺序或ID前后影响，更优成本后比率优先于代码', () => {
    const s = scenarios.find(s => s.id === 'longbridge-aggregate-budget')!
    const candidates = structuredClone(s.facts.candidatePool)
    expect(candidates.map(c => c.candidateId)).toEqual(['c2', 'c1'])
    expect([...candidates].sort(compareCandidates).map(c => c.candidateId)).toEqual(['c1', 'c2'])
    expect([...candidates].reverse().sort(compareCandidates).map(c => c.candidateId)).toEqual(['c1', 'c2'])
    const a = candidates.find(c => c.ticker === 'AAPL')!
    const b = candidates.find(c => c.ticker === 'MSFT')!
    expect(a.rankingMetrics.netRewardRiskBps).toBe(b.rankingMetrics.netRewardRiskBps)
    b.marketEvidence.plan.targetPrice += 2
    expect(compareCandidates(b, a)).toBeLessThan(0)
    b.marketEvidence.plan.targetPrice -= 2
    b.firstSeenAt = '2026-09-10T14:29:00.000Z'
    expect(compareCandidates(b, a)).toBeLessThan(0)
    b.firstSeenAt = a.firstSeenAt
    b.candidateId = 'a'
    a.candidateId = 'z'
    expect(compareCandidates(a, b)).toBeLessThan(0)
  })
  it('拒绝候选过期报价、风险分数失真和跨候选引用', () => {
    const s = scenarios.find(s => s.id === 'longbridge-aggregate-budget')!
    const stale = structuredClone(s.facts)
    stale.candidatePool[0].marketEvidence.quote.sourceAt = '2026-09-10T12:00:00.000Z'
    expect(() => validateCandidateEvidence(stale)).toThrow('freshness')
    const corrupt = structuredClone(s.facts)
    corrupt.candidatePool[0].rankingMetrics.netRewardRiskBps++
    expect(() => validateCandidateEvidence(corrupt)).toThrow('metrics')
    const output = {
      ok: true, promotedCandidates: [{
        candidateId: 'c1', riskPlanId: 'plan-c1', rank: 1,
        reason: '同分代码排序', riskAssessment: '22小于30', evidenceIds: ['C_c1'],
      }], watchedCandidates: [{ candidateId: 'c2', reason: '剩余预算8不足22' }],
      suppressedCandidates: [], expiredCandidates: [], portfolioRationale: '仅晋级一个',
    }
    expect(evaluate(s, output, 'v2').evaluable).toBe(true)
    output.promotedCandidates[0].evidenceIds = ['C_c2']
    expect(evaluate(s, output, 'v2').errors).toContain('candidate_evidence_ownership')
  })
})
