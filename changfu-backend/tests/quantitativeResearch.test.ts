import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildQuantitativeReport,
  compareQuantitativeReports,
  QUANT_PROMPT_VERSION,
  QUANT_SCORING_VERSION,
  validateQuantitativeScoreResult,
  type QuantitativeObservation,
  type QuantitativeScoreResult,
} from '../packages/domain/src/quantitativeResearch.js'
import { buildQuantitativeScorePrompt } from '../packages/domain/src/quantitativePrompt.js'
import {
  parseQuantitativeObservation,
  quantitativeItemIdempotencyOperation,
} from '../apps/gateway/src/routes/quantitativeResearch.js'
import {
  canonicalTicker,
  lockTopThirty,
  providerSymbol,
  type TopThirtyUniverseCompany,
} from '../packages/domain/src/topThirtyUniverse.js'

const evidence = [
  {
    id: 'sec-revenue',
    layer: 'fundamentals',
    source: 'SEC',
    title: 'Revenue',
    capturedAt: '2026-10-08T12:00:00.000Z',
    asOf: '2026-06-30',
    value: 100,
  },
  {
    id: 'futu-price',
    layer: 'priceTrend',
    source: 'FUTU',
    title: 'Adjusted trend',
    capturedAt: '2026-10-08T12:00:00.000Z',
    asOf: '2026-10-07',
    value: 12.5,
  },
] satisfies QuantitativeObservation['evidence']

const score: QuantitativeScoreResult = {
  schemaVersion: '1.0',
  dimensions: {
    fundamentals: { score: 25, availability: 'AVAILABLE' },
    filings: { score: 12, availability: 'AVAILABLE' },
    shortActivity: { score: null, availability: 'UNAVAILABLE' },
    priceTrend: { score: 20, availability: 'AVAILABLE' },
    macroFit: { score: 10, availability: 'PARTIAL' },
  },
  summary: '基本面与趋势共同支持，卖空层暂不可用。',
  evidenceIds: ['sec-revenue', 'futu-price'],
  counterEvidenceIds: [],
  risks: ['估值偏高'],
  dataGaps: ['卖空层不可用'],
  invalidationConditions: ['长期趋势跌破关键均线'],
}

function observation(overrides: Partial<QuantitativeObservation> = {}): QuantitativeObservation {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    rank: 1,
    symbol: 'US.NVDA',
    ticker: 'NVDA',
    displayName: 'NVIDIA',
    providerId: 'FUTU',
    capturedAt: '2026-10-08T12:00:00.000Z',
    currentPrice: 190,
    quoteFreshness: 'FRESH',
    adjustedDailyBarCount: 260,
    evidence,
    dataGaps: [],
    ...overrides,
  }
}

test('共享 Top30 保持股权类别合并和券商代码转换', () => {
  const companies: TopThirtyUniverseCompany[] = [
    { rank: 1, ticker: 'GOOGL', companyName: 'Alphabet A', marketCap: '1' },
    { rank: 2, ticker: 'GOOG', companyName: 'Alphabet C', marketCap: '1' },
    { rank: 3, ticker: 'BRK.A', companyName: 'Berkshire A', marketCap: '1' },
    { rank: 4, ticker: 'BRK.B', companyName: 'Berkshire B', marketCap: '1' },
    ...Array.from({ length: 28 }, (_, index) => ({
      rank: index + 5,
      ticker: `T${index + 1}`,
      companyName: `Company ${index + 1}`,
      marketCap: '1',
    })),
  ]
  const locked = lockTopThirty(companies)
  assert.equal(locked.length, 30)
  assert.equal(locked.filter(item => item.ticker === 'GOOG').length, 1)
  assert.equal(locked.find(item => item.companyName === 'Berkshire Hathaway')?.ticker, 'BRK.B')
  assert.equal(providerSymbol('FUTU', 'NVDA'), 'US.NVDA')
  assert.equal(providerSymbol('LONGBRIDGE', 'NVDA'), 'NVDA.US')
  assert.equal(canonicalTicker('US.BRK.B'), 'BRK.B')
  assert.equal(canonicalTicker('BRK.B.US'), 'BRK.B')
})

test('模型五维评分由服务端校验边界、证据并确定性求和', () => {
  const validated = validateQuantitativeScoreResult(score, evidence)
  assert.equal(validated.ok, true)
  if (!validated.ok) return
  assert.equal(validated.totalScore, 67)
  assert.equal(validated.coverageWeight, 90)

  const outOfRange = structuredClone(score)
  outOfRange.dimensions.shortActivity = { score: 11, availability: 'AVAILABLE' }
  assert.deepEqual(
    validateQuantitativeScoreResult(outOfRange, evidence),
    { ok: false, reason: 'MODEL_SCORE_OUT_OF_RANGE:shortActivity' },
  )

  const unknownEvidence = structuredClone(score)
  unknownEvidence.evidenceIds = ['not-in-catalog']
  assert.deepEqual(
    validateQuantitativeScoreResult(unknownEvidence, evidence),
    { ok: false, reason: 'MODEL_EVIDENCE_NOT_FOUND:not-in-catalog' },
  )
})

