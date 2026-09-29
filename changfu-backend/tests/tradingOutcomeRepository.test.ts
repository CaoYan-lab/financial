import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { PostgresTradingOutcomeRepository } from '../apps/decision-worker/src/tradingOutcomeRepository.js'
import type { ResolvedTradingDecision } from '../apps/decision-worker/src/tradingDecisionAuthority.js'
import type { ContextEnvelope, ModelRunResult } from '../packages/domain/src/contracts.js'
import {
  verifySignedOrderIntent,
  type SignedOrderIntent,
} from '../packages/domain/src/signedOrderIntent.js'

const userId = '42'
const deviceId = '11111111-1111-4111-8111-111111111111'
const brokerConnectionId = '22222222-2222-4222-8222-222222222222'
const requestId = '33333333-3333-4333-8333-333333333333'

function authority(): ResolvedTradingDecision {
  return {
    role: 'SINGLE_DECISION',
    provider: 'FUTU',
    brokerConnectionId,
    catalogVersion: '2026.09.1',
    configVersion: 3,
    researchPoolVersion: 7,
    executionMode: 'DIRECT',
    confirmationMode: 'MANUAL_CONFIRM',
    candidateTtlSeconds: 600,
    strategyId: 'equity-momentum-v1',
    riskPolicyId: 'desktop-hard-risk-v1',
    requestedSymbols: ['US.AAPL'],
    candidates: [],
    accountIdHash: 'a'.repeat(64),
    environment: 'REAL',
    instrument: { market: 'US', instrumentType: 'STOCK' },
    hardGateEnabled: true,
    autoSubmitEnabled: false,
    submissionMode: 'MANUAL_CONFIRM',
    tradingSessionId: null,
    model: { id: 'model', deploymentId: 'deployment' },
    prompt: { id: 'prompt', version: '1', body: 'prompt' },
  }
}

function context(now: Date): ContextEnvelope {
  return {
    schemaVersion: '2.0',
    requestId,
    deviceId,
    brokerConnectionId,
    provider: 'FUTU',
    purpose: 'SINGLE_DECISION',
    capturedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence: 1,
    account: {
      accountIdHash: 'a'.repeat(64),
      environment: 'REAL',
      buyingPower: { value: '10000', currency: 'USD' },
      marginCallActive: false,
    },
    positions: [],
    marketSessions: [{ market: 'US', state: 'OPEN', sourceAt: now.toISOString() }],
    quotes: [{
      symbol: 'US.AAPL',
      market: 'US',
      sourceAt: now.toISOString(),
      lastPrice: '200',
      bidPrice: '199.99',
      askPrice: '200.01',
      lotSize: 1,
    }],
    minuteBars: [],
    tickerPoints: [],
    orderBooks: [],
    openOrders: [],
    recentDeals: [],
    capabilities: [],
    researchPoolVersion: 7,
    tradingConfigVersion: 3,
    catalogVersion: '2026.09.1',
    tradingSessionId: null,
    requestedSymbols: ['US.AAPL'],
    clientPolicyVersion: 'macos-v2',
    dataGaps: [],
    contentHash: 'b'.repeat(64),
    deviceSignature: 'signature',
  }
}

function result(now: Date): ModelRunResult {
  return {
    schemaVersion: '1.0',
    requestId,
    status: 'COMPLETED',
    responseType: 'SIGNAL',
    summary: 'buy',
    evidence: [{ id: 'quote', kind: 'QUOTE', summary: 'fresh', sourceAt: now.toISOString() }],
    counterEvidence: [],
    risks: [],
    dataGaps: [],
    exitCondition: 'signal changes',
    sourceValidUntil: new Date(now.getTime() + 30_000).toISOString(),
    orderIntent: null,
    proposedOrder: {
      symbol: 'US.AAPL',
      action: 'BUY',
      quantity: '1',
      limitPrice: '200.00',
    },
    signal: { symbol: 'US.AAPL', action: 'BUY', intent: 'BUY', confidence: 0.8 },
  }
}

