import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import type { DeviceAuthorizer } from '../packages/auth/src/deviceAuthorization.js'
import { loadTradingCatalog } from '../packages/catalog/src/tradingCatalog.js'
import {
  calculateEnvelopeContentHash,
} from '../packages/domain/src/contextEnvelope.js'
import type {
  ContextEnvelope,
  ModelRunResult,
} from '../packages/domain/src/contracts.js'
import type { SafeLogger } from '../packages/observability/src/safeLogger.js'
import type {
  ModelRunRecord,
  ModelRunRepository,
} from '../packages/persistence/src/modelRunRepository.js'
import {
  DecisionService,
  type DecisionModel,
} from '../apps/decision-worker/src/decisionService.js'
import { normalizeModelResult } from '../apps/decision-worker/src/modelResultNormalizer.js'
import {
  PostgresTradingDecisionAuthority,
  TradingAuthorityError,
  type ResolvedTradingDecision,
  type TradingDecisionAuthority,
} from '../apps/decision-worker/src/tradingDecisionAuthority.js'
import type {
  TradingOutcomeRepository,
} from '../apps/decision-worker/src/tradingOutcomeRepository.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const now = new Date('2026-09-17T02:00:00.000Z')

function envelope(
  overrides: Partial<ContextEnvelope> = {},
): ContextEnvelope {
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
    account: {
      accountIdHash: 'a'.repeat(64),
      environment: 'REAL',
    },
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
    researchPoolVersion: 7,
    tradingConfigVersion: 3,
    catalogVersion: '2026.09.1',
    tradingSessionId: null,
    requestedSymbols: ['US.TEST'],
    clientPolicyVersion: 'test-v1',
    dataGaps: [],
    deviceSignature: 'fixture-signature-'.padEnd(80, 'a'),
    ...overrides,
  }
  value.contentHash = calculateEnvelopeContentHash(value)
  return value as unknown as ContextEnvelope
}

function result(
  overrides: Partial<ModelRunResult> = {},
): ModelRunResult {
  return {
    schemaVersion: '1.0',
    requestId: '11111111-1111-4111-8111-111111111111',
    status: 'COMPLETED',
    responseType: 'HOLD',
    summary: '继续观察。',
    evidence: [{ id: 'risk-1', kind: 'RISK', summary: '风险可控', sourceAt: null }],
    counterEvidence: [],
    risks: [],
    dataGaps: [],
    exitCondition: null,
    sourceValidUntil: null,
    orderIntent: null,
    ...overrides,
  }
}

const authority: ResolvedTradingDecision = {
  role: 'SINGLE_DECISION',
  provider: 'FUTU',
  brokerConnectionId: '33333333-3333-4333-8333-333333333333',
  catalogVersion: '2026.09.1',
  configVersion: 3,
  researchPoolVersion: 7,
  executionMode: 'DIRECT',
  confirmationMode: 'MANUAL_CONFIRM',
  candidateTtlSeconds: 600,
  strategyId: 'equity-momentum-v1',
  riskPolicyId: 'desktop-hard-risk-v1',
  requestedSymbols: ['US.TEST'],
  candidates: [],
  model: { id: 'ark-balanced', deploymentId: 'ep-test' },
  prompt: { id: 'single-decision-v1', version: '1.0.0', body: 'test' },
}

