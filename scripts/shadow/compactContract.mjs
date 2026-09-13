import { compareCandidates } from './candidateEvidence.mjs'

const string = (maxLength = 180) => ({ type: 'string', minLength: 1, maxLength })
const choice = values => ({ type: 'string', enum: values })
const array = (items, maxItems = 3) => ({ type: 'array', items, maxItems })
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const nullablePrice = { type: ['number', 'null'], exclusiveMinimum: 0 }
const followUp = choice(['NONE', 'REFRESH_DATA', 'REVIEW_OPEN_ORDERS', 'REVIEW_PENDING_INTENT', 'MANUAL_REVIEW'])
export const compactVersion = 'dual-broker-compact-v2.4'

// IDs identify input facts, never evaluator expectations or recommended actions.
export function evidenceCatalog(facts) {
  const paths = [
    'runtime', 'dataQuality', 'instrument', 'account.money', 'account.financingRisk',
    'account.directPositions', 'account.derivativeExposure', 'riskPolicy', 'riskState',
    'costContext', 'marketData.trendContext', 'marketData.setup', 'marketData.bids',
    'marketData.asks', 'marketData.recentKlineBars', 'portfolioContext.orders', 'eventContext',
    'portfolioContext.relationshipData', 'candidatePool',
  ]
  const catalog = paths.filter(path => path.split('.').reduce((v, k) => v?.[k], facts) !== undefined)
    .map((path, i) => ({ id: `E${String(i + 1).padStart(2, '0')}`, path }))
  for (const [i, c] of (facts.candidatePool ?? []).entries()) {
    if (!c.marketEvidence) continue
    catalog.push({ id: `C_${c.candidateId}`, path: `candidatePool.${i}.marketEvidence`, ticker: c.ticker, candidateId: c.candidateId })
  }
  return catalog
}

export function compactSchema(role, facts) {
  const ids = array(choice(evidenceCatalog(facts).map(e => e.id)))
  const explanation = { reason: string(), riskAssessment: string(), evidenceIds: { ...ids, minItems: 1 } }
  if (role === 'single') return object({
    approved: { type: 'boolean' }, action: choice(['HOLD', 'BUY', 'SELL_SHORT', 'SELL_TO_CLOSE']),
    ticker: choice([facts.instrument.ticker]), orderQuantity: { type: 'integer', minimum: 0 },
    limitPrice: nullablePrice,
    positionEffect: choice(['NONE', 'OPEN_LONG', 'ADD_LONG', 'OPEN_SHORT', 'ADD_SHORT', 'REDUCE_LONG', 'COVER_SHORT']),
    ...explanation, counterEvidenceIds: ids, invalidationPrice: nullablePrice,
    exitCondition: string(), requestedFollowUp: followUp,
  })
  if (role === 'portfolio') {
    const candidates = facts.candidatePool ?? []
    const candidateId = choice(candidates.map(c => c.candidateId))
    const classified = array(object({ candidateId, reason: string() }), candidates.length)
    return object({
      ok: { type: 'boolean' },
      promotedCandidates: array(object({
        candidateId, riskPlanId: choice(candidates.map(c => c.riskPlanId)),
        rank: { type: 'integer', minimum: 1 }, ...explanation,
      }), candidates.length),
      watchedCandidates: classified, suppressedCandidates: classified, expiredCandidates: classified,
      portfolioRationale: string(),
    })
  }
  if (role === 'managed') return object({
    decisions: array(object({
      platform: choice([facts.runtime.broker]), orderId: choice(facts.portfolioContext.orders.map(o => o.orderId)),
      action: choice(['KEEP', 'CANCEL']), ...explanation, requestedFollowUp: followUp,
    }), facts.portfolioContext.orders.length),
    portfolioRationale: string(),
  })
  throw new Error('Unknown compact role')
}

