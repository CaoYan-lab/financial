import assert from 'node:assert/strict'
import test from 'node:test'
import { DecisionService, type DecisionModel } from '../apps/decision-worker/src/decisionService.js'
import {
  calculateEnvelopeContentHash,
} from '../packages/domain/src/contextEnvelope.js'
import type {
  ContextEnvelope,
  ModelRunResult,
} from '../packages/domain/src/contracts.js'
import type {
  ModelRunRecord,
  ModelRunRepository,
} from '../packages/persistence/src/modelRunRepository.js'
import type { SafeLogger } from '../packages/observability/src/safeLogger.js'
import type { DeviceAuthorizer } from '../packages/auth/src/deviceAuthorization.js'
import { normalizeModelResult } from '../apps/decision-worker/src/modelResultNormalizer.js'
import type {
  ResolvedTradingDecision,
  TradingDecisionAuthority,
} from '../apps/decision-worker/src/tradingDecisionAuthority.js'

function validEnvelope(now: Date, dataGaps: string[] = []): ContextEnvelope {
  const value: Record<string, unknown> = {
    schemaVersion: '2.0',
    requestId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    brokerConnectionId: '33333333-3333-4333-8333-333333333333',
    provider: 'FUTU',
    purpose: 'SINGLE_DECISION',
    capturedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence: 1,
    account: { accountIdHash: 'a'.repeat(64) },
    positions: [],
    marketSessions: [],
    quotes: [{ symbol: 'US.TEST', lastPrice: '100' }],
    minuteBars: [{
      symbol: 'US.TEST',
      time: now.toISOString(),
      open: '99',
      high: '101',
      low: '98',
      close: '100',
      volume: '1000',
    }],
    tickerPoints: [],
    orderBooks: [],
    openOrders: [],
    recentDeals: [],
    capabilities: [],
    researchPoolVersion: 1,
    tradingConfigVersion: 1,
    catalogVersion: '2026.09.1',
    tradingSessionId: null,
    requestedSymbols: ['US.TEST'],
    clientPolicyVersion: 'test-v1',
    dataGaps,
    deviceSignature: 'fixture-signature-'.padEnd(80, 'a'),
  }
  value.contentHash = calculateEnvelopeContentHash(value)
  return value as unknown as ContextEnvelope
}

class MemoryRepository implements ModelRunRepository {
  created: Omit<ModelRunRecord, 'result' | 'errorCode'>[] = []
  finished: Array<{
    requestId: string
    completion: Pick<ModelRunRecord, 'status' | 'result' | 'errorCode'>
  }> = []

  async create(record: Omit<ModelRunRecord, 'result' | 'errorCode'>): Promise<void> {
    this.created.push(record)
  }

  async finish(
    requestId: string,
    completion: Pick<ModelRunRecord, 'status' | 'result' | 'errorCode'>,
  ): Promise<void> {
    this.finished.push({ requestId, completion })
  }
}

const silentLogger: SafeLogger = {
  info() {},
  warn() {},
  error() {},
}
const allowDevice: DeviceAuthorizer = {
  authorizeAndVerify: async () => {},
}
const resolvedAuthority: ResolvedTradingDecision = {
  role: 'SINGLE_DECISION',
  provider: 'FUTU',
  brokerConnectionId: '33333333-3333-4333-8333-333333333333',
  catalogVersion: '2026.09.1',
  configVersion: 1,
  researchPoolVersion: 1,
  executionMode: 'DIRECT',
  confirmationMode: 'MANUAL_CONFIRM',
  candidateTtlSeconds: 600,
  strategyId: 'equity-momentum-v1',
  riskPolicyId: 'desktop-hard-risk-v1',
  requestedSymbols: ['US.TEST'],
  candidates: [],
  model: { id: 'ark-balanced', deploymentId: 'test-model' },
  prompt: { id: 'single-decision-v1', version: '1.0.0', body: 'test' },
}
const allowTrading: TradingDecisionAuthority = {
  resolve: async () => resolvedAuthority,
}

function holdResult(requestId: string): ModelRunResult {
  return {
    schemaVersion: '1.0',
    requestId,
    status: 'COMPLETED',
    responseType: 'HOLD',
    summary: '数据不足，维持观察。',
    evidence: [{ id: 'risk-1', kind: 'RISK', summary: '缺少盘口', sourceAt: null }],
    counterEvidence: [],
    risks: ['信息不足'],
    dataGaps: ['缺少盘口'],
    exitCondition: '补齐数据后重评',
    sourceValidUntil: null,
    orderIntent: null,
  }
}