class MemoryRepository implements ModelRunRepository {
  created: Array<Omit<ModelRunRecord, 'result' | 'errorCode'>> = []
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

const allowDevice: DeviceAuthorizer = {
  authorizeAndVerify: async () => {},
}
const allowTrading: TradingDecisionAuthority = {
  resolve: async () => authority,
}

function service(
  repository: MemoryRepository,
  model: DecisionModel,
  tradingAuthority?: TradingDecisionAuthority,
  outcome?: TradingOutcomeRepository,
  logger: SafeLogger = { info() {}, warn() {}, error() {} },
): DecisionService {
  return new DecisionService(
    repository,
    model,
    logger,
    allowDevice,
    tradingAuthority,
    outcome,
  )
}

async function run(
  decisionService: DecisionService,
  rawContext: ContextEnvelope = envelope(),
  signal: AbortSignal = new AbortController().signal,
  onProgress?: (stage: string, percent: number) => void,
): Promise<ModelRunResult> {
  return decisionService.run({
    userId: '42',
    deviceId: '22222222-2222-4222-8222-222222222222',
    rawContext,
    byteLength: 1000,
    userMessage: null,
    signal,
    now,
    ...(onProgress ? { onProgress } : {}),
  })
}

test('订单建议覆盖四种持仓动作并拒绝字段类型或精度非法的草案', () => {
  const scenarios = [
    {
      positions: [],
      action: 'BUY',
      expected: 'BUY',
    },
    {
      positions: [{ symbol: 'US.TEST', quantity: '-2' }],
      action: 'BUY',
      expected: 'BUY_TO_COVER',
    },
    {
      positions: [{ symbol: 'US.TEST', quantity: '2' }],
      action: 'SELL',
      expected: 'SELL_TO_CLOSE',
    },
    {
      positions: [],
      action: 'SELL',
      expected: 'SELL_SHORT',
    },
  ] as const

  for (const scenario of scenarios) {
    const normalized = normalizeModelResult({
      responseType: 'SIGNAL',
      evidence: [{ id: 'quote', kind: 'QUOTE', summary: '报价有效' }],
      signal: { symbol: 'US.TEST', action: scenario.action, confidence: 0.8 },
      proposedOrder: {
        symbol: 'US.TEST',
        action: scenario.expected,
        quantity: '1',
        limitPrice: '100.12345678',
      },
    }, envelope({ positions: [...scenario.positions] }), authority)
    assert.equal(normalized.proposedOrder?.action, scenario.expected)
  }

  for (const proposedOrder of [
    null,
    { symbol: 'US.TEST', action: 'BUY', quantity: 1, limitPrice: '100' },
    { symbol: 'US.TEST', action: 'BUY', quantity: '1', limitPrice: 100 },
    { symbol: 'US.TEST', action: 'BUY', quantity: '01', limitPrice: '100' },
    { symbol: 'US.TEST', action: 'BUY', quantity: '1', limitPrice: '100.123456789' },
  ]) {
    const normalized = normalizeModelResult({
      responseType: 'SIGNAL',
      evidence: [{ id: 'quote', kind: 'QUOTE', summary: '报价有效' }],
      signal: { symbol: 'US.TEST', action: 'BUY', confidence: 0.8 },
      proposedOrder,
    }, envelope(), authority)
    assert.equal(normalized.proposedOrder, null)
  }
})

test('挂单监管只接受已知且不重复的订单动作，否则安全降级', () => {
  const managedContext = envelope({
    purpose: 'MANAGED_ORDER_REVIEW',
    openOrders: [{ intentId: 'intent-1' }],
  })
  const managedAuthority: ResolvedTradingDecision = {
    ...authority,
    role: 'MANAGED_ORDER_REVIEW',
  }
  const accepted = normalizeModelResult({
    evidence: [{ id: 'order', kind: 'ORDER', summary: '订单仍有效' }],
    managedOrderReview: [{
      intentId: 'intent-1',
      action: 'CANCEL_REMAINDER',
      reason: '信号已过期',
    }],
  }, managedContext, managedAuthority)
  assert.deepEqual(accepted.managedOrderReview, [{
    intentId: 'intent-1',
    action: 'CANCEL_REMAINDER',
    reason: '信号已过期',
  }])

  const rejected = normalizeModelResult({
    evidence: [{ id: 'order', kind: 'ORDER', summary: '订单异常' }],
    managedOrderReview: [
      { intentId: 'intent-1', action: 'KEEP', reason: '继续等待' },
      { intentId: 'intent-1', action: 'KEEP', reason: '重复裁决' },
    ],
  }, managedContext, managedAuthority)
  assert.equal(rejected.managedOrderReview, null)
})

test('DecisionService 在交易用途缺少权威或权威降级为空时失败关闭', async t => {
  await t.test('未注入权威', async () => {
    const repository = new MemoryRepository()
    await assert.rejects(
      () => run(service(repository, { run: async () => result() })),
      (error: unknown) => error instanceof TradingAuthorityError
        && error.code === 'TRADING_AUTHORITY_UNAVAILABLE',
    )
    assert.equal(repository.created.length, 0)
  })

  await t.test('权威返回空值', async () => {
    const repository = new MemoryRepository()
    await assert.rejects(
      () => run(service(
        repository,
        { run: async () => result() },
        { resolve: async () => null },
      )),
      (error: unknown) => error instanceof TradingAuthorityError
        && error.code === 'TRADING_AUTHORITY_UNAVAILABLE',
    )
    assert.equal(repository.created.length, 0)
  })
})

test('DecisionService 将真实交易结果委托结果仓储并完整报告进度', async () => {
  const repository = new MemoryRepository()
  const stages: Array<[string, number]> = []
  let persisted = false
  const outcome: TradingOutcomeRepository = {
    persist: async input => {
      persisted = true
      assert.equal(input.authority, authority)
      return { ...input.result, summary: '已持久化真实交易结果' }
    },
  }
  const actual = await run(service(
    repository,
    { run: async () => result() },
    allowTrading,
    outcome,
  ), envelope(), new AbortController().signal, (stage, percent) => {
    stages.push([stage, percent])
  })

  assert.equal(persisted, true)
  assert.equal(actual.summary, '已持久化真实交易结果')
  assert.equal(repository.finished.length, 0)
  assert.deepEqual(stages, [
    ['context_validated', 20],
    ['authority_resolved', 40],
    ['model_completed', 80],
    ['result_persisted', 100],
  ])
})

test('DecisionService 为授权错误、客户端取消和未知异常记录稳定错误码', async t => {
  const cases: Array<{
    name: string
    thrown: unknown
    abort: boolean
    expectedCode: string
    expectedName: string
    expectedReason: string
  }> = [
    {
      name: '授权错误',
      thrown: new TradingAuthorityError('SESSION_EXPIRED'),
      abort: false,
      expectedCode: 'SESSION_EXPIRED',
      expectedName: 'TradingAuthorityError',
      expectedReason: '交易决策权威配置校验失败',
    },
    {
      name: '客户端取消',
      thrown: new Error('cancelled'),
      abort: true,
      expectedCode: 'CLIENT_CANCELLED',
      expectedName: 'Error',
      expectedReason: 'cancelled',
    },
    {
      name: '未知异常',
      thrown: 'provider failed',
      abort: false,
      expectedCode: 'MODEL_RUN_FAILED',
      expectedName: 'UnknownError',
      expectedReason: '未知错误',
    },
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      const repository = new MemoryRepository()
      const errors: Array<Record<string, unknown>> = []
      const controller = new AbortController()
      if (item.abort) controller.abort()
      const logger: SafeLogger = {
        info() {},
        warn() {},
        error(_message, fields) {
          errors.push(fields ?? {})
        },
      }
      await assert.rejects(() => run(service(
        repository,
        { run: async () => Promise.reject(item.thrown) },
        allowTrading,
        undefined,
        logger,
      ), envelope(), controller.signal))
      assert.equal(repository.finished[0]?.completion.errorCode, item.expectedCode)
      assert.equal(errors[0]?.errorName, item.expectedName)
      assert.equal(errors[0]?.failureReason, item.expectedReason)
    })
  }
})

