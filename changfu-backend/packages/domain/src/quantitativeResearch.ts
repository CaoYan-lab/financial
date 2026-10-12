export const QUANT_PROMPT_VERSION = 'top30-quant-selection-v4'
export const QUANT_SCORING_VERSION = 'top30-investment-price-plan-v3'
export const QUANT_POOL_CAPACITY = 30

export const QUANT_DIMENSION_LIMITS = {
  fundamentals: 30,
  filings: 20,
  shortActivity: 10,
  priceTrend: 25,
  macroFit: 15,
} as const

export type QuantitativeDimension = keyof typeof QUANT_DIMENSION_LIMITS
export type QuantitativeAvailability = 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'
export type QuantitativeResearchSignal = 'BUY' | 'WATCH' | 'AVOID'
export type QuantitativeLayer = QuantitativeDimension
export type QuantitativeSource = 'SEC' | 'FINRA' | 'FUTU' | 'LONGBRIDGE'
export type QuantitativeEntryDecision =
  | 'BUY_NOW'
  | 'WAIT_PULLBACK'
  | 'WAIT_BREAKOUT'
  | 'NO_ENTRY'
export type QuantitativePricePlanConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

export type QuantitativeEvidence = {
  id: string
  layer: QuantitativeLayer
  source: QuantitativeSource
  title: string
  capturedAt: string
  asOf: string | null
  value: string | number | boolean | null
  metadata?: Record<string, string | number | boolean | null>
}

export type QuantitativeObservation = {
  requestId: string
  rank: number
  symbol: string
  ticker: string
  displayName: string
  providerId: 'FUTU' | 'LONGBRIDGE'
  capturedAt: string
  currentPrice: number | null
  quoteFreshness: 'FRESH' | 'STALE' | 'UNAVAILABLE'
  adjustedDailyBarCount: number
  technicalPriceInputs: QuantitativeTechnicalPriceInputs | null
  evidence: QuantitativeEvidence[]
  dataGaps: string[]
}

export type QuantitativeTechnicalPriceInputs = {
  atr14: number | null
  support20: number | null
  support60: number | null
  resistance20: number | null
  resistance60: number | null
  resistance252: number | null
  realizedVolatility30: number | null
}

export type QuantitativeDimensionScore = {
  score: number | null
  availability: QuantitativeAvailability
  assessment: string
}

export type QuantitativePricePlan = {
  entryDecision: QuantitativeEntryDecision
  entryPriceLow: number | null
  entryPriceHigh: number | null
  takeProfitLow: number | null
  takeProfitHigh: number | null
  stopLossPrice: number | null
  entryExpiryTradingDays: number | null
  expectedHoldingDaysLow: number | null
  expectedHoldingDaysHigh: number | null
  riskRewardRatio: number | null
  confidence: QuantitativePricePlanConfidence
  rationale: string
  exitConditions: string[]
}

export type QuantitativeScoreResult = {
  schemaVersion: '3.0'
  dimensions: Record<QuantitativeDimension, QuantitativeDimensionScore>
  researchSignal: QuantitativeResearchSignal
  pricePlan: QuantitativePricePlan
  signalReason: string
  supportingAssessment: string
  opposingAssessment: string
  summary: string
  evidenceIds: string[]
  counterEvidenceIds: string[]
  risks: string[]
  dataGaps: string[]
  invalidationConditions: string[]
}

export type QuantitativeItemStatus = 'COMPLETED' | 'REJECTED' | 'UNAVAILABLE'
export type QuantitativeCandidateStatus = 'ELIGIBLE' | 'DATA_INSUFFICIENT' | 'REJECTED'

export type QuantitativeItemResult = {
  requestId: string
  rank: number
  finalRank: number | null
  symbol: string
  ticker: string
  displayName: string
  providerId: 'FUTU' | 'LONGBRIDGE'
  status: QuantitativeItemStatus
  candidateStatus: QuantitativeCandidateStatus
  totalScore: number | null
  coverageWeight: number
  dimensions: Record<QuantitativeDimension, QuantitativeDimensionScore> | null
  researchSignal: QuantitativeResearchSignal | null
  pricePlan: QuantitativePricePlan | null
  signalReason: string
  supportingAssessment: string
  opposingAssessment: string
  summary: string
  evidenceIds: string[]
  counterEvidenceIds: string[]
  risks: string[]
  dataGaps: string[]
  invalidationConditions: string[]
  capturedAt: string
  rejectionReason: string | null
}