test('DecisionService 只向仓储提交元数据和模型结果', async () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const repository = new MemoryRepository()
  let selectedModelConfigId: string | null | undefined
  const model: DecisionModel = {
    run: async ({ context, modelConfigId }) => {
      selectedModelConfigId = modelConfigId
      return holdResult(context.requestId)
    },
  }
  const service = new DecisionService(
    repository, model, silentLogger, allowDevice, allowTrading,
  )

  const result = await service.run({
    userId: '42',
    deviceId: '22222222-2222-4222-8222-222222222222',
    rawContext: validEnvelope(now),
    byteLength: 1000,
    userMessage: '现在是否适合买入？',
    modelConfigId: '11111111-1111-4111-8111-111111111111',
    signal: new AbortController().signal,
    now,
  })

  assert.equal(result.responseType, 'HOLD')
  assert.equal(selectedModelConfigId, '11111111-1111-4111-8111-111111111111')
  assert.equal(repository.created.length, 1)
  assert.equal(repository.finished.length, 1)
  const serialized = JSON.stringify(repository.created[0])
  assert.equal(serialized.includes('accountIdHash'), false)
  assert.equal(serialized.includes('positions'), true)
  assert.equal(serialized.includes('fixture-signature'), false)
})

test('存在数据缺口时拒绝模型返回订单草案并记录中断', async () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const repository = new MemoryRepository()
  const model: DecisionModel = {
    run: async ({ context }) => ({
      ...holdResult(context.requestId),
      responseType: 'ORDER_DRAFT',
      orderIntent: { intentId: 'unsafe' },
    }),
  }
  const service = new DecisionService(
    repository, model, silentLogger, allowDevice, allowTrading,
  )

  await assert.rejects(() => service.run({
    userId: '42',
    deviceId: '22222222-2222-4222-8222-222222222222',
    rawContext: validEnvelope(now, ['缺少盘口']),
    byteLength: 1000,
    userMessage: null,
    signal: new AbortController().signal,
    now,
  }), /存在数据缺口/)

  assert.equal(repository.finished[0]?.completion.status, 'INTERRUPTED')
  assert.equal(repository.finished[0]?.completion.errorCode, 'MODEL_RUN_FAILED')
})

test('设备验签失败时不创建模型运行记录', async () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const repository = new MemoryRepository()
  const model: DecisionModel = {
    run: async ({ context }) => holdResult(context.requestId),
  }
  const rejectDevice: DeviceAuthorizer = {
    authorizeAndVerify: async () => {
      throw new Error('设备签名无效')
    },
  }
  const service = new DecisionService(repository, model, silentLogger, rejectDevice)

  await assert.rejects(() => service.run({
    userId: '42',
    deviceId: '22222222-2222-4222-8222-222222222222',
    rawContext: validEnvelope(now),
    byteLength: 1000,
    userMessage: null,
    signal: new AbortController().signal,
    now,
  }), /设备签名无效/)
  assert.equal(repository.created.length, 0)
})

test('协议外模型结果降级为包含证据和风险的观望结果', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const context = validEnvelope(now, ['缺少行情'])
  const result = normalizeModelResult({
    status: 'NO_DATA',
    responseType: 'DATA_GAP',
    summary: '无法判断。',
    risks: [],
  }, context)

  assert.equal(result.requestId, context.requestId)
  assert.equal(result.status, 'COMPLETED')
  assert.equal(result.responseType, 'HOLD')
  assert.equal(result.orderIntent, null)
  assert.equal(result.evidence.length, 1)
  assert.deepEqual(result.dataGaps, ['缺少行情'])
  assert.equal(result.risks.length, 1)
})