test('DecisionService 校验订单草案与非草案的签名意图边界', async t => {
  const chat = envelope({ purpose: 'CHAT' })

  await t.test('对话订单草案必须包含签名意图', async () => {
    const repository = new MemoryRepository()
    await assert.rejects(
      () => run(service(repository, {
        run: async () => result({ responseType: 'ORDER_DRAFT' }),
      }), chat),
      /订单草案缺少签名意图/,
    )
  })

  await t.test('非订单草案禁止夹带签名意图', async () => {
    const repository = new MemoryRepository()
    await assert.rejects(
      () => run(service(repository, {
        run: async () => result({ orderIntent: { intentId: 'forged' } }),
      }), chat),
      /非订单草案不得携带订单意图/,
    )
  })

  await t.test('影子交易决策禁止生成订单草案', async () => {
    const repository = new MemoryRepository()
    await assert.rejects(
      () => run(service(repository, {
        run: async () => result({
          responseType: 'ORDER_DRAFT',
          orderIntent: { intentId: 'forged' },
        }),
      }, allowTrading), envelope()),
      /影子决策阶段禁止生成可执行订单意图/,
    )
  })
})

test('DecisionService 拒绝越权信号、模式错配及不完整复核结果', async t => {
  const checks: Array<{
    name: string
    context: ContextEnvelope
    resolved: ResolvedTradingDecision
    modelResult: ModelRunResult
    message: RegExp
  }> = [
    {
      name: '信号缺失',
      context: envelope(),
      resolved: authority,
      modelResult: result({ responseType: 'SIGNAL' }),
      message: /缺少结构化信号/,
    },
    {
      name: '信号越权',
      context: envelope(),
      resolved: authority,
      modelResult: result({
        responseType: 'SIGNAL',
        signal: { symbol: 'US.OTHER', action: 'BUY', confidence: 2 },
      }),
      message: /超出服务端授权范围/,
    },
    {
      name: '直接模式返回候选',
      context: envelope(),
      resolved: authority,
      modelResult: result({
        responseType: 'CANDIDATE',
        signal: { symbol: 'US.TEST', action: 'BUY', confidence: 0.8 },
      }),
      message: /执行模式不一致/,
    },
    {
      name: '候选模式返回信号',
      context: envelope(),
      resolved: { ...authority, executionMode: 'CANDIDATE_POOL' },
      modelResult: result({
        responseType: 'SIGNAL',
        signal: { symbol: 'US.TEST', action: 'BUY', confidence: 0.8 },
      }),
      message: /执行模式不一致/,
    },
    {
      name: '组合复核缺少分类',
      context: envelope({ purpose: 'PORTFOLIO_REVIEW' }),
      resolved: { ...authority, role: 'PORTFOLIO_REVIEW' },
      modelResult: result({ responseType: 'CANDIDATE' }),
      message: /缺少候选分类/,
    },
    {
      name: '挂单监管返回信号',
      context: envelope({ purpose: 'MANAGED_ORDER_REVIEW' }),
      resolved: { ...authority, role: 'MANAGED_ORDER_REVIEW' },
      modelResult: result({ responseType: 'SIGNAL' }),
      message: /挂单监管影子结果类型非法/,
    },
  ]

  for (const check of checks) {
    await t.test(check.name, async () => {
      const repository = new MemoryRepository()
      await assert.rejects(() => run(service(
        repository,
        { run: async () => check.modelResult },
        { resolve: async () => check.resolved },
      ), check.context), check.message)
      assert.equal(repository.finished[0]?.completion.errorCode, 'MODEL_RUN_FAILED')
    })
  }
})