test('缺失维度必须使用 null 且不重新分配权重', () => {
  const invalid = structuredClone(score)
  invalid.dimensions.shortActivity = { score: 0, availability: 'UNAVAILABLE' }
  assert.deepEqual(
    validateQuantitativeScoreResult(invalid, evidence),
    { ok: false, reason: 'MODEL_UNAVAILABLE_SCORE_MUST_BE_NULL:shortActivity' },
  )
})

test('报告仅从满足报价、K 线和覆盖门槛的标的选 Top5', () => {
  const higherButStale = observation({
    requestId: '22222222-2222-4222-8222-222222222222',
    rank: 2,
    symbol: 'US.MSFT',
    ticker: 'MSFT',
    displayName: 'Microsoft',
    quoteFreshness: 'STALE',
  })
  const higherScore = structuredClone(score)
  higherScore.dimensions.fundamentals.score = 30
  const report = buildQuantitativeReport([
    { observation: higherButStale, scoreResult: higherScore },
    { observation: observation(), scoreResult: score },
  ], new Date('2026-10-08T13:00:00.000Z'))

  assert.equal(QUANT_PROMPT_VERSION, 'top30-quant-selection-v1')
  assert.equal(QUANT_SCORING_VERSION, 'top30-five-layer-score-v1')
  assert.equal(report.items[0]?.ticker, 'MSFT')
  assert.equal(report.items[0]?.finalRank, 1)
  assert.equal(report.items[0]?.candidateStatus, 'DATA_INSUFFICIENT')
  assert.deepEqual(report.topFive.map(item => item.ticker), ['NVDA'])
  assert.match(report.markdown, /当前报价已过期/)
})

test('同分按原市值排名和 ticker 稳定排序，单票拒绝不取消其他结果', () => {
  const report = buildQuantitativeReport([
    {
      observation: observation({
        requestId: '33333333-3333-4333-8333-333333333333',
        rank: 2,
        symbol: 'US.AAPL',
        ticker: 'AAPL',
        displayName: 'Apple',
      }),
      scoreResult: score,
    },
    { observation: observation(), scoreResult: score },
    {
      observation: observation({
        requestId: '44444444-4444-4444-8444-444444444444',
        rank: 3,
        symbol: 'US.AMZN',
        ticker: 'AMZN',
        displayName: 'Amazon',
      }),
      scoreResult: { ...score, signal: 'BUY' },
    },
  ])
  assert.deepEqual(report.topFive.map(item => item.ticker), ['NVDA', 'AAPL'])
  assert.equal(report.rejectedCount, 1)
  assert.equal(report.items.find(item => item.ticker === 'AMZN')?.rejectionReason, 'MODEL_RESULT_SHAPE_INVALID')
})

test('独立评分 Schema 禁止交易字段且维度边界与领域一致', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../../changfu-contracts/schemas/quantitative-score-result.schema.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>
  assert.equal(schema.additionalProperties, false)
  const source = JSON.stringify(schema)
  for (const forbidden of ['signal', 'candidate', 'orderIntent', 'proposedOrder']) {
    assert.equal(source.includes(forbidden), false)
  }
  assert.match(source, /shortActivity/)
  assert.match(source, /"maximum":30/)
  assert.match(source, /"maximum":10/)
})

test('单票 Prompt 不携带其他标的且禁止模型直接给出排名或交易动作', () => {
  const prompt = buildQuantitativeScorePrompt(observation())
  assert.match(prompt.user, /NVDA/)
  assert.doesNotMatch(prompt.user, /AAPL|MSFT/)
  assert.match(prompt.system, /禁止比较、引用或推断其他股票/)
  assert.match(prompt.system, /不得返回总分、排名、候选、交易信号或订单/)
  assert.match(prompt.system, /score 与 availability 两个字段/)
  assert.match(prompt.system, /AVAILABLE、PARTIAL、UNAVAILABLE/)
})