test('单票信号按权威执行模式转为候选且拒绝池外标的', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const context = validEnvelope(now)
  const candidateAuthority = {
    ...resolvedAuthority,
    executionMode: 'CANDIDATE_POOL' as const,
  }
  const valid = normalizeModelResult({
    responseType: 'SIGNAL',
    summary: '趋势确认。',
    evidence: [{ id: 'quote', kind: 'QUOTE', summary: '价格突破', sourceAt: null }],
    risks: ['回撤风险'],
    signal: { symbol: 'US.TEST', action: 'BUY', confidence: 0.72 },
  }, context, candidateAuthority)
  assert.equal(valid.responseType, 'CANDIDATE')
  assert.equal(valid.signal?.symbol, 'US.TEST')

  const invalid = normalizeModelResult({
    responseType: 'SIGNAL',
    summary: '越权标的。',
    evidence: [{ id: 'quote', kind: 'QUOTE', summary: '未知行情', sourceAt: null }],
    signal: { symbol: 'US.OTHER', action: 'BUY', confidence: 0.9 },
  }, context, candidateAuthority)
  assert.equal(invalid.responseType, 'HOLD')
  assert.deepEqual(invalid.signal, {
    symbol: 'US.TEST',
    action: 'HOLD',
    intent: 'HOLD',
    confidence: 0,
  })
})

test('单标的请求只归一化一个独立信号', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const context = {
    ...validEnvelope(now),
    requestedSymbols: ['US.TEST'],
    quotes: [{ symbol: 'US.TEST', lastPrice: '100' }],
    minuteBars: [{ symbol: 'US.TEST', time: now.toISOString(), close: '100' }],
  }
  const authority: ResolvedTradingDecision = {
    ...resolvedAuthority,
    requestedSymbols: ['US.TEST'],
    executionMode: 'CANDIDATE_POOL',
  }
  const normalized = normalizeModelResult({
    responseType: 'SIGNAL',
    summary: '单标的评估完成。',
    evidence: [{ id: 'quote', kind: 'QUOTE', summary: '报价有效', sourceAt: null }],
    signal: { symbol: 'US.TEST', action: 'BUY', confidence: 0.72 },
  }, context, authority)

  assert.equal(normalized.responseType, 'CANDIDATE')
  assert.deepEqual(normalized.signal, {
    symbol: 'US.TEST',
    action: 'BUY',
    intent: 'BUY',
    confidence: 0.72,
  })
})

test('非阻断数据缺口保留单票信号，缺少关键行情时降级观望', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const context = validEnvelope(now, ['新闻数据未接入'])
  const modelOutput = {
    responseType: 'SIGNAL',
    summary: '趋势与报价支持买入。',
    evidence: [
      { id: 'quote', kind: 'QUOTE', summary: '最新价有效', sourceAt: now.toISOString() },
      { id: 'trend', kind: 'TREND', summary: '短线趋势向上', sourceAt: now.toISOString() },
    ],
    risks: ['事件风险'],
    dataGaps: ['新闻催化剂未确认'],
    signal: { symbol: 'US.TEST', action: 'BUY', confidence: 0.72 },
  }

  const accepted = normalizeModelResult(modelOutput, context, {
    ...resolvedAuthority,
    executionMode: 'CANDIDATE_POOL',
  })
  assert.equal(accepted.responseType, 'CANDIDATE')
  assert.equal(accepted.signal?.action, 'BUY')
  assert.equal(accepted.signal?.intent, 'BUY')
  assert.deepEqual(accepted.dataGaps, ['新闻数据未接入', '新闻催化剂未确认'])

  const missingQuote = normalizeModelResult(modelOutput, {
    ...context,
    quotes: [],
  }, resolvedAuthority)
  assert.equal(missingQuote.responseType, 'HOLD')
  assert.equal(missingQuote.signal?.action, 'HOLD')
  assert.equal(missingQuote.signal?.confidence, 0)
})

test('单票卖出动作按当前持仓区分平仓卖出和卖空', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const output = {
    responseType: 'SIGNAL',
    summary: '趋势转弱。',
    evidence: [{ id: 'quote', kind: 'QUOTE', summary: '价格跌破', sourceAt: null }],
    risks: ['反弹风险'],
    signal: { symbol: 'US.TEST', action: 'SELL', confidence: 0.7 },
  }
  const longResult = normalizeModelResult(output, {
    ...validEnvelope(now),
    positions: [{ symbol: 'US.TEST', quantity: '30' }],
  }, resolvedAuthority)
  assert.equal(longResult.signal?.intent, 'SELL_TO_CLOSE')

  const shortResult = normalizeModelResult(output, {
    ...validEnvelope(now),
    positions: [],
  }, resolvedAuthority)
  assert.equal(shortResult.signal?.intent, 'SELL_SHORT')

  const coverResult = normalizeModelResult({
    ...output,
    signal: { symbol: 'US.TEST', action: 'BUY', confidence: 0.7 },
  }, {
    ...validEnvelope(now),
    positions: [{ symbol: 'US.TEST', quantity: '-10' }],
  }, resolvedAuthority)
  assert.equal(coverResult.signal?.intent, 'BUY_TO_COVER')
})