export type QuantitativeReportSummary = {
  generatedAt: string
  providerId: 'FUTU' | 'LONGBRIDGE'
  promptVersion: string
  scoringVersion: string
  completedCount: number
  rejectedCount: number
  unavailableCount: number
  candidateCount: number
  dataGapCount: number
  topFive: QuantitativeItemResult[]
  watchlist: QuantitativeItemResult[]
  bottomFive: QuantitativeItemResult[]
  insufficient: QuantitativeItemResult[]
  items: QuantitativeItemResult[]
  markdown: string
}

export type QuantitativeComparableReport = {
  runId: string
  providerId: 'FUTU' | 'LONGBRIDGE'
  promptVersion: string
  scoringVersion: string
  items: QuantitativeItemResult[]
}

export type QuantitativeReportComparison = {
  leftRunId: string
  rightRunId: string
  versionWarning: boolean
  commonTickers: string[]
  leftOnlyTickers: string[]
  rightOnlyTickers: string[]
  topFiveOverlap: string[]
  topFiveOverlapRatio: number
  spearmanRankCorrelation: number | null
  maximumRankDifference: number | null
  items: Array<{
    ticker: string
    left: QuantitativeItemResult | null
    right: QuantitativeItemResult | null
    totalScoreDifference: number | null
    finalRankDifference: number | null
  }>
}

export type QuantitativeScoredInput = {
  observation: QuantitativeObservation
  scoreResult?: unknown
  unavailableReason?: string
  rejectionReason?: string
}

export type QuantitativeScoreValidation =
  | { ok: true; value: QuantitativeScoreResult; totalScore: number; coverageWeight: number }
  | { ok: false; reason: string }

const dimensionKeys = Object.keys(QUANT_DIMENSION_LIMITS) as QuantitativeDimension[]
const resultKeys = new Set([
  'schemaVersion',
  'dimensions',
  'researchSignal',
  'pricePlan',
  'signalReason',
  'supportingAssessment',
  'opposingAssessment',
  'summary',
  'evidenceIds',
  'counterEvidenceIds',
  'risks',
  'dataGaps',
  'invalidationConditions',
])