test('异 Provider 报告对比确定性计算 Top5 重合与排名差异', () => {
  const leftReport = buildQuantitativeReport([
    { observation: observation(), scoreResult: score },
    {
      observation: observation({
        requestId: '22222222-2222-4222-8222-222222222222',
        rank: 2,
        symbol: 'US.AAPL',
        ticker: 'AAPL',
        displayName: 'Apple',
      }),
      scoreResult: {
        ...score,
        dimensions: {
          ...score.dimensions,
          fundamentals: { score: 20, availability: 'AVAILABLE' },
        },
      },
    },
  ])
  const rightReport = buildQuantitativeReport([
    {
      observation: observation({
        providerId: 'LONGBRIDGE',
        symbol: 'NVDA.US',
      }),
      scoreResult: {
        ...score,
        dimensions: {
          ...score.dimensions,
          fundamentals: { score: 15, availability: 'AVAILABLE' },
        },
      },
    },
    {
      observation: observation({
        requestId: '22222222-2222-4222-8222-222222222222',
        rank: 2,
        providerId: 'LONGBRIDGE',
        symbol: 'AAPL.US',
        ticker: 'AAPL',
        displayName: 'Apple',
      }),
      scoreResult: score,
    },
  ])
  const comparison = compareQuantitativeReports({
    runId: 'left',
    providerId: 'FUTU',
    promptVersion: QUANT_PROMPT_VERSION,
    scoringVersion: QUANT_SCORING_VERSION,
    items: leftReport.items,
  }, {
    runId: 'right',
    providerId: 'LONGBRIDGE',
    promptVersion: QUANT_PROMPT_VERSION,
    scoringVersion: QUANT_SCORING_VERSION,
    items: rightReport.items,
  })
  assert.deepEqual(comparison.commonTickers, ['AAPL', 'NVDA'])
  assert.deepEqual(comparison.topFiveOverlap, ['AAPL', 'NVDA'])
  assert.equal(comparison.topFiveOverlapRatio, 0.4)
  assert.equal(comparison.spearmanRankCorrelation, -1)
  assert.equal(comparison.maximumRankDifference, 1)
  assert.equal(comparison.versionWarning, false)
})

test('Gateway 单票 observation 拒绝跨 Provider 证据与代码错配', () => {
  const valid = {
    ...observation(),
    evidence: [{
      id: 'futu:price:nvda',
      layer: 'priceTrend',
      source: 'FUTU',
      title: '前复权趋势',
      capturedAt: '2026-10-08T12:00:00.000Z',
      asOf: '2026-10-07',
      value: 12.5,
    }],
  }
  assert.ok(parseQuantitativeObservation(valid, 'FUTU', valid.requestId))
  assert.equal(parseQuantitativeObservation({
    ...valid,
    evidence: [{ ...valid.evidence[0], source: 'LONGBRIDGE' }],
  }, 'FUTU', valid.requestId), null)
  assert.equal(parseQuantitativeObservation({
    ...valid,
    symbol: 'NVDA.US',
  }, 'FUTU', valid.requestId), null)
})

test('量化单票幂等 operation 不超过数据库 varchar(80)', () => {
  const requestId = '301925ea-5605-40eb-b56b-7ef930fb2229'
  const operation = quantitativeItemIdempotencyOperation(requestId)
  assert.equal(operation, `quantitative:item:${requestId}`)
  assert.ok(operation.length <= 80)
})

test('量化链路不存在 Yahoo 且 Longbridge Host 仅使用固定只读命令', async () => {
  const files = await Promise.all([
    readFile(new URL('../apps/gateway/src/routes/quantitativeResearch.ts', import.meta.url), 'utf8'),
    readFile(new URL('../packages/research/src/secResearchClient.ts', import.meta.url), 'utf8'),
    readFile(new URL('../packages/research/src/finraResearchClient.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../../changfu-desktop/macos/LongbridgeHost/main.swift', import.meta.url),
      'utf8',
    ),
  ])
  const source = files.join('\n').toLowerCase()
  assert.equal(source.includes('yahoo'), false)
  for (const command of [
    'financial-statement',
    'filing',
    'insider-trades',
    'short-trades',
    'short-positions',
    'quantitative-research-observation',
  ]) {
    assert.ok(source.includes(command), `缺少固定只读命令 ${command}`)
  }
})

test('量化 Repository 在模型调用前绑定 run、requestId、symbol、ticker 与排名', async () => {
  const source = await readFile(
    new URL(
      '../packages/persistence/src/postgresQuantitativeResearchRepository.ts',
      import.meta.url,
    ),
    'utf8',
  )
  const guard = source.slice(
    source.indexOf('async runModelProfile'),
    source.indexOf('async submitItem'),
  )
  assert.match(guard, /item\.request_id = \$4::uuid/)
  assert.match(guard, /item\.symbol = \$5/)
  assert.match(guard, /item\.ticker = \$6/)
  assert.match(guard, /item\.market_cap_rank = \$7/)
  assert.match(source, /status IN \('COLLECTING', 'SCORING', 'FINALIZING'\)/)
  assert.match(source, /stored\.rows\.length !== QUANT_POOL_CAPACITY/)
})

test('量化长任务按批次和封版重新取得自动续期后的 access token', async () => {
  const source = await readFile(
    new URL('../../changfu-desktop/macos/App/AppState.swift', import.meta.url),
    'utf8',
  )
  const run = source.slice(
    source.indexOf('func startQuantitativeReport()'),
    source.indexOf('func loadQuantitativeReport'),
  )
  assert.match(run, /let batchAccessToken = authenticationSession\?\.accessToken/)
  assert.match(run, /accessToken: batchAccessToken/)
  assert.match(run, /let finalAccessToken = authenticationSession\?\.accessToken/)
  assert.match(run, /accessToken: finalAccessToken/)
})
