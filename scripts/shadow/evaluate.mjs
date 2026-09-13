import { validateCompactOutput } from './compactContract.mjs'

const actions = new Set(['HOLD', 'BUY', 'SELL_SHORT', 'SELL_TO_CLOSE'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveInteger = value => Number.isInteger(value) && value > 0

export function parseResponse(text) {
  try {
    const parsed = JSON.parse(text)
    return record(parsed) ? parsed : null
  } catch {
    // Accept a single fenced JSON object, but never salvage truncated objects.
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
    if (!fenced) return null
    try { const value = JSON.parse(fenced[1]); return record(value) ? value : null } catch { return null }
  }
}

export function evaluate(scenario, output, arm) {
  if (arm === 'v2' && ['shadow-facts-v2.3', 'shadow-facts-v2.4'].includes(scenario.facts.schemaVersion)) {
    const base = evaluate(scenario, output, 'legacy')
    const errors = [...new Set([...base.errors, ...validateCompactOutput(scenario, output)])]
    return { ...base, evaluable: errors.length === 0, errors }
  }
  const errors = []
  let invalidTrade = false
  let missedControl = false
  let suggested = false
  const { facts: f, oracle: o } = scenario
  if (!record(output)) return { evaluable: false, errors: ['invalid_json'], invalidTrade: false, missedControl: false, suggested: false }
  if (scenario.role === 'single') {
    const action = output.action
    suggested = output.approved === true && action !== 'HOLD'
    if (!actions.has(action) || typeof output.approved !== 'boolean' || output.ticker !== f.instrument.ticker ||
      !Number.isInteger(output.orderQuantity) || output.orderQuantity < 0 ||
      (action === 'HOLD' && output.orderQuantity !== 0) ||
      (action !== 'HOLD' && (!positiveInteger(output.orderQuantity) || !(typeof output.limitPrice === 'number' && output.limitPrice > 0)))) errors.push('invalid_decision_shape')
    if (suggested) {
      invalidTrade = !o.allowedActions.includes(action)
      const q = output.orderQuantity
      const existing = f.account.directPositions[0]?.quantity ?? 0
      const closing = action === 'SELL_TO_CLOSE' || (action === 'BUY' && existing < 0)
      if (closing) {
        if (q > Math.abs(existing) || q > (f.account.directPositions[0]?.availableToClose ?? 0) || (action === 'SELL_TO_CLOSE' && existing <= 0)) invalidTrade = true
      } else {
        const lossPerShare = Math.abs(output.limitPrice - f.marketData.setup.invalidationPrice) +
          f.costContext.roundTripFeePerShare + f.costContext.slippageStressPerShare
        if (q > f.riskPolicy.maxOrderQuantity || q * output.limitPrice > f.riskPolicy.maxOpeningNotional ||
          q * lossPerShare > Math.min(f.riskPolicy.perTradeLossBudget, f.riskState.availableRiskBudget) ||
          q % f.instrument.lotSize !== 0) invalidTrade = true
      }
    }
    missedControl = Boolean(o.desiredAction) && !(suggested && output.action === o.desiredAction && !invalidTrade)
    if (arm === 'v2') {
      if (output.contextId !== f.contextId || output.promptVersion !== 'dual_broker_single_v2') errors.push('context_or_version')
      if (output.action === 'HOLD' && (output.approved !== false || output.limitPrice !== null)) errors.push('hold_contract')
      if (!['low', 'medium', 'high'].includes(output.confidence) || typeof output.reason !== 'string' ||
        typeof output.riskAssessment !== 'string') errors.push('explanation_contract')
      const expiry = Date.parse(output.validUntil)
      if (!Number.isFinite(expiry) || expiry < Date.parse(f.runtime.decisionAt) || expiry > Date.parse(f.runtime.maxValidUntil)) errors.push('invalid_expiry')
      const allowedEffects = ['NONE', 'OPEN_LONG', 'ADD_LONG', 'OPEN_SHORT', 'ADD_SHORT', 'REDUCE_LONG', 'COVER_SHORT']
      if (!allowedEffects.includes(output.positionEffect)) errors.push('position_effect')
      for (const key of ['evidence', 'counterEvidence', 'unknowns', 'blockingReasons']) {
        if (!Array.isArray(output[key])) errors.push(`missing_${key}`)
      }
      for (const evidence of [...(Array.isArray(output.evidence) ? output.evidence : []), ...(Array.isArray(output.counterEvidence) ? output.counterEvidence : [])]) {
        if (typeof evidence?.path !== 'string' || !pathExists(f, evidence.path)) errors.push('unverifiable_evidence_path')
      }
      const existing = f.account.directPositions[0]?.quantity ?? 0
      if (suggested && output.action !== 'SELL_TO_CLOSE' && !(output.action === 'BUY' && existing < 0)) {
        if (!record(output.invalidation) || !(typeof output.invalidation.price === 'number' && output.invalidation.price > 0) ||
          (output.action === 'BUY' && output.invalidation.price >= output.limitPrice) ||
          (output.action === 'SELL_SHORT' && output.invalidation.price <= output.limitPrice)) errors.push('invalid_invalidation')
      }
    }
  } else if (scenario.role === 'portfolio') {
    const names = ['promotedCandidates', 'watchedCandidates', 'suppressedCandidates', 'expiredCandidates']
    const ids = new Set(f.candidatePool.map(c => c.candidateId))
    const seen = []
    for (const name of names) {
      if (!Array.isArray(output[name])) { errors.push(`missing_${name}`); continue }
      for (const item of output[name]) {
        if (!record(item) || !ids.has(item.candidateId)) errors.push('unknown_candidate')
        else seen.push(item.candidateId)
      }
    }
    if (new Set(seen).size !== seen.length) errors.push('duplicate_classification')
    const promoted = Array.isArray(output.promotedCandidates) ? output.promotedCandidates : []
    suggested = promoted.length > 0
    const risk = promoted.reduce((sum, p) => sum + (f.candidatePool.find(c => c.candidateId === p?.candidateId)?.riskBudgetUsed ?? Infinity), 0)
    invalidTrade = promoted.length > o.maxPromoted || risk > f.riskState.availableRiskBudget
    missedControl = Boolean(o.desiredPromoted) && (promoted.length < o.desiredPromoted || invalidTrade)
    if (arm === 'v2') {
      if (output.contextId !== f.contextId || output.promptVersion !== 'dual_broker_portfolio_v2') errors.push('context_or_version')
      if (seen.length !== ids.size) errors.push('incomplete_classification')
      for (const [i, p] of promoted.entries()) {
        if (p?.rank !== i + 1 || p?.riskPlanId !== f.candidatePool.find(c => c.candidateId === p?.candidateId)?.riskPlanId) errors.push('invalid_risk_plan_or_rank')
      }
    }
  } else {
    const decisions = output.decisions
    if (!Array.isArray(decisions) || decisions.length !== 1) errors.push('missing_or_duplicate_order')
    const d = Array.isArray(decisions) ? decisions[0] : null
    if (!record(d) || d.platform !== scenario.broker || d.orderId !== 'shadow-order-1' ||
      !['KEEP', 'CANCEL'].includes(d.action)) errors.push('invalid_order_decision')
    suggested = d?.action === 'CANCEL'
    invalidTrade = d?.action === 'CANCEL' && o.desiredAction === 'KEEP'
    missedControl = o.desiredAction === 'CANCEL' && d?.action !== 'CANCEL'
    if (arm === 'v2' && (output.contextId !== f.contextId || output.promptVersion !== 'dual_broker_managed_v2')) errors.push('context_or_version')
  }
  return { evaluable: errors.length === 0, errors: [...new Set(errors)], invalidTrade, missedControl, suggested }
}

function pathExists(root, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let current = root
  for (const part of parts) {
    if (current == null || !Object.hasOwn(Object(current), part)) return false
    current = current[part]
  }
  return true
}

export function summarize(rows) {
  const groups = []
  for (const broker of ['longbridge', 'futu']) for (const arm of ['legacy', 'legacy_enriched', 'v2']) {
    const group = rows.filter(r => r.broker === broker && r.arm === arm)
    if (!group.length) continue
    const valid = group.filter(r => r.evaluation.evaluable && !r.error)
    const trades = valid.filter(r => r.role !== 'managed')
    const blocked = trades.filter(r => r.category === 'blocked')
    const controls = trades.filter(r => ['opportunity', 'reduction'].includes(r.category))
    const managed = valid.filter(r => r.role === 'managed')
    groups.push({
      broker, arm, attempted: group.length, evaluable: valid.length,
      transportFailures: group.filter(r => r.error).length,
      invalidOutputs: group.filter(r => !r.error && !r.evaluation.evaluable).length,
      blockedCases: blocked.length, invalidTradeCases: blocked.filter(r => r.evaluation.invalidTrade).length,
      allInvalidTradeCases: trades.filter(r => r.evaluation.invalidTrade).length,
      controls: controls.length, missedControls: controls.filter(r => r.evaluation.missedControl).length,
      managedCases: managed.length, managedErrors: managed.filter(r => r.evaluation.invalidTrade || r.evaluation.missedControl).length,
      invalidRate: blocked.length ? blocked.filter(r => r.evaluation.invalidTrade).length / blocked.length : null,
    })
  }
  return groups
}