test('DIRECT 实盘信号在同标的锁内生成并持久化完整签名 intent', async () => {
  const now = new Date()
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values })
      if (sql.includes('SELECT intent_id, device_id, state, order_spec')) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    },
    release: () => undefined,
  } as unknown as PoolClient
  const pool = { connect: async () => client } as unknown as Pool
  const keys = generateKeyPairSync('ed25519')
  const persisted = await new PostgresTradingOutcomeRepository(pool, {
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'order-key-v1',
  }).persist({
    userId,
    context: context(now),
    authority: authority(),
    result: result(now),
  })

  assert.equal(persisted.responseType, 'ORDER_DRAFT')
  const intent = persisted.orderIntent as SignedOrderIntent
  assert.equal(intent.executionMode, 'MANUAL_CONFIRM')
  assert.equal(intent.order.tradingSession, 'RTH')
  assert.equal(intent.order.timeInForce, 'DAY')
  assert.equal(verifySignedOrderIntent(intent, keys.publicKey, {
    userId,
    deviceId,
    brokerConnectionId,
    accountIdHash: 'a'.repeat(64),
  }), true)
  assert.equal(
    statements.some(item => item.sql.includes('pg_advisory_xact_lock')),
    true,
  )
  assert.equal(
    statements.some(item => item.sql.includes('INSERT INTO changfu.pending_orders')),
    true,
  )
  assert.equal(statements.at(-1)?.sql, 'COMMIT')
})

test('新 HOLD 信号对已提交系统订单只生成幂等撤单任务', async () => {
  const now = new Date()
  const statements: string[] = []
  const client = {
    query: async (sql: string) => {
      statements.push(sql)
      if (sql.includes('SELECT intent_id, device_id, state, order_spec')) {
        return {
          rows: [{
            intent_id: '44444444-4444-4444-8444-444444444444',
            device_id: deviceId,
            state: 'TRACKING',
            order_spec: {
              broker: 'FUTU',
              environment: 'REAL',
              market: 'US',
              symbol: 'US.AAPL',
              side: 'BUY',
              positionEffect: 'OPEN_LONG',
              orderType: 'MARKETABLE_LIMIT',
              tradingSession: 'RTH',
              timeInForce: 'DAY',
              quantity: '1',
              limitPrice: '200.00',
              currency: 'USD',
              maxSlippageBps: 15,
            },
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    },
    release: () => undefined,
  } as unknown as PoolClient
  const pool = { connect: async () => client } as unknown as Pool
  const hold = {
    ...result(now),
    responseType: 'HOLD' as const,
    proposedOrder: null,
    signal: { symbol: 'US.AAPL', action: 'HOLD' as const, intent: 'HOLD' as const, confidence: 0 },
  }

  const persisted = await new PostgresTradingOutcomeRepository(pool).persist({
    userId,
    context: context(now),
    authority: authority(),
    result: hold,
  })

  assert.equal(persisted.orderIntent, null)
  assert.equal(statements.some(sql => sql.includes("SET state = 'CANCEL_REQUESTED'")), true)
  assert.equal(statements.some(sql => sql.includes('INSERT INTO changfu.order_actions')), true)
  assert.equal(statements.some(sql => sql.includes('INSERT INTO changfu.pending_orders')), false)
})

function fakeOutcomePool(
  respond: (
    sql: string,
    values: unknown[],
  ) => { rows: any[]; rowCount: number | null } | Promise<{ rows: any[]; rowCount: number | null }>,
) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  let released = false
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      return respond(sql, values)
    },
    release: () => {
      released = true
    },
  } as unknown as PoolClient
  return {
    pool: { connect: async () => client } as unknown as Pool,
    calls,
    released: () => released,
  }
}

function signingConfig() {
  const keys = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'order-key-v1',
  }
}