export function validateQuantitativeScoreResult(
  input: unknown,
  evidenceCatalog: readonly QuantitativeEvidence[],
  observation: Pick<QuantitativeObservation, 'currentPrice' | 'technicalPriceInputs'>,
): QuantitativeScoreValidation {
  if (!isRecord(input) || hasUnexpectedKeys(input, resultKeys)) {
    return invalid('MODEL_RESULT_SHAPE_INVALID')
  }
  if (input.schemaVersion !== '3.0' || !isRecord(input.dimensions)) {
    return invalid('MODEL_RESULT_SCHEMA_INVALID')
  }
  if (hasUnexpectedKeys(input.dimensions, new Set(dimensionKeys))) {
    return invalid('MODEL_DIMENSIONS_INVALID')
  }

  const dimensions = {} as Record<QuantitativeDimension, QuantitativeDimensionScore>
  let totalScore = 0
  let coverageWeight = 0
  for (const key of dimensionKeys) {
    const value = input.dimensions[key]
    if (
      !isRecord(value)
      || hasUnexpectedKeys(value, new Set(['score', 'availability', 'assessment']))
    ) {
      return invalid(`MODEL_DIMENSION_INVALID:${key}`)
    }
    const availability = value.availability
    if (
      availability !== 'AVAILABLE'
      && availability !== 'PARTIAL'
      && availability !== 'UNAVAILABLE'
    ) {
      return invalid(`MODEL_AVAILABILITY_INVALID:${key}`)
    }
    const score = value.score
    const assessment = boundedString(value.assessment, 1, 500)
    if (assessment === null) return invalid(`MODEL_ASSESSMENT_INVALID:${key}`)
    if (availability === 'UNAVAILABLE') {
      if (score !== null) return invalid(`MODEL_UNAVAILABLE_SCORE_MUST_BE_NULL:${key}`)
    } else {
      if (
        typeof score !== 'number'
        || !Number.isInteger(score)
        || score < 0
        || score > QUANT_DIMENSION_LIMITS[key]
      ) {
        return invalid(`MODEL_SCORE_OUT_OF_RANGE:${key}`)
      }
      totalScore += score
      coverageWeight += QUANT_DIMENSION_LIMITS[key]
    }
    dimensions[key] = { score: score as number | null, availability, assessment }
  }

  const researchSignal = input.researchSignal
  if (
    researchSignal !== 'BUY'
    && researchSignal !== 'WATCH'
    && researchSignal !== 'AVOID'
  ) {
    return invalid('MODEL_RESEARCH_SIGNAL_INVALID')
  }
  const pricePlan = parsePricePlan(input.pricePlan, researchSignal, observation)
  if (typeof pricePlan === 'string') return invalid(pricePlan)
  const signalReason = boundedString(input.signalReason, 1, 2_000)
  const supportingAssessment = boundedString(input.supportingAssessment, 1, 2_000)
  const opposingAssessment = boundedString(input.opposingAssessment, 1, 2_000)
  const summary = boundedString(input.summary, 1, 2_000)
  const evidenceIds = stringArray(input.evidenceIds, 100, 128)
  const counterEvidenceIds = stringArray(input.counterEvidenceIds, 100, 128)
  const risks = stringArray(input.risks, 50, 500)
  const dataGaps = stringArray(input.dataGaps, 50, 500)
  const invalidationConditions = stringArray(input.invalidationConditions, 50, 500)
  if (
    signalReason === null
    || supportingAssessment === null
    || opposingAssessment === null
    || summary === null
    || evidenceIds === null
    || counterEvidenceIds === null
    || risks === null
    || dataGaps === null
    || invalidationConditions === null
  ) {
    return invalid('MODEL_TEXT_FIELDS_INVALID')
  }

  const catalogIds = new Set(evidenceCatalog.map(item => item.id))
  const unknownEvidence = [...evidenceIds, ...counterEvidenceIds]
    .find(id => !catalogIds.has(id))
  if (unknownEvidence) return invalid(`MODEL_EVIDENCE_NOT_FOUND:${unknownEvidence}`)

  return {
    ok: true,
    value: {
      schemaVersion: '3.0',
      dimensions,
      researchSignal,
      pricePlan,
      signalReason,
      supportingAssessment,
      opposingAssessment,
      summary,
      evidenceIds: unique(evidenceIds),
      counterEvidenceIds: unique(counterEvidenceIds),
      risks: unique(risks),
      dataGaps: unique(dataGaps),
      invalidationConditions: unique(invalidationConditions),
    },
    totalScore,
    coverageWeight,
  }
}