// Validates exactly the schema vocabulary generated above; unsupported keywords fail closed.
export function validateSchema(value, schema, path = '$') {
  const errors = []
  const allowed = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'exclusiveMinimum'])
  if (Object.keys(schema).some(k => !allowed.has(k))) throw new Error('Unsupported schema vocabulary')
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (!types.some(t => t === type || (t === 'integer' && Number.isInteger(value)))) return [`${path}:type`]
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}:enum`)
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}:required`)
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}:extra`)
      } else errors.push(...validateSchema(item, schema.properties[key], `${path}.${key}`))
    }
  } else if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(`${path}:length`)
    value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${path}[${i}]`)))
  } else if (type === 'string') {
    const length = Array.from(value).length
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) errors.push(`${path}:length`)
  } else if (type === 'number') {
    if (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value <= (schema.exclusiveMinimum ?? -Infinity)) errors.push(`${path}:range`)
  }
  return errors
}

export function validateCompactOutput(scenario, output) {
  const f = scenario.facts
  const errors = validateSchema(output, compactSchema(scenario.role, f))
  if (errors.length) return errors
  if (scenario.role === 'single') {
    const p = f.account.directPositions.find(p => p.ticker === output.ticker)
    const q = p?.quantity ?? 0
    const expected = output.action === 'HOLD' ? 'NONE'
      : output.action === 'SELL_TO_CLOSE' ? 'REDUCE_LONG'
        : output.action === 'BUY' ? q < 0 ? 'COVER_SHORT' : q > 0 ? 'ADD_LONG' : 'OPEN_LONG'
          : q < 0 ? 'ADD_SHORT' : 'OPEN_SHORT'
    if (output.positionEffect !== expected) errors.push('position_effect_mismatch')
    if (output.approved !== (output.action !== 'HOLD')) errors.push('approval_mismatch')
    if (output.action === 'HOLD' && (output.orderQuantity !== 0 || output.limitPrice !== null || output.invalidationPrice !== null)) errors.push('hold_contract')
    const opening = ['OPEN_LONG', 'ADD_LONG', 'OPEN_SHORT', 'ADD_SHORT'].includes(expected)
    if (opening) {
      if (!(output.invalidationPrice > 0) ||
        (output.action === 'BUY' ? output.invalidationPrice >= output.limitPrice : output.invalidationPrice <= output.limitPrice)) errors.push('invalid_invalidation')
    } else if (output.invalidationPrice !== null) errors.push('exit_does_not_need_new_stop')
  } else if (scenario.role === 'portfolio') {
    const promoted = output.promotedCandidates
    if (!output.ok && promoted.length) errors.push('invalid_review_approval')
    const classified = ['promotedCandidates', 'watchedCandidates', 'suppressedCandidates', 'expiredCandidates'].flatMap(k => output[k].map(c => c.candidateId))
    if (classified.length !== f.candidatePool.length || new Set(classified).size !== classified.length) errors.push('classification')
    promoted.forEach((c, i) => {
      if (c.rank !== i + 1 || c.riskPlanId !== f.candidatePool.find(p => p.candidateId === c.candidateId)?.riskPlanId) errors.push('invalid_risk_plan_or_rank')
      if (f.schemaVersion === 'shadow-facts-v2.4') {
        if (!c.evidenceIds.includes(`C_${c.candidateId}`) ||
          c.evidenceIds.some(id => id.startsWith('C_') && id !== `C_${c.candidateId}`)) errors.push('candidate_evidence_ownership')
        if (i > 0 && compareCandidates(
          f.candidatePool.find(p => p.candidateId === promoted[i - 1].candidateId),
          f.candidatePool.find(p => p.candidateId === c.candidateId),
        ) > 0) errors.push('candidate_rank_order')
      }
    })
  }
  return errors
}

export function bindRequest(job, facts) {
  return {
    contextId: facts.contextId, policyVersion: facts.runtime.policyVersion,
    promptVersion: job.arm === 'v2' ? facts.schemaVersion === 'shadow-facts-v2.3' ? 'dual-broker-compact-v2.3' : compactVersion : job.arm,
    promptHash: job.promptHash, validUntil: facts.runtime.maxValidUntil,
    source: 'request-runner', ordersEnabled: false,
  }
}