test('无信号结果直接完成 model run 且显式返回空 signal 和 candidate', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async () => ({ rows: [], rowCount: 1 }))
  const inputResult = {
    ...result(now),
    responseType: 'HOLD' as const,
    signal: null,
    proposedOrder: null,
  }

  const persisted = await new PostgresTradingOutcomeRepository(fake.pool).persist({
    userId,
    context: context(now),
    authority: authority(),
    result: inputResult,
  })

  assert.equal(persisted.signal, null)
  assert.equal(persisted.candidate, null)
  assert.equal(fake.calls.some(call => call.sql.includes('INSERT INTO changfu.signals')), false)
  assert.equal(fake.calls.some(call => call.sql.includes('UPDATE changfu.model_runs')), true)
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(fake.released(), true)
})

test('候选模式持久化候选草案但不生成真实订单 intent', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async () => ({ rows: [], rowCount: 1 }))
  const candidateAuthority = {
    ...authority(),
    role: 'PORTFOLIO_REVIEW' as const,
    executionMode: 'CANDIDATE_POOL' as const,
  }
  const candidateResult = {
    ...result(now),
    responseType: 'CANDIDATE' as const,
  }

  const persisted = await new PostgresTradingOutcomeRepository(fake.pool).persist({
    userId,
    context: context(now),
    authority: candidateAuthority,
    result: candidateResult,
  })

  assert.equal(persisted.orderIntent, null)
  assert.equal((persisted.candidate as { side: string }).side, 'BUY')
  assert.equal(
    (persisted.candidate as { orderDraft: { positionEffect: string } }).orderDraft.positionEffect,
    'OPEN_LONG',
  )
  assert.equal(
    fake.calls.some(call => call.sql.includes('INSERT INTO changfu.candidate_pool_items')),
    true,
  )
  assert.equal(fake.calls.some(call => call.sql.includes('SELECT intent_id, device_id')), false)
})

test('组合复核逐项更新候选，任一状态冲突时回滚', async () => {
  const now = new Date()
  let updateCount = 0
  const fake = fakeOutcomePool(async sql => {
    if (sql.includes('UPDATE changfu.candidate_pool_items')) {
      updateCount += 1
      return { rows: [], rowCount: updateCount === 1 ? 1 : 0 }
    }
    return { rows: [], rowCount: 1 }
  })
  const portfolioResult = {
    ...result(now),
    signal: null,
    proposedOrder: null,
    portfolioReview: [
      { candidateId: 'candidate-1', status: 'WATCH' as const, rank: 1, reason: '继续观察' },
      { candidateId: 'candidate-2', status: 'SUPPRESSED' as const, rank: 2, reason: '风险过高' },
    ],
  }

  await assert.rejects(
    () => new PostgresTradingOutcomeRepository(fake.pool).persist({
      userId,
      context: context(now),
      authority: { ...authority(), role: 'PORTFOLIO_REVIEW' },
      result: portfolioResult,
    }),
    /CANDIDATE_STATE_CONFLICT/,
  )

  assert.equal(updateCount, 2)
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(fake.released(), true)
})

