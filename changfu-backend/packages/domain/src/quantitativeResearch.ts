export const QUANT_PROMPT_VERSION = 'top30-quant-selection-v1'
export const QUANT_SCORING_VERSION = 'top30-five-layer-score-v1'
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
export type QuantitativeLayer = QuantitativeDimension
export type QuantitativeSource = 'SEC' | 'FINRA' | 'FUTU' | 'LONGBRIDGE'

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
  evidence: QuantitativeEvidence[]
  dataGaps: string[]
}

export type QuantitativeDimensionScore = {
  score: number | null
  availability: QuantitativeAvailability
}

export type QuantitativeScoreResult = {
  schemaVersion: '1.0'
  dimensions: Record<QuantitativeDimension, QuantitativeDimensionScore>
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
): QuantitativeScoreValidation {
  if (!isRecord(input) || hasUnexpectedKeys(input, resultKeys)) {
    return invalid('MODEL_RESULT_SHAPE_INVALID')
  }
  if (input.schemaVersion !== '1.0' || !isRecord(input.dimensions)) {
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
    if (!isRecord(value) || hasUnexpectedKeys(value, new Set(['score', 'availability']))) {
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
    dimensions[key] = { score: score as number | null, availability }
  }

  const summary = boundedString(input.summary, 1, 2_000)
  const evidenceIds = stringArray(input.evidenceIds, 100, 128)
  const counterEvidenceIds = stringArray(input.counterEvidenceIds, 100, 128)
  const risks = stringArray(input.risks, 50, 500)
  const dataGaps = stringArray(input.dataGaps, 50, 500)
  const invalidationConditions = stringArray(input.invalidationConditions, 50, 500)
  if (
    summary === null
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
      schemaVersion: '1.0',
      dimensions,
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
    candidateCount: eligible.length,
    dataGapCount: items.reduce((sum, item) => sum + item.dataGaps.length, 0),
    topFive: eligible.slice(0, 5),
    watchlist: eligible.slice(5, 10),
    bottomFive: [...scored].reverse().slice(0, 5),
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
      .filter(item => item.candidateStatus === 'ELIGIBLE' && item.finalRank !== null)
      .sort((a, b) => a.finalRank! - b.finalRank!)
      .slice(0, 5)
      .map(item => item.ticker),
  )
  const rightTop = new Set(
    right.items
      .filter(item => item.candidateStatus === 'ELIGIBLE' && item.finalRank !== null)
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
  const validated = validateQuantitativeScoreResult(input.scoreResult, observation.evidence)
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
  return (b.totalScore ?? -1) - (a.totalScore ?? -1)
    || a.rank - b.rank
    || a.ticker.localeCompare(b.ticker)
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
    `- 合格标的：${report.candidateCount}`,
    `- 数据缺口：${report.dataGapCount}`,
    '',
    '## Top 5',
    '',
  ]
  if (report.topFive.length === 0) {
    lines.push('当前没有满足数据覆盖门槛的标的。')
  } else {
    for (const item of report.topFive) {
      lines.push(`${item.finalRank}. **${item.ticker} ${item.displayName}**：${item.totalScore} 分`)
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

function invalid(reason: string): QuantitativeScoreValidation {
  return { ok: false, reason }
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