test('交易权威仅在硬门禁、实盘偏好、用户开关和有效会话同时满足时授权自动提交', async t => {
  const catalog = await loadTradingCatalog(resolve(root, 'catalog/trading/catalog.v1.yaml'))
  const previousModel = process.env.CHANGFU_ARK_MODEL
  process.env.CHANGFU_ARK_MODEL = 'ep-test'
  const config = {
    catalogVersion: catalog.catalogVersion,
    executionMode: 'DIRECT',
    confirmationMode: 'AUTO_EXECUTE_PREFERENCE',
    models: {
      singleDecision: 'ark-balanced',
      portfolioReview: 'ark-balanced',
      managedOrderReview: 'ark-balanced',
    },
    strategyId: 'equity-momentum-v1',
    singlePromptId: 'single-decision-v1',
    portfolioPromptId: 'portfolio-review-v1',
    managedOrderPromptId: 'managed-order-review-v1',
    scanIntervalSeconds: 60,
    portfolioReviewIntervalSeconds: 60,
    candidateTtlSeconds: 600,
    maxConcurrency: 2,
    disableUsOvernightEvaluation: true,
    riskPolicyId: 'desktop-hard-risk-v1',
  }
  const tradingSessionId = '44444444-4444-4444-8444-444444444444'

  try {
    await t.test('有效会话授权自动提交', async () => {
      const queries: Array<{ sql: string; values: unknown[] }> = []
      const pool = {
        query: async (sql: string, values?: unknown[]) => {
          queries.push({ sql, values: values ?? [] })
          if (sql.includes('FROM changfu.broker_connections c')) {
            return {
              rows: [{
                provider: 'FUTU',
                config_provider: 'FUTU',
                config_version: '3',
                catalog_version: catalog.catalogVersion,
                config,
                entitlement_status: 'ACTIVE',
                pool_version: '7',
                account_id_hash: 'a'.repeat(64),
                environment: 'REAL',
                auto_submit_enabled: true,
              }],
            }
          }
          if (sql.includes('FROM changfu.provider_research_pool_items')) {
            return { rows: [{ symbol: 'US.TEST', market: 'US', instrument_type: 'STOCK' }] }
          }
          if (sql.includes('FROM changfu.trading_sessions')) {
            return { rows: [{ session_id: tradingSessionId }] }
          }
          return { rows: [] }
        },
      } as unknown as Pool
      const resolved = await new PostgresTradingDecisionAuthority(
        pool,
        catalog,
        { FUTU: true, LONGBRIDGE: false },
      ).resolve('42', envelope({
        tradingSessionId,
        catalogVersion: catalog.catalogVersion,
      }))

      assert.equal(resolved?.hardGateEnabled, true)
      assert.equal(resolved?.autoSubmitEnabled, true)
      assert.equal(resolved?.submissionMode, 'AUTO_EXECUTE')
      assert.equal(resolved?.tradingSessionId, tradingSessionId)
      assert.deepEqual(resolved?.instrument, { market: 'US', instrumentType: 'STOCK' })
      const sessionQuery = queries.find(item => item.sql.includes('FROM changfu.trading_sessions'))
      assert.deepEqual(sessionQuery?.values, [
        tradingSessionId,
        '33333333-3333-4333-8333-333333333333',
        '42',
        '22222222-2222-4222-8222-222222222222',
        3,
        'desktop-hard-risk-v1',
      ])
    })

    await t.test('无有效会话时降级人工确认', async () => {
      const pool = {
        query: async (sql: string) => {
          if (sql.includes('FROM changfu.broker_connections c')) {
            return {
              rows: [{
                provider: 'FUTU',
                config_provider: 'FUTU',
                config_version: '3',
                catalog_version: catalog.catalogVersion,
                config,
                entitlement_status: 'ACTIVE',
                pool_version: '7',
                account_id_hash: 'a'.repeat(64),
                environment: 'REAL',
                auto_submit_enabled: true,
              }],
            }
          }
          if (sql.includes('FROM changfu.provider_research_pool_items')) {
            return { rows: [{ symbol: 'US.TEST', market: 'US', instrument_type: 'STOCK' }] }
          }
          return { rows: [] }
        },
      } as unknown as Pool
      const resolved = await new PostgresTradingDecisionAuthority(
        pool,
        catalog,
        { FUTU: true, LONGBRIDGE: false },
      ).resolve('42', envelope({
        tradingSessionId,
        catalogVersion: catalog.catalogVersion,
      }))

      assert.equal(resolved?.submissionMode, 'MANUAL_CONFIRM')
      assert.equal(resolved?.tradingSessionId, null)
    })

    await t.test('账户绑定不一致时拒绝授权', async () => {
      const pool = {
        query: async () => ({
          rows: [{
            provider: 'FUTU',
            config_provider: 'FUTU',
            config_version: '3',
            catalog_version: catalog.catalogVersion,
            config,
            entitlement_status: 'ACTIVE',
            pool_version: '7',
            account_id_hash: 'b'.repeat(64),
            environment: 'REAL',
            auto_submit_enabled: true,
          }],
        }),
      } as unknown as Pool
      await assert.rejects(
        () => new PostgresTradingDecisionAuthority(pool, catalog).resolve('42', envelope({
          catalogVersion: catalog.catalogVersion,
        })),
        (error: unknown) => error instanceof TradingAuthorityError
          && error.code === 'BROKER_ACCOUNT_BINDING_MISMATCH',
      )
    })
  } finally {
    if (previousModel === undefined) delete process.env.CHANGFU_ARK_MODEL
    else process.env.CHANGFU_ARK_MODEL = previousModel
  }
})