test('待确认旧意图被新 HOLD 信号取代且不创建撤单 action', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async sql => {
    if (sql.includes('SELECT intent_id, device_id, state, order_spec')) {
      return {
        rows: [{
          intent_id: '44444444-4444-4444-8444-444444444444',
          device_id: deviceId,
          state: 'PENDING_CONFIRMATION',
          order_spec: {
            broker: 'FUTU',
            environment: 'REAL',
            market: 'US',
            symbol: 'US.AAPL',
            side: 'BUY',
            positionEffect: 'OPEN_LONG',
            orderType: 'MARKETABLE_LIMIT',
            tradingSession: 'RTH',
            timeInForce: 'DAY',
            quantity: '1',
            limitPrice: '200.00',
            currency: 'USD',
            maxSlippageBps: 15,
          },
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 1 }
  })
  const hold = {
    ...result(now),
    responseType: 'HOLD' as const,
    proposedOrder: null,
    signal: {
      symbol: 'US.AAPL',
      action: 'HOLD' as const,
      intent: 'HOLD' as const,
      confidence: 0,
    },
  }

  const persisted = await new PostgresTradingOutcomeRepository(fake.pool).persist({
    userId,
    context: context(now),
    authority: authority(),
    result: hold,
  })

  assert.equal(persisted.orderIntent, null)
  assert.equal(
    fake.calls.some(call => call.sql.includes("SET state = 'SUPERSEDED'")),
    true,
  )
  assert.equal(fake.calls.some(call => call.sql.includes('INSERT INTO changfu.order_actions')), false)
})

test('同向未变化订单与外部挂单均阻止生成重复 intent', async () => {
  const now = new Date()
  const existingOrder = {
    broker: 'FUTU',
    environment: 'REAL',
    market: 'US',
    symbol: 'US.AAPL',
    side: 'BUY',
    positionEffect: 'OPEN_LONG',
    orderType: 'MARKETABLE_LIMIT',
    tradingSession: 'RTH',
    timeInForce: 'DAY',
    quantity: '1',
    limitPrice: '200.00',
    currency: 'USD',
    maxSlippageBps: 15,
  }

  for (const openOrders of [[], [{ symbol: 'US.AAPL' }]]) {
    const fake = fakeOutcomePool(async sql => sql.includes(
      'SELECT intent_id, device_id, state, order_spec',
    )
      ? {
          rows: [{
            intent_id: '44444444-4444-4444-8444-444444444444',
            device_id: deviceId,
            state: 'TRACKING',
            order_spec: existingOrder,
          }],
          rowCount: 1,
        }
      : { rows: [], rowCount: 1 })
    const currentContext = { ...context(now), openOrders } as ContextEnvelope

    const persisted = await new PostgresTradingOutcomeRepository(
      fake.pool,
      signingConfig(),
    ).persist({
      userId,
      context: currentContext,
      authority: authority(),
      result: result(now),
    })

    assert.equal(persisted.orderIntent, null)
    assert.equal(
      fake.calls.some(call => call.sql.includes('INSERT INTO changfu.pending_orders')),
      false,
    )
  }
})

test('满足真实交易条件但缺少签名配置时事务失败关闭', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async sql => sql.includes(
    'SELECT intent_id, device_id, state, order_spec',
  )
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: 1 })

  await assert.rejects(
    () => new PostgresTradingOutcomeRepository(fake.pool).persist({
      userId,
      context: context(now),
      authority: authority(),
      result: result(now),
    }),
    /ORDER_INTENT_SIGNING_CONFIG_MISSING/,
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('风险拒绝和无效信号有效期均降级为无 intent 的结果', async () => {
  const now = new Date()
  const scenarios = [
    {
      context: {
        ...context(now),
        account: {
          ...context(now).account,
          buyingPower: { value: '0', currency: 'USD' },
        },
      } as ContextEnvelope,
      result: result(now),
      expectedRisk: 'LIVE_ORDER_RISK_INSUFFICIENT_BUYING_POWER',
    },
    {
      context: context(now),
      result: { ...result(now), sourceValidUntil: null },
      expectedRisk: 'LIVE_ORDER_RISK_SOURCE_EXPIRED',
    },
  ]

  for (const scenario of scenarios) {
    const fake = fakeOutcomePool(async sql => sql.includes(
      'SELECT intent_id, device_id, state, order_spec',
    )
      ? { rows: [], rowCount: 0 }
      : { rows: [], rowCount: 1 })
    const persisted = await new PostgresTradingOutcomeRepository(
      fake.pool,
      signingConfig(),
    ).persist({
      userId,
      context: scenario.context,
      authority: authority(),
      result: scenario.result,
    })

    assert.equal(persisted.orderIntent, null)
    assert.ok(persisted.risks.includes(scenario.expectedRisk))
    assert.equal(
      fake.calls.some(call => call.sql.includes('INSERT INTO changfu.pending_orders')),
      false,
    )
  }
})

test('非直接实盘条件分别阻止 HOLD、缺少草案、模拟盘及关闭硬门禁生成 intent', async () => {
  const now = new Date()
  const cases = [
    {
      authority: authority(),
      result: {
        ...result(now),
        responseType: 'HOLD' as const,
        signal: {
          symbol: 'US.AAPL',
          action: 'HOLD' as const,
          confidence: 0,
        },
        proposedOrder: null,
      },
    },
    {
      authority: authority(),
      result: { ...result(now), proposedOrder: null },
    },
    {
      authority: { ...authority(), executionMode: 'CANDIDATE_POOL' as const },
      result: result(now),
    },
    {
      authority: { ...authority(), environment: 'SIMULATE' as const },
      result: result(now),
    },
    {
      authority: { ...authority(), hardGateEnabled: false },
      result: result(now),
    },
  ]

  for (const item of cases) {
    const fake = fakeOutcomePool(async sql => sql.includes(
      'SELECT intent_id, device_id, state, order_spec',
    )
      ? { rows: [], rowCount: 0 }
      : { rows: [], rowCount: 1 })
    const persisted = await new PostgresTradingOutcomeRepository(
      fake.pool,
      signingConfig(),
    ).persist({
      userId,
      context: context(now),
      authority: item.authority,
      result: item.result,
    })
    assert.equal(persisted.orderIntent, null)
    assert.equal(
      fake.calls.some(call => call.sql.includes('INSERT INTO changfu.pending_orders')),
      false,
    )
  }
})

test('候选模式允许缺少订单草案并按 TTL 保存空草案', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async () => ({ rows: [], rowCount: 1 }))
  const persisted = await new PostgresTradingOutcomeRepository(fake.pool).persist({
    userId,
    context: context(now),
    authority: {
      ...authority(),
      role: 'PORTFOLIO_REVIEW',
      executionMode: 'CANDIDATE_POOL',
    },
    result: {
      ...result(now),
      responseType: 'CANDIDATE',
      proposedOrder: null,
    },
  })

  assert.equal((persisted.candidate as { orderDraft: unknown }).orderDraft, null)
  const insert = fake.calls.find(call => call.sql.includes(
    'INSERT INTO changfu.candidate_pool_items',
  ))
  assert.equal(insert?.values[8], 'null')
  assert.equal(
    (insert?.values[10] as Date).getTime() - (insert?.values[9] as Date).getTime(),
    600_000,
  )
})

