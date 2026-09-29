import type {
  ContextEnvelope,
  Evidence,
  ModelRunResult,
} from '../../../packages/domain/src/contracts.js'
import type { ResolvedTradingDecision } from './tradingDecisionAuthority.js'

const evidenceKinds = new Set<Evidence['kind']>([
  'ACCOUNT',
  'POSITION',
  'QUOTE',
  'TREND',
  'ORDER',
  'RISK',
  'USER',
])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return values.length > 0 ? values : fallback
}

function evidenceList(value: unknown, allowedIds?: Set<string>): Evidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): Evidence[] => {
    const entry = record(item)
    if (
      !entry
      || typeof entry.id !== 'string'
      || (allowedIds !== undefined && !allowedIds.has(entry.id))
      || typeof entry.kind !== 'string'
      || !evidenceKinds.has(entry.kind as Evidence['kind'])
      || typeof entry.summary !== 'string'
    ) {
      return []
    }
    return [{
      id: entry.id.slice(0, 80),
      kind: entry.kind as Evidence['kind'],
      summary: entry.summary.slice(0, 300),
      sourceAt: typeof entry.sourceAt === 'string' ? entry.sourceAt : null,
    }]
  }).slice(0, 10)
}

function catalogEvidenceIds(context: ContextEnvelope): Set<string> | undefined {
  const catalog = context.decisionContext?.evidenceCatalog
  if (!Array.isArray(catalog)) return undefined
  return new Set(catalog.flatMap(item => {
    const id = record(item)?.id
    return typeof id === 'string' ? [id] : []
  }))
}