test('决策上下文限定证据目录并过滤尚未发生的未来开盘缺口', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const context: ContextEnvelope = {
    ...validEnvelope(now),
    decisionContext: {
      strategyRequirements: {},
      evidenceCatalog: [{
        id: 'QUOTE_US_TEST',
        kind: 'QUOTE',
        summary: '报价有效',
        sourceAt: now.toISOString(),
      }],
      trendContext: [],
      positionExposure: [],
      accountRisk: {},
      ordersKnowledge: {},
      dataWindow: [],
      extendedSession: [],
      gapCatalog: [{
        code: 'NEWS_NOT_CONNECTED',
        severity: 'INFORMATIONAL',
        summary: '新闻未接入',
        sourceSupport: 'notConnected',
      }],
      temporalBoundary: {
        sourceValidUntil: new Date(now.getTime() + 60_000).toISOString(),
        nextSessionOpen: 'NOT_YET_OCCURRED',
      },
      outputContract: {},
    },
  }
  const output = {
    responseType: 'SIGNAL',
    summary: '报价支持观察。',
    evidence: [{
      id: 'QUOTE_US_TEST',
      kind: 'QUOTE',
      summary: '最新价有效',
      sourceAt: now.toISOString(),
    }],
    counterEvidence: [{
      id: 'MODEL_MADE_UP',
      kind: 'QUOTE',
      summary: '不得保留',
      sourceAt: now.toISOString(),
    }],
    risks: ['隔夜波动'],
    dataGaps: ['次交易日开盘价无法提供', '新闻未接入'],
    sourceValidUntil: '2099-01-01T00:00:00.000Z',
    signal: { symbol: 'US.TEST', action: 'HOLD', confidence: 0.4 },
  }

  const normalized = normalizeModelResult(output, context, resolvedAuthority)
  assert.equal(normalized.signal?.confidence, 0.4)
  assert.deepEqual(normalized.counterEvidence, [])
  assert.deepEqual(normalized.dataGaps, ['新闻未接入'])
  assert.equal(
    normalized.sourceValidUntil,
    new Date(now.getTime() + 60_000).toISOString(),
  )

  const blocked = normalizeModelResult(output, {
    ...context,
    decisionContext: {
      ...context.decisionContext!,
      gapCatalog: [{
        code: 'TREND_MISSING',
        severity: 'BLOCKING',
        summary: '趋势缺失',
        sourceSupport: 'provider',
      }],
    },
  }, resolvedAuthority)
  assert.equal(blocked.signal?.confidence, 0)
})

test('组合裁决要求每个权威候选恰好分类一次', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const context = {
    ...validEnvelope(now),
    purpose: 'PORTFOLIO_REVIEW' as const,
  }
  const authority: ResolvedTradingDecision = {
    ...resolvedAuthority,
    role: 'PORTFOLIO_REVIEW',
    candidates: [
      {
        candidateId: '44444444-4444-4444-8444-444444444444',
        symbol: 'US.TEST',
        side: 'BUY',
        status: 'PENDING',
        rank: null,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    ],
  }
  const valid = normalizeModelResult({
    responseType: 'CANDIDATE',
    summary: '组合裁决完成。',
    evidence: [{ id: 'risk', kind: 'RISK', summary: '组合风险可控', sourceAt: null }],
    portfolioReview: [{
      candidateId: '44444444-4444-4444-8444-444444444444',
      status: 'WATCH',
      rank: 1,
      reason: '等待更好价格',
    }],
  }, context, authority)
  assert.equal(valid.responseType, 'CANDIDATE')
  assert.equal(valid.portfolioReview?.[0]?.status, 'WATCH')

  const incomplete = normalizeModelResult({
    responseType: 'CANDIDATE',
    summary: '未分类。',
    evidence: [{ id: 'risk', kind: 'RISK', summary: '缺失分类', sourceAt: null }],
    portfolioReview: [],
  }, context, authority)
  assert.equal(incomplete.responseType, 'HOLD')
  assert.equal(incomplete.portfolioReview, null)
})