test('组合复核成功更新候选状态、排名并提交', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async () => ({ rows: [], rowCount: 1 }))
  await new PostgresTradingOutcomeRepository(fake.pool).persist({
    userId,
    context: context(now),
    authority: { ...authority(), role: 'PORTFOLIO_REVIEW' },
    result: {
      ...result(now),
      signal: null,
      proposedOrder: null,
      portfolioReview: [{
        candidateId: 'candidate-1',
        status: 'PROMOTED',
        rank: 1,
        reason: '排名第一',
      }],
    },
  })

  const update = fake.calls.find(call => call.sql.includes(
    'UPDATE changfu.candidate_pool_items',
  ))
  assert.deepEqual(update?.values, [
    'candidate-1',
    userId,
    brokerConnectionId,
    3,
    'PROMOTED',
    1,
  ])
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('买入加仓、回补、平多和卖空映射为正确订单方向', async () => {
  const now = new Date()
  const scenarios = [
    {
      action: 'BUY' as const,
      positions: [{ symbol: 'US.AAPL', side: 'LONG', quantity: '2', availableQuantity: '2' }],
      expectedEffect: 'ADD_LONG',
    },
    {
      action: 'BUY_TO_COVER' as const,
      positions: [{ symbol: 'US.AAPL', side: 'SHORT', quantity: '2', availableQuantity: '2' }],
      expectedEffect: 'COVER_SHORT',
    },
    {
      action: 'SELL_TO_CLOSE' as const,
      positions: [{ symbol: 'US.AAPL', side: 'LONG', quantity: '2', availableQuantity: '2' }],
      expectedEffect: 'REDUCE_LONG',
    },
    {
      action: 'SELL_SHORT' as const,
      positions: [],
      expectedEffect: 'OPEN_SHORT',
    },
    {
      action: 'SELL_SHORT' as const,
      positions: [{ symbol: 'US.AAPL', side: 'SHORT', quantity: '2', availableQuantity: '2' }],
      expectedEffect: 'ADD_SHORT',
    },
  ]

  for (const scenario of scenarios) {
    const fake = fakeOutcomePool(async sql => sql.includes(
      'SELECT intent_id, device_id, state, order_spec',
    )
      ? { rows: [], rowCount: 0 }
      : { rows: [], rowCount: 1 })
    const baseContext = context(now)
    const currentContext = {
      ...baseContext,
      positions: scenario.positions,
      account: {
        ...(baseContext.account as Record<string, unknown>),
        marginAccount: true,
        shortRiskDisclosureAccepted: true,
      },
      quotes: [{
        ...(baseContext.quotes[0] as Record<string, unknown>),
        shortable: true,
        maxShortQuantity: 10,
      }],
    } as ContextEnvelope
    const baseResult = result(now)
    const persisted = await new PostgresTradingOutcomeRepository(
      fake.pool,
      signingConfig(),
    ).persist({
      userId,
      context: currentContext,
      authority: authority(),
      result: {
        ...baseResult,
        proposedOrder: { ...baseResult.proposedOrder!, action: scenario.action },
        signal: {
          symbol: 'US.AAPL',
          action: scenario.action === 'BUY' || scenario.action === 'BUY_TO_COVER'
            ? 'BUY' as const
            : 'SELL' as const,
          intent: scenario.action,
          confidence: 0.8,
        },
      },
    })

    assert.equal(
      (persisted.orderIntent as SignedOrderIntent).order.positionEffect,
      scenario.expectedEffect,
    )
  }
})