function parsePricePlan(
  input: unknown,
  researchSignal: QuantitativeResearchSignal,
  observation: Pick<QuantitativeObservation, 'currentPrice' | 'technicalPriceInputs'>,
): QuantitativePricePlan | string {
  const keys = new Set([
    'entryDecision',
    'entryPriceLow',
    'entryPriceHigh',
    'takeProfitLow',
    'takeProfitHigh',
    'stopLossPrice',
    'entryExpiryTradingDays',
    'expectedHoldingDaysLow',
    'expectedHoldingDaysHigh',
    'riskRewardRatio',
    'confidence',
    'rationale',
    'exitConditions',
  ])
  if (!isRecord(input) || hasUnexpectedKeys(input, keys)) {
    return 'MODEL_PRICE_PLAN_SHAPE_INVALID'
  }
  const entryDecision = input.entryDecision
  const confidence = input.confidence
  const rationale = boundedString(input.rationale, 1, 2_000)
  const exitConditions = stringArray(input.exitConditions, 20, 500)
  if (
    !['BUY_NOW', 'WAIT_PULLBACK', 'WAIT_BREAKOUT', 'NO_ENTRY'].includes(String(entryDecision))
    || !['HIGH', 'MEDIUM', 'LOW'].includes(String(confidence))
    || rationale === null
    || exitConditions === null
  ) {
    return 'MODEL_PRICE_PLAN_TEXT_INVALID'
  }
  const decision = entryDecision as QuantitativeEntryDecision
  const priceFields = [
    'entryPriceLow',
    'entryPriceHigh',
    'takeProfitLow',
    'takeProfitHigh',
    'stopLossPrice',
    'riskRewardRatio',
  ] as const
  const durationFields = [
    'entryExpiryTradingDays',
    'expectedHoldingDaysLow',
    'expectedHoldingDaysHigh',
  ] as const
  if (decision === 'NO_ENTRY') {
    if (
      researchSignal === 'BUY'
      || [...priceFields, ...durationFields].some(key => input[key] !== null)
    ) {
      return 'MODEL_PRICE_PLAN_NO_ENTRY_INVALID'
    }
  } else {
    if (researchSignal === 'AVOID') return 'MODEL_PRICE_PLAN_AVOID_MUST_BE_NO_ENTRY'
    if (decision === 'BUY_NOW' && researchSignal !== 'BUY') {
      return 'MODEL_PRICE_PLAN_BUY_NOW_REQUIRES_BUY_SIGNAL'
    }
    if (priceFields.some(key => !positiveFinite(input[key]))) {
      return 'MODEL_PRICE_PLAN_NUMBER_INVALID'
    }
    if (durationFields.some(key => !positiveInteger(input[key]))) {
      return 'MODEL_PRICE_PLAN_DURATION_INVALID'
    }
    const entryLow = input.entryPriceLow as number
    const entryHigh = input.entryPriceHigh as number
    const takeProfitLow = input.takeProfitLow as number
    const takeProfitHigh = input.takeProfitHigh as number
    const stopLoss = input.stopLossPrice as number
    const expiry = input.entryExpiryTradingDays as number
    const holdingLow = input.expectedHoldingDaysLow as number
    const holdingHigh = input.expectedHoldingDaysHigh as number
    if (
      entryLow > entryHigh
      || takeProfitLow > takeProfitHigh
      || stopLoss >= entryLow
      || takeProfitLow <= entryHigh
    ) return 'MODEL_PRICE_PLAN_ORDER_INVALID'
    if (expiry < 5 || expiry > 10 || holdingLow < 20 || holdingHigh > 60 || holdingLow > holdingHigh) {
      return 'MODEL_PRICE_PLAN_HORIZON_INVALID'
    }
    const currentPrice = observation.currentPrice
    if (!positiveFinite(currentPrice)) return 'MODEL_PRICE_PLAN_CURRENT_PRICE_MISSING'
    const technical = observation.technicalPriceInputs
    if (!hasCoreTechnicalPriceInputs(technical)) {
      return 'MODEL_PRICE_PLAN_TECHNICAL_INPUTS_MISSING'
    }
    if (
      decision === 'BUY_NOW'
      && (currentPrice < entryLow || currentPrice > entryHigh)
    ) return 'MODEL_PRICE_PLAN_BUY_NOW_OUTSIDE_ENTRY'
    if (decision === 'WAIT_PULLBACK' && entryHigh >= currentPrice) {
      return 'MODEL_PRICE_PLAN_PULLBACK_NOT_BELOW_MARKET'
    }
    if (decision === 'WAIT_BREAKOUT' && entryLow <= currentPrice) {
      return 'MODEL_PRICE_PLAN_BREAKOUT_NOT_ABOVE_MARKET'
    }
    const entryFloor = Math.max(
      0,
      Math.min(currentPrice, technical.support60 ?? technical.support20) - technical.atr14 * 2,
    )
    const entryCeiling = Math.max(
      currentPrice,
      technical.resistance60 ?? technical.resistance20,
    ) + technical.atr14 * 2
    const stopFloor = Math.max(
      0,
      Math.min(currentPrice, technical.support20, technical.support60 ?? technical.support20)
        - technical.atr14 * 3,
    )
    const targetCeiling = Math.max(
      currentPrice,
      technical.resistance20,
      technical.resistance60 ?? technical.resistance20,
      technical.resistance252 ?? technical.resistance60 ?? technical.resistance20,
    ) + technical.atr14 * 4
    if (
      entryLow < entryFloor
      || entryHigh > entryCeiling
      || stopLoss < stopFloor
      || takeProfitHigh > targetCeiling
    ) return 'MODEL_PRICE_PLAN_NOT_ANCHORED'
    const entryMidpoint = (entryLow + entryHigh) / 2
    const computedRatio = (takeProfitLow - entryMidpoint) / (entryMidpoint - stopLoss)
    if (
      !Number.isFinite(computedRatio)
      || computedRatio <= 0
      || Math.abs(computedRatio - (input.riskRewardRatio as number)) > 0.05
    ) return 'MODEL_PRICE_PLAN_RISK_REWARD_INVALID'
    if (
      confidence === 'HIGH'
      && !hasCompleteTechnicalPriceInputs(observation.technicalPriceInputs)
    ) return 'MODEL_PRICE_PLAN_HIGH_CONFIDENCE_INPUTS_MISSING'
  }
  return {
    entryDecision: decision,
    entryPriceLow: input.entryPriceLow as number | null,
    entryPriceHigh: input.entryPriceHigh as number | null,
    takeProfitLow: input.takeProfitLow as number | null,
    takeProfitHigh: input.takeProfitHigh as number | null,
    stopLossPrice: input.stopLossPrice as number | null,
    entryExpiryTradingDays: input.entryExpiryTradingDays as number | null,
    expectedHoldingDaysLow: input.expectedHoldingDaysLow as number | null,
    expectedHoldingDaysHigh: input.expectedHoldingDaysHigh as number | null,
    riskRewardRatio: input.riskRewardRatio as number | null,
    confidence: confidence as QuantitativePricePlanConfidence,
    rationale,
    exitConditions: unique(exitConditions),
  }
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function positiveInteger(value: unknown): value is number {
  return positiveFinite(value) && Number.isInteger(value)
}

function hasCompleteTechnicalPriceInputs(
  value: QuantitativeTechnicalPriceInputs | null | undefined,
): boolean {
  return value !== null
    && value !== undefined
    && positiveFinite(value.atr14)
    && positiveFinite(value.support20)
    && positiveFinite(value.support60)
    && positiveFinite(value.resistance20)
    && positiveFinite(value.resistance60)
    && positiveFinite(value.resistance252)
}

function hasCoreTechnicalPriceInputs(
  value: QuantitativeTechnicalPriceInputs | null | undefined,
): value is QuantitativeTechnicalPriceInputs & {
  atr14: number
  support20: number
  resistance20: number
} {
  return value !== null
    && value !== undefined
    && positiveFinite(value.atr14)
    && positiveFinite(value.support20)
    && positiveFinite(value.resistance20)
}

export function buildQuantitativeReport(
  inputs: QuantitativeScoredInput[],
  now = new Date(),
): QuantitativeReportSummary {
  if (inputs.length === 0) throw new Error('QUANTITATIVE_REPORT_EMPTY')
  const providerId = inputs[0]!.observation.providerId
  if (inputs.some(input => input.observation.providerId !== providerId)) {
    throw new Error('QUANTITATIVE_PROVIDER_MIXED')
  }

  const items = inputs.map(analyzeQuantitativeItem)
  const scored = items
    .filter(item => item.totalScore !== null)
    .sort(compareItems)
  scored.forEach((item, index) => {
    item.finalRank = index + 1
  })
  const eligible = scored.filter(item => item.candidateStatus === 'ELIGIBLE')
  const buyCandidates = eligible.filter(item => item.researchSignal === 'BUY')
  const watchCandidates = eligible.filter(item => item.researchSignal === 'WATCH')
  const avoidCandidates = eligible
    .filter(item => item.researchSignal === 'AVOID')
    .sort(compareItems)
  const insufficient = items
    .filter(item => item.candidateStatus !== 'ELIGIBLE')
    .sort((a, b) => a.rank - b.rank || a.ticker.localeCompare(b.ticker))
  const orderedItems = [...items].sort((a, b) => {
    if (a.finalRank !== null && b.finalRank !== null) return a.finalRank - b.finalRank
    if (a.finalRank !== null) return -1
    if (b.finalRank !== null) return 1
    return a.rank - b.rank || a.ticker.localeCompare(b.ticker)
  })
  const report = {
    generatedAt: now.toISOString(),
    providerId,
    promptVersion: QUANT_PROMPT_VERSION,
    scoringVersion: QUANT_SCORING_VERSION,
    completedCount: items.filter(item => item.status === 'COMPLETED').length,
    rejectedCount: items.filter(item => item.status === 'REJECTED').length,
    unavailableCount: items.filter(item => item.status === 'UNAVAILABLE').length,
    candidateCount: buyCandidates.length,
    dataGapCount: items.reduce((sum, item) => sum + item.dataGaps.length, 0),
    topFive: buyCandidates.slice(0, 5),
    watchlist: watchCandidates.slice(0, 5),
    bottomFive: avoidCandidates.reverse().slice(0, 5),
    insufficient,
    items: orderedItems,
  }
  return {
    ...report,
    markdown: renderQuantitativeMarkdown(report),
  }
}

export function compareQuantitativeReports(
  left: QuantitativeComparableReport,
  right: QuantitativeComparableReport,
): QuantitativeReportComparison {
  if (left.providerId === right.providerId) {
    throw new Error('QUANTITATIVE_COMPARE_PROVIDER_MUST_DIFFER')
  }
  const leftItems = new Map(left.items.map(item => [item.ticker, item]))
  const rightItems = new Map(right.items.map(item => [item.ticker, item]))
  const tickers = [...new Set([...leftItems.keys(), ...rightItems.keys()])].sort()
  const commonTickers = tickers.filter(ticker => leftItems.has(ticker) && rightItems.has(ticker))
  const leftOnlyTickers = tickers.filter(ticker => leftItems.has(ticker) && !rightItems.has(ticker))
  const rightOnlyTickers = tickers.filter(ticker => !leftItems.has(ticker) && rightItems.has(ticker))
  const leftTop = new Set(
    left.items
      .filter(item => (
        isReportBuyCandidate(item, left.scoringVersion)
        && item.finalRank !== null
      ))
      .sort((a, b) => a.finalRank! - b.finalRank!)
      .slice(0, 5)
      .map(item => item.ticker),
  )
  const rightTop = new Set(
    right.items
      .filter(item => (
        isReportBuyCandidate(item, right.scoringVersion)
        && item.finalRank !== null
      ))
      .sort((a, b) => a.finalRank! - b.finalRank!)
      .slice(0, 5)
      .map(item => item.ticker),
  )
  const topFiveOverlap = [...leftTop].filter(ticker => rightTop.has(ticker)).sort()
  const rankedPairs = commonTickers.flatMap(ticker => {
    const leftItem = leftItems.get(ticker)!
    const rightItem = rightItems.get(ticker)!
    return leftItem.finalRank !== null && rightItem.finalRank !== null
      ? [{ left: leftItem.finalRank, right: rightItem.finalRank }]
      : []
  })
  const rankDifferences = rankedPairs.map(pair => Math.abs(pair.left - pair.right))
  return {
    leftRunId: left.runId,
    rightRunId: right.runId,
    versionWarning: left.promptVersion !== right.promptVersion
      || left.scoringVersion !== right.scoringVersion,
    commonTickers,
    leftOnlyTickers,
    rightOnlyTickers,
    topFiveOverlap,
    topFiveOverlapRatio: topFiveOverlap.length / 5,
    spearmanRankCorrelation: spearman(rankedPairs),
    maximumRankDifference: rankDifferences.length > 0 ? Math.max(...rankDifferences) : null,
    items: tickers.map(ticker => {
      const leftItem = leftItems.get(ticker) ?? null
      const rightItem = rightItems.get(ticker) ?? null
      return {
        ticker,
        left: leftItem,
        right: rightItem,
        totalScoreDifference: leftItem?.totalScore !== null
          && leftItem?.totalScore !== undefined
          && rightItem?.totalScore !== null
          && rightItem?.totalScore !== undefined
          ? leftItem.totalScore - rightItem.totalScore
          : null,
        finalRankDifference: leftItem?.finalRank !== null
          && leftItem?.finalRank !== undefined
          && rightItem?.finalRank !== null
          && rightItem?.finalRank !== undefined
          ? leftItem.finalRank - rightItem.finalRank
          : null,
      }
    }),
  }
}

export function analyzeQuantitativeItem(
  input: QuantitativeScoredInput,
): QuantitativeItemResult {
  const observation = input.observation
  const observationGaps = unique(observation.dataGaps.filter(Boolean))
  if (input.unavailableReason) {
    return emptyItem(
      observation,
      'UNAVAILABLE',
      'DATA_INSUFFICIENT',
      unique([...observationGaps, input.unavailableReason]),
      input.unavailableReason,
    )
  }
  if (input.rejectionReason) {
    return emptyItem(
      observation,
      'REJECTED',
      'REJECTED',
      observationGaps,
      input.rejectionReason,
    )
  }
  const validated = validateQuantitativeScoreResult(
    input.scoreResult,
    observation.evidence,
    observation,
  )
  if (!validated.ok) {
    return emptyItem(
      observation,
      'REJECTED',
      'REJECTED',
      observationGaps,
      validated.reason,
    )
  }
  const hardGaps: string[] = []
  if (observation.currentPrice === null || observation.quoteFreshness === 'UNAVAILABLE') {
    hardGaps.push('当前报价不可用')
  } else if (observation.quoteFreshness !== 'FRESH') {
    hardGaps.push('当前报价已过期')
  }
  if (observation.adjustedDailyBarCount < 200) hardGaps.push('前复权日 K 少于 200 根')
  if (validated.value.dimensions.fundamentals.availability === 'UNAVAILABLE') {
    hardGaps.push('基本面证据不可用')
  }
  if (validated.value.dimensions.priceTrend.availability === 'UNAVAILABLE') {
    hardGaps.push('价格趋势证据不可用')
  }
  if (validated.coverageWeight < 80) hardGaps.push('有效证据权重低于 80')
  const candidateStatus = hardGaps.length === 0 ? 'ELIGIBLE' : 'DATA_INSUFFICIENT'
  const researchSignal = candidateStatus === 'ELIGIBLE'
    ? validated.value.researchSignal
    : validated.value.researchSignal === 'AVOID' ? 'AVOID' : 'WATCH'
  const signalReason = candidateStatus === 'ELIGIBLE'
    ? validated.value.signalReason
    : `数据门槛未满足，暂归为观望。${validated.value.signalReason}`
  return {
    requestId: observation.requestId,
    rank: observation.rank,
    finalRank: null,
    symbol: observation.symbol,
    ticker: observation.ticker,
    displayName: observation.displayName,
    providerId: observation.providerId,
    status: 'COMPLETED',
    candidateStatus,
    totalScore: validated.totalScore,
    coverageWeight: validated.coverageWeight,
    dimensions: validated.value.dimensions,
    researchSignal,
    pricePlan: validated.value.pricePlan,
    signalReason,
    supportingAssessment: validated.value.supportingAssessment,
    opposingAssessment: validated.value.opposingAssessment,
    summary: validated.value.summary,
    evidenceIds: validated.value.evidenceIds,
    counterEvidenceIds: validated.value.counterEvidenceIds,
    risks: validated.value.risks,
    dataGaps: unique([...observationGaps, ...validated.value.dataGaps, ...hardGaps]),
    invalidationConditions: validated.value.invalidationConditions,
    capturedAt: observation.capturedAt,
    rejectionReason: null,
  }
}

function emptyItem(
  observation: QuantitativeObservation,
  status: 'REJECTED' | 'UNAVAILABLE',
  candidateStatus: 'REJECTED' | 'DATA_INSUFFICIENT',
  dataGaps: string[],
  rejectionReason: string,
): QuantitativeItemResult {
  return {
    requestId: observation.requestId,
    rank: observation.rank,
    finalRank: null,
    symbol: observation.symbol,
    ticker: observation.ticker,
    displayName: observation.displayName,
    providerId: observation.providerId,
    status,
    candidateStatus,
    totalScore: null,
    coverageWeight: 0,
    dimensions: null,
    researchSignal: null,
    pricePlan: null,
    signalReason: '',
    supportingAssessment: '',
    opposingAssessment: '',
    summary: '',
    evidenceIds: [],
    counterEvidenceIds: [],
    risks: [],
    dataGaps,
    invalidationConditions: [],
    capturedAt: observation.capturedAt,
    rejectionReason,
  }
}

function compareItems(a: QuantitativeItemResult, b: QuantitativeItemResult): number {
  return signalOrder(a.researchSignal) - signalOrder(b.researchSignal)
    || (b.totalScore ?? -1) - (a.totalScore ?? -1)
    || a.rank - b.rank
    || a.ticker.localeCompare(b.ticker)
}

function signalOrder(signal: QuantitativeResearchSignal | null): number {
  switch (signal) {
    case 'BUY': return 0
    case 'WATCH': return 1
    case 'AVOID': return 2
    default: return 3
  }
}

function renderQuantitativeMarkdown(
  report: Omit<QuantitativeReportSummary, 'markdown'>,
): string {
  const lines = [
    '# Top30 量化选股报告',
    '',
    `- 数据平台：${report.providerId === 'FUTU' ? '富途' : '长桥'}`,
    `- 生成时间：${report.generatedAt}`,
    `- 评分口径：${report.scoringVersion}`,
    `- 买入信号：${report.candidateCount}`,
    `- 数据缺口：${report.dataGapCount}`,
    '',
    '## Top 5 买入推荐',
    '',
  ]
  if (report.topFive.length === 0) {
    lines.push('当前没有同时满足数据覆盖门槛和买入信号要求的标的。')
  } else {
    for (const item of report.topFive) {
      lines.push(
        `${item.finalRank}. **${item.ticker} ${item.displayName}**：`
        + `${item.totalScore} 分；${item.signalReason}；${renderPricePlan(item.pricePlan)}`,
      )
    }
  }
  lines.push('', '## 观察名单', '')
  if (report.watchlist.length === 0) {
    lines.push('无。')
  } else {
    for (const item of report.watchlist) {
      lines.push(`- **${item.ticker}**：${item.signalReason}；${renderPricePlan(item.pricePlan)}`)
    }
  }
  lines.push('', '## 放弃名单', '')
  if (report.bottomFive.length === 0) {
    lines.push('无。')
  } else {
    for (const item of report.bottomFive) {
      lines.push(`- **${item.ticker}**：${item.signalReason}`)
    }
  }
  lines.push('', '## 数据不足', '')
  if (report.insufficient.length === 0) {
    lines.push('无。')
  } else {
    for (const item of report.insufficient) {
      lines.push(`- **${item.ticker}**：${item.dataGaps.join('；') || item.rejectionReason || '评分不可用'}`)
    }
  }
  return lines.join('\n')
}

function renderPricePlan(plan: QuantitativePricePlan | null): string {
  if (!plan || plan.entryDecision === 'NO_ENTRY') return '价格计划：暂不入场'
  return `价格计划：买入 ${formatPriceRange(plan.entryPriceLow, plan.entryPriceHigh)}，`
    + `止盈 ${formatPriceRange(plan.takeProfitLow, plan.takeProfitHigh)}，`
    + `止损 ${formatPrice(plan.stopLossPrice)}，预计持有 `
    + `${plan.expectedHoldingDaysLow}–${plan.expectedHoldingDaysHigh} 个交易日`
}

function formatPriceRange(low: number | null, high: number | null): string {
  return `${formatPrice(low)}–${formatPrice(high)}`
}

function formatPrice(value: number | null): string {
  return value === null ? '不适用' : `$${value.toFixed(2)}`
}

function invalid(reason: string): QuantitativeScoreValidation {
  return { ok: false, reason }
}

function isReportBuyCandidate(
  item: QuantitativeItemResult,
  scoringVersion: string,
): boolean {
  if (scoringVersion === QUANT_SCORING_VERSION) {
    return item.candidateStatus === 'ELIGIBLE' && item.researchSignal === 'BUY'
  }
  return item.candidateStatus === 'ELIGIBLE'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasUnexpectedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value)
  return keys.some(key => !allowed.has(key)) || [...allowed].some(key => !(key in value))
}

function boundedString(value: unknown, minimum: number, maximum: number): string | null {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    ? value
    : null
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number): string[] | null {
  if (
    !Array.isArray(value)
    || value.length > maximumItems
    || value.some(item => (
      typeof item !== 'string'
      || item.length < 1
      || item.length > maximumLength
    ))
  ) return null
  return value
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function spearman(pairs: Array<{ left: number; right: number }>): number | null {
  const count = pairs.length
  if (count < 2) return null
  const leftMean = pairs.reduce((sum, pair) => sum + pair.left, 0) / count
  const rightMean = pairs.reduce((sum, pair) => sum + pair.right, 0) / count
  const covariance = pairs.reduce(
    (sum, pair) => sum + ((pair.left - leftMean) * (pair.right - rightMean)),
    0,
  )
  const leftVariance = pairs.reduce(
    (sum, pair) => sum + ((pair.left - leftMean) ** 2),
    0,
  )
  const rightVariance = pairs.reduce(
    (sum, pair) => sum + ((pair.right - rightMean) ** 2),
    0,
  )
  const denominator = Math.sqrt(leftVariance * rightVariance)
  return denominator > 0 ? covariance / denominator : null
}