function contextSourceValidUntil(context: ContextEnvelope): string | null {
  const value = context.decisionContext?.temporalBoundary.sourceValidUntil
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function modelGapList(value: unknown): string[] {
  return stringList(value, []).filter(gap =>
    !/(次(交易)?日|未来).*(开盘|跳空).*(缺|无法|未知|未提供)/.test(gap))
}

function validSourceTime(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null
}

function symbolsIn(items: unknown[]): Set<string> {
  return new Set(items.flatMap(item => {
    const symbol = record(item)?.symbol
    return typeof symbol === 'string' ? [symbol] : []
  }))
}

function hasBlockingMarketGap(
  context: ContextEnvelope,
  symbol: string,
  requestedSymbols: string[],
): boolean {
  const structuredBlocking = context.decisionContext?.gapCatalog.some(item => {
    const entry = record(item)
    if (entry?.severity !== 'BLOCKING') return false
    const summary = typeof entry.summary === 'string' ? entry.summary : ''
    const referencedSymbols = requestedSymbols.filter(item => summary.includes(item))
    return referencedSymbols.length === 0 || referencedSymbols.includes(symbol)
  }) ?? false
  if (structuredBlocking) return true
  const quoteSymbols = symbolsIn(context.quotes)
  const trendSymbols = symbolsIn(context.minuteBars)
  return !quoteSymbols.has(symbol) || !trendSymbols.has(symbol)
}

function normalizedSignal(
  value: unknown,
  authority: ResolvedTradingDecision,
  context: ContextEnvelope,
): NonNullable<ModelRunResult['signal']> | null {
  const signal = record(value)
  if (
    !signal
    || typeof signal.symbol !== 'string'
    || !authority.requestedSymbols.includes(signal.symbol)
    || (signal.action !== 'BUY' && signal.action !== 'SELL' && signal.action !== 'HOLD')
    || typeof signal.confidence !== 'number'
    || signal.confidence < 0
    || signal.confidence > 1
  ) return null
  let positionQuantity = 0
  for (const item of context.positions) {
    const position = record(item)
    if (!position || position.symbol !== signal.symbol) continue
    const quantity = typeof position.quantity === 'number'
      ? position.quantity
      : Number(position.quantity)
    if (Number.isFinite(quantity)) positionQuantity += quantity
  }
  const intent = signal.action === 'HOLD'
    ? 'HOLD'
    : signal.action === 'BUY'
      ? positionQuantity < 0 ? 'BUY_TO_COVER' : 'BUY'
      : positionQuantity > 0 ? 'SELL_TO_CLOSE' : 'SELL_SHORT'
  return {
    symbol: signal.symbol,
    action: signal.action,
    intent,
    confidence: signal.confidence,
  }
}

function normalizedProposedOrder(
  value: unknown,
  signal: NonNullable<ModelRunResult['signal']>,
): NonNullable<ModelRunResult['proposedOrder']> | null {
  const order = record(value)
  const expectedAction = signal.intent
  if (
    !order
    || signal.action === 'HOLD'
    || order.symbol !== signal.symbol
    || order.action !== expectedAction
    || typeof order.quantity !== 'string'
    || !/^[1-9][0-9]*$/.test(order.quantity)
    || typeof order.limitPrice !== 'string'
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(order.limitPrice)
    || Number(order.limitPrice) <= 0
  ) return null
  return {
    symbol: signal.symbol,
    action: order.action as NonNullable<ModelRunResult['proposedOrder']>['action'],
    quantity: order.quantity,
    limitPrice: order.limitPrice,
  }
}

function normalizedPortfolioReview(
  value: unknown,
  authority: ResolvedTradingDecision,
): NonNullable<ModelRunResult['portfolioReview']> | null {
  if (!Array.isArray(value) || value.length !== authority.candidates.length) return null
  const allowed = new Map(authority.candidates.map(item => [item.candidateId, item]))
  const seen = new Set<string>()
  const output: NonNullable<ModelRunResult['portfolioReview']> = []
  for (const item of value) {
    const entry = record(item)
    const candidateId = entry?.candidateId
    const status = entry?.status
    const rank = entry?.rank
    const reason = entry?.reason
    if (
      typeof candidateId !== 'string'
      || !allowed.has(candidateId)
      || seen.has(candidateId)
      || (status !== 'PROMOTED' && status !== 'WATCH'
        && status !== 'SUPPRESSED' && status !== 'EXPIRED')
      || (rank !== null && (!Number.isInteger(rank) || Number(rank) < 1))
      || typeof reason !== 'string'
      || reason.length === 0
    ) return null
    seen.add(candidateId)
    output.push({
      candidateId,
      status,
      rank: rank === null ? null : Number(rank),
      reason: reason.slice(0, 300),
    })
  }
  return output
}

function normalizedManagedOrderReview(
  value: unknown,
  context: ContextEnvelope,
): NonNullable<ModelRunResult['managedOrderReview']> | null {
  if (!Array.isArray(value)) return null
  const knownIntentIds = new Set(context.openOrders.flatMap(item => {
    const order = record(item)
    return typeof order?.intentId === 'string' ? [order.intentId] : []
  }))
  const seen = new Set<string>()
  const output: NonNullable<ModelRunResult['managedOrderReview']> = []
  for (const item of value) {
    const entry = record(item)
    if (
      typeof entry?.intentId !== 'string'
      || !knownIntentIds.has(entry.intentId)
      || seen.has(entry.intentId)
      || (entry.action !== 'KEEP' && entry.action !== 'CANCEL_REMAINDER')
      || typeof entry.reason !== 'string'
      || entry.reason.length === 0
    ) return null
    seen.add(entry.intentId)
    output.push({
      intentId: entry.intentId,
      action: entry.action,
      reason: entry.reason.slice(0, 300),
    })
  }
  return output
}

export function normalizeModelResult(
  value: unknown,
  context: ContextEnvelope,
  authority: ResolvedTradingDecision | null = null,
): ModelRunResult {
  const result = record(value) ?? {}
  const allowedEvidenceIds = catalogEvidenceIds(context)
  const evidence = evidenceList(result.evidence, allowedEvidenceIds)
  const contextGaps = context.dataGaps
  const modelGaps = modelGapList(result.dataGaps)
  const dataGaps = [...new Set([...contextGaps, ...modelGaps])].slice(0, 100)
  let responseType: ModelRunResult['responseType'] = 'HOLD'
  let signal: NonNullable<ModelRunResult['signal']> | null = null
  let proposedOrder: NonNullable<ModelRunResult['proposedOrder']> | null = null
  let portfolioReview: NonNullable<ModelRunResult['portfolioReview']> | null = null
  let managedOrderReview: NonNullable<ModelRunResult['managedOrderReview']> | null = null
  const hasVerifiableEvidence = evidence.length > 0
  if (result.responseType === 'ERROR') {
    responseType = 'ERROR'
  } else if (!authority) {
    responseType = result.responseType === 'RESEARCH' && dataGaps.length === 0
      ? 'RESEARCH'
      : 'HOLD'
  } else if (authority.role === 'SINGLE_DECISION') {
    const symbol = authority.requestedSymbols[0]!
    const proposed = normalizedSignal(result.signal, authority, context)
    signal = hasVerifiableEvidence
      && !hasBlockingMarketGap(context, symbol, authority.requestedSymbols)
      && proposed
      ? proposed
      : { symbol, action: 'HOLD', intent: 'HOLD', confidence: 0 }
    if (signal.action === 'BUY' || signal.action === 'SELL') {
      proposedOrder = normalizedProposedOrder(result.proposedOrder, signal)
      responseType = authority.executionMode === 'CANDIDATE_POOL' ? 'CANDIDATE' : 'SIGNAL'
    }
  } else if (
    !authority.requestedSymbols.some(symbol =>
      hasBlockingMarketGap(context, symbol, authority.requestedSymbols))
    && hasVerifiableEvidence
    && authority.role === 'PORTFOLIO_REVIEW'
  ) {
    portfolioReview = normalizedPortfolioReview(result.portfolioReview, authority)
    if (portfolioReview) responseType = 'CANDIDATE'
  } else if (hasVerifiableEvidence && authority.role === 'MANAGED_ORDER_REVIEW') {
    managedOrderReview = normalizedManagedOrderReview(result.managedOrderReview, context)
    if (managedOrderReview) responseType = 'HOLD'
  }
  const safeEvidence = evidence.length > 0
    ? evidence
    : [{
        id: 'model-output-incomplete',
        kind: 'RISK' as const,
        summary: '模型未提供可验证证据，结果已自动降级为观望。',
        sourceAt: null,
      }]

  return {
    schemaVersion: '1.0',
    requestId: context.requestId,
    status: responseType === 'ERROR' ? 'REJECTED' : 'COMPLETED',
    responseType,
    summary: typeof result.summary === 'string' && result.summary.length > 0
      ? result.summary.slice(0, 4_000)
      : authority?.role === 'SINGLE_DECISION'
        ? `${authority.requestedSymbols.join('、')} 的模型结果不完整，已安全降级为观望。`
        : '模型结果不完整，已禁止交易并保持观望。',
    evidence: safeEvidence,
    counterEvidence: evidenceList(result.counterEvidence, allowedEvidenceIds),
    risks: stringList(result.risks, ['模型输出未完全符合结构化协议']).slice(0, 20),
    dataGaps,
    exitCondition: typeof result.exitCondition === 'string'
      ? result.exitCondition.slice(0, 500)
      : '补齐缺失数据并重新评估。',
    sourceValidUntil: contextSourceValidUntil(context)
      ?? validSourceTime(result.sourceValidUntil),
    orderIntent: null,
    proposedOrder,
    signal,
    candidate: null,
    portfolioReview,
    managedOrderReview,
  }
}