test('候选 HOLD 不创建候选项，缺省 intent 仍按 HOLD 取代待确认订单', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async sql => {
    if (sql.includes('SELECT intent_id, device_id, state, order_spec')) {
      return {
        rows: [{
          intent_id: '44444444-4444-4444-8444-444444444444',
          device_id: deviceId,
          state: 'CLAIMED',
          order_spec: {
            broker: 'FUTU',
            environment: 'REAL',
            market: 'US',
            symbol: 'US.AAPL',
            side: 'BUY',
            positionEffect: 'OPEN_LONG',
            orderType: 'MARKETABLE_LIMIT',
            tradingSession: 'RTH',
            timeInForce: 'DAY',
            quantity: '1',
            limitPrice: '200.00',
            currency: 'USD',
            maxSlippageBps: 15,
          },
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 1 }
  })

  const persisted = await new PostgresTradingOutcomeRepository(fake.pool).persist({
    userId,
    context: context(now),
    authority: authority(),
    result: {
      ...result(now),
      responseType: 'CANDIDATE',
      proposedOrder: null,
      signal: { symbol: 'US.AAPL', action: 'HOLD', confidence: 0 },
    },
  })

  assert.equal(persisted.candidate, null)
  assert.equal(
    fake.calls.some(call => call.sql.includes('INSERT INTO changfu.candidate_pool_items')),
    false,
  )
  assert.equal(
    fake.calls.some(call => call.sql.includes("SET state = 'SUPERSEDED'")),
    true,
  )
})

test('签名配置缺少 keyId 时失败，非法日期字符串按过期风险降级', async () => {
  const now = new Date()
  const noExisting = async (sql: string) => sql.includes(
    'SELECT intent_id, device_id, state, order_spec',
  )
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: 1 }
  const keys = signingConfig()
  const missingKeyFake = fakeOutcomePool(noExisting)

  await assert.rejects(
    () => new PostgresTradingOutcomeRepository(missingKeyFake.pool, {
      privateKeyPem: keys.privateKeyPem,
      keyId: '',
    }).persist({
      userId,
      context: context(now),
      authority: authority(),
      result: result(now),
    }),
    /ORDER_INTENT_SIGNING_CONFIG_MISSING/,
  )

  const invalidDateFake = fakeOutcomePool(noExisting)
  const persisted = await new PostgresTradingOutcomeRepository(
    invalidDateFake.pool,
    keys,
  ).persist({
    userId,
    context: context(now),
    authority: authority(),
    result: { ...result(now), sourceValidUntil: 'not-a-date' },
  })
  assert.ok(persisted.risks.includes('LIVE_ORDER_RISK_SOURCE_EXPIRED'))
})

test('提交中订单阻断重入，伪造终态查询结果则允许生成新 intent', async () => {
  const now = new Date()
  for (const [state, createsIntent] of [
    ['SUBMITTING', false],
    ['FILLED', true],
  ] as const) {
    const fake = fakeOutcomePool(async sql => sql.includes(
      'SELECT intent_id, device_id, state, order_spec',
    )
      ? {
          rows: [{
            intent_id: '44444444-4444-4444-8444-444444444444',
            device_id: deviceId,
            state,
            order_spec: {
              broker: 'FUTU',
              environment: 'REAL',
              market: 'US',
              symbol: 'US.AAPL',
              side: 'BUY',
              positionEffect: 'OPEN_LONG',
              orderType: 'MARKETABLE_LIMIT',
              tradingSession: 'RTH',
              timeInForce: 'DAY',
              quantity: '1',
              limitPrice: '200.00',
              currency: 'USD',
              maxSlippageBps: 15,
            },
          }],
          rowCount: 1,
        }
      : { rows: [], rowCount: 1 })

    const persisted = await new PostgresTradingOutcomeRepository(
      fake.pool,
      signingConfig(),
    ).persist({
      userId,
      context: context(now),
      authority: authority(),
      result: result(now),
    })

    assert.equal(Boolean(persisted.orderIntent), createsIntent)
  }
})

test('港股订单使用 HKD、更新时间行情和 lot size 风控生成 intent', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async sql => sql.includes(
    'SELECT intent_id, device_id, state, order_spec',
  )
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: 1 })
  const baseContext = context(now)
  const hkContext = {
    ...baseContext,
    account: {
      ...(baseContext.account as Record<string, unknown>),
      buyingPower: { value: '100000', currency: 'HKD' },
    },
    quotes: [{
      symbol: 'HK.00700',
      market: 'HK',
      updateTime: now.toISOString(),
      lastPrice: '400',
      lotSize: 100,
    }],
    marketSessions: [{ market: 'HK', state: 'OPEN', sourceAt: now.toISOString() }],
    requestedSymbols: ['HK.00700'],
  } as ContextEnvelope
  const baseResult = result(now)
  const persisted = await new PostgresTradingOutcomeRepository(
    fake.pool,
    signingConfig(),
  ).persist({
    userId,
    context: hkContext,
    authority: {
      ...authority(),
      requestedSymbols: ['HK.00700'],
      instrument: { market: 'HK', instrumentType: 'STOCK' },
    },
    result: {
      ...baseResult,
      proposedOrder: {
        symbol: 'HK.00700',
        action: 'BUY',
        quantity: '100',
        limitPrice: '400',
      },
      signal: {
        symbol: 'HK.00700',
        action: 'BUY',
        intent: 'BUY',
        confidence: 0.8,
      },
    },
  })

  const order = (persisted.orderIntent as SignedOrderIntent).order
  assert.equal(order.market, 'HK')
  assert.equal(order.currency, 'HKD')
})

test('缺少行情对象时通过风险结果拒绝订单而非抛出异常', async () => {
  const now = new Date()
  const fake = fakeOutcomePool(async sql => sql.includes(
    'SELECT intent_id, device_id, state, order_spec',
  )
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: 1 })
  const persisted = await new PostgresTradingOutcomeRepository(
    fake.pool,
    signingConfig(),
  ).persist({
    userId,
    context: { ...context(now), quotes: [] },
    authority: authority(),
    result: result(now),
  })

  assert.equal(persisted.orderIntent, null)
  assert.ok(persisted.risks.includes('LIVE_ORDER_RISK_QUOTE_STALE'))
})
