import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import {
  LiveTradingConflictError,
  PostgresLiveTradingRepository,
} from '../packages/persistence/src/postgresLiveTradingRepository.js'

const userId = '42'
const deviceId = '11111111-1111-4111-8111-111111111111'
const intentId = '22222222-2222-4222-8222-222222222222'
const actionId = '33333333-3333-4333-8333-333333333333'
const brokerConnectionId = '55555555-5555-4555-8555-555555555555'
const executionId = '44444444-4444-4444-8444-444444444444'
const now = new Date('2026-09-29T08:00:00.000Z')

type QueryCall = { sql: string; values: unknown[] }
type QueryResponse = { rows: any[]; rowCount: number | null }

function fakeClient(
  respond: (sql: string, values: unknown[], calls: QueryCall[]) => QueryResponse | Promise<QueryResponse>,
): { client: PoolClient; calls: QueryCall[]; released: () => boolean } {
  const calls: QueryCall[] = []
  let didRelease = false
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      return respond(sql, values, calls)
    },
    release: () => {
      didRelease = true
    },
  } as unknown as PoolClient
  return { client, calls, released: () => didRelease }
}

function poolForClient(client: PoolClient): Pool {
  return { connect: async () => client } as unknown as Pool
}

function signedIntentRow(overrides: Record<string, unknown> = {}) {
  return {
    execution_id: executionId,
    intent_id: intentId,
    broker_request_hash: 'request-hash',
    provider: 'FUTU',
    broker_connection_id: brokerConnectionId,
    submission_mode: 'MANUAL_CONFIRM',
    order_spec: { symbol: 'AAPL', quantity: 2 },
    signature: 'signature',
    signing_key_id: 'key-1',
    account_id_hash: 'account-hash',
    context_hash: 'context-hash',
    strategy_version: 'strategy-v1',
    trading_session_id: null,
    research_pool_version: '12',
    trading_config_version: '7',
    risk_policy_version: 'risk-v1',
    client_revalidation: { quoteAgeMs: 100 },
    issued_at: new Date('2026-09-29T07:59:00.000Z'),
    expires_at: new Date('2026-09-29T08:05:00.000Z'),
    ...overrides,
  }
}

test('真实订单 claim 在硬门禁关闭时不访问数据库', async () => {
  let queried = false
  const pool = {
    query: async () => {
      queried = true
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Pool

  await assert.rejects(
    () => new PostgresLiveTradingRepository(pool).claimOrder({
      intentId,
      userId,
      deviceId,
      expectedVersion: 1,
      gate: { provider: 'FUTU', hardGateEnabled: false },
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'PROVIDER_HARD_GATE_DISABLED',
  )
  assert.equal(queried, false)
})

test('AUTO_EXECUTE claim 同时重验用户开关与有效交易会话', async () => {
  let queryText = ''
  const pool = {
    query: async (sql: string) => {
      queryText = sql
      return { rows: [{ version: '2' }], rowCount: 1 }
    },
  } as unknown as Pool

  const result = await new PostgresLiveTradingRepository(pool).claimOrder({
    intentId,
    userId,
    deviceId,
    expectedVersion: 1,
    gate: { provider: 'LONGBRIDGE', hardGateEnabled: true },
  })

  assert.equal(result.version, 2)
  assert.match(queryText, /user_provider_execution_settings/)
  assert.match(queryText, /setting\.auto_submit_enabled = true/)
  assert.match(queryText, /session\.session_id = p\.trading_session_id/)
  assert.match(queryText, /session\.expires_at > \$8::timestamptz/)
})

test('提交回执无法同步 pending 投影时整笔事务回滚', async () => {
  const statements: string[] = []
  let released = false
  const client = {
    query: async (sql: string) => {
      statements.push(sql)
      if (sql.includes('UPDATE changfu.order_executions')) {
        return { rows: [{ intent_id: intentId }], rowCount: 1 }
      }
      if (sql.includes('UPDATE changfu.pending_orders')) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: null }
    },
    release: () => {
      released = true
    },
  } as unknown as PoolClient
  const pool = { connect: async () => client } as unknown as Pool

  await assert.rejects(
    () => new PostgresLiveTradingRepository(pool).recordExecutionResult({
      executionId: '44444444-4444-4444-8444-444444444444',
      userId,
      deviceId,
      status: 'SUBMITTED',
      brokerOrderId: 'broker-1',
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_EXECUTION_PROJECTION_CONFLICT',
  )
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('INSERT INTO changfu.order_events')), false)
  assert.equal(released, true)
})

test('撤单 action 可在旧 claim 过期后重新认领并校验 Provider 一致', async () => {
  let queryText = ''
  const pool = {
    query: async (sql: string) => {
      queryText = sql
      return { rows: [{ version: '7' }], rowCount: 1 }
    },
  } as unknown as Pool

  const result = await new PostgresLiveTradingRepository(pool).claimOrderAction({
    actionId,
    userId,
    deviceId,
    expectedVersion: 6,
  })

  assert.equal(result.version, 7)
  assert.match(queryText, /action\.state IN \('EXECUTING', 'UNKNOWN'\)/)
  assert.match(queryText, /action\.claim_expires_at <= \$7::timestamptz/)
  assert.match(queryText, /connection\.broker = action\.provider/)
})

test('撤单执行失败保持 UNKNOWN 可恢复并将订单冻结为 CANCEL_UNCERTAIN', async () => {
  const updates: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      updates.push({ sql, values })
      if (sql.includes('UPDATE changfu.order_actions')) {
        return { rows: [{ intent_id: intentId }], rowCount: 1 }
      }
      if (sql.includes('UPDATE changfu.pending_orders')) {
        return {
          rows: [{
            provider: 'FUTU',
            broker_connection_id: '55555555-5555-4555-8555-555555555555',
            quantity: '1',
            broker_order_id: 'broker-1',
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: null }
    },
    release: () => undefined,
  } as unknown as PoolClient
  const pool = { connect: async () => client } as unknown as Pool

  await new PostgresLiveTradingRepository(pool).recordOrderActionResult({
    actionId,
    userId,
    deviceId,
    claimToken: 'claim-token',
    status: 'FAILED',
    resultSummary: { errorCode: 'BROKER_TIMEOUT' },
  })

  const actionUpdate = updates.find(item => item.sql.includes('UPDATE changfu.order_actions'))
  const pendingUpdate = updates.find(item => item.sql.includes('UPDATE changfu.pending_orders'))
  assert.equal(actionUpdate?.values[4], 'UNKNOWN')
  assert.equal(pendingUpdate?.values[3], 'CANCEL_UNCERTAIN')
  assert.equal(updates.at(-1)?.sql, 'COMMIT')
})

test('券商回执摘要含敏感字段时在落库前失败关闭', async () => {
  let connected = false
  const pool = {
    connect: async () => {
      connected = true
      throw new Error('unreachable')
    },
  } as unknown as Pool

  await assert.rejects(
    () => new PostgresLiveTradingRepository(pool).recordExecutionResult({
      executionId: '44444444-4444-4444-8444-444444444444',
      userId,
      deviceId,
      status: 'FAILED',
      responseSummary: { nested: { accessToken: 'must-not-persist' } },
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'UNSAFE_EXECUTION_SUMMARY',
  )
  assert.equal(connected, false)
})

test('读取执行设置时合并持久化设置、硬门禁和资格阻断项', async () => {
  const calls: QueryCall[] = []
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      if (sql.includes('user_provider_execution_settings')) {
        return { rows: [{ auto_submit_enabled: true, version: '9' }], rowCount: 1 }
      }
      return {
        rows: [{
          subscription_active: false,
          slot_active: true,
          real_connection_active: false,
        }],
        rowCount: 1,
      }
    },
  } as unknown as Pool

  const setting = await new PostgresLiveTradingRepository(pool).getExecutionSetting(
    userId,
    { provider: 'FUTU', hardGateEnabled: false },
  )

  assert.deepEqual(setting, {
    provider: 'FUTU',
    hardGateEnabled: false,
    autoSubmitEnabled: true,
    version: 9,
    blockers: [
      'PROVIDER_HARD_GATE_DISABLED',
      'SUBSCRIPTION_INACTIVE',
      'REAL_CONNECTION_REQUIRED',
    ],
  })
  assert.deepEqual(calls.map(call => call.values), [[userId, 'FUTU'], [userId, 'FUTU']])
})

test('读取不存在的执行设置时返回关闭状态和零版本', async () => {
  const pool = {
    query: async (sql: string) => sql.includes('user_provider_execution_settings')
      ? { rows: [], rowCount: 0 }
      : {
          rows: [{
            subscription_active: true,
            slot_active: false,
            real_connection_active: true,
          }],
          rowCount: 1,
        },
  } as unknown as Pool

  const setting = await new PostgresLiveTradingRepository(pool).getExecutionSetting(
    userId,
    { provider: 'LONGBRIDGE', hardGateEnabled: true },
  )

  assert.deepEqual(setting, {
    provider: 'LONGBRIDGE',
    hardGateEnabled: true,
    autoSubmitEnabled: false,
    version: 0,
    blockers: ['PROVIDER_SLOT_INACTIVE'],
  })
})

test('更新执行设置成功时递增版本并提交事务', async () => {
  const updatedAt = new Date('2026-09-29T08:01:00.000Z')
  const fake = fakeClient((sql) => {
    if (sql.includes('FOR UPDATE')) {
      return { rows: [{ auto_submit_enabled: false, version: '3' }], rowCount: 1 }
    }
    if (sql.includes('subscription_active')) {
      return {
        rows: [{
          subscription_active: true,
          slot_active: true,
          real_connection_active: true,
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('INSERT INTO changfu.user_provider_execution_settings')) {
      return { rows: [{ updated_at: updatedAt }], rowCount: 1 }
    }
    return { rows: [], rowCount: null }
  })

  const setting = await new PostgresLiveTradingRepository(poolForClient(fake.client))
    .updateExecutionSetting({
      userId,
      gate: { provider: 'FUTU', hardGateEnabled: true },
      autoSubmitEnabled: true,
      expectedVersion: 3,
    })

  assert.deepEqual(setting, {
    provider: 'FUTU',
    hardGateEnabled: true,
    autoSubmitEnabled: true,
    version: 4,
    blockers: [],
    updatedAt: updatedAt.toISOString(),
  })
  assert.deepEqual(fake.calls.filter(call => ['BEGIN', 'COMMIT'].includes(call.sql)).map(call => call.sql), [
    'BEGIN',
    'COMMIT',
  ])
  assert.equal(fake.released(), true)
})

test('更新执行设置版本冲突时回滚且不执行保存', async () => {
  const fake = fakeClient((sql) => sql.includes('FOR UPDATE')
    ? { rows: [{ auto_submit_enabled: false, version: '4' }], rowCount: 1 }
    : { rows: [], rowCount: null })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).updateExecutionSetting({
      userId,
      gate: { provider: 'FUTU', hardGateEnabled: true },
      autoSubmitEnabled: true,
      expectedVersion: 3,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'EXECUTION_SETTING_VERSION_CONFLICT',
  )
  assert.equal(fake.calls.some(call => call.sql.includes('INSERT INTO')), false)
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(fake.released(), true)
})

test('更新执行设置开启自动提交但资格不满足时回滚', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('FOR UPDATE')) {
      return { rows: [{ auto_submit_enabled: false, version: '0' }], rowCount: 1 }
    }
    if (sql.includes('subscription_active')) {
      return {
        rows: [{
          subscription_active: true,
          slot_active: true,
          real_connection_active: true,
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: null }
  })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).updateExecutionSetting({
      userId,
      gate: { provider: 'FUTU', hardGateEnabled: false },
      autoSubmitEnabled: true,
      expectedVersion: 0,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'PROVIDER_HARD_GATE_DISABLED',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('待处理订单列表限定连接和活跃状态并转换版本号', async () => {
  let captured: QueryCall | undefined
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      captured = { sql, values }
      return { rows: [{ intentId, version: '11', state: 'TRACKING' }], rowCount: 1 }
    },
  } as unknown as Pool

  const rows = await new PostgresLiveTradingRepository(pool)
    .listPendingOrders(userId, deviceId, brokerConnectionId)

  assert.deepEqual(rows, [{ intentId, version: 11, state: 'TRACKING' }])
  assert.deepEqual(captured?.values.slice(0, 3), [userId, deviceId, brokerConnectionId])
  assert.deepEqual(captured?.values[3], [
    'PENDING_CONFIRMATION',
    'CLAIMED',
    'SUBMITTING',
    'SUBMITTED',
    'TRACKING',
    'PARTIALLY_FILLED',
    'CANCEL_REQUESTED',
    'CANCEL_PENDING',
    'CANCEL_UNCERTAIN',
    'UNKNOWN',
  ])
})

test('订单 claim 无匹配行时返回前置条件冲突', async () => {
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool

  await assert.rejects(
    () => new PostgresLiveTradingRepository(pool).claimOrder({
      intentId,
      userId,
      deviceId,
      expectedVersion: 1,
      gate: { provider: 'FUTU', hardGateEnabled: true },
      now,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_CLAIM_PRECONDITION_FAILED',
  )
})

test('开始提交命中一致幂等记录时返回签名意图且不重复写入', async () => {
  const fake = fakeClient((sql) => sql.includes('FROM changfu.order_executions execution')
    ? { rows: [signedIntentRow()], rowCount: 1 }
    : { rows: [], rowCount: null })

  const result = await new PostgresLiveTradingRepository(poolForClient(fake.client))
    .beginSubmission({
      intentId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      idempotencyKey: 'idem-1',
      brokerRequestHash: 'request-hash',
      gate: { provider: 'FUTU', hardGateEnabled: true },
      now,
    })

  assert.equal(result.executionId, executionId)
  assert.deepEqual(result.intent, {
    schemaVersion: '2.0',
    intentId,
    userId,
    deviceId,
    brokerConnectionId,
    provider: 'FUTU',
    accountIdHash: 'account-hash',
    contextHash: 'context-hash',
    strategyVersion: 'strategy-v1',
    sessionId: null,
    poolVersion: 12,
    configVersion: 7,
    riskPolicyVersion: 'risk-v1',
    executionMode: 'MANUAL_CONFIRM',
    clientRevalidation: { quoteAgeMs: 100 },
    order: { symbol: 'AAPL', quantity: 2 },
    issuedAt: '2026-09-29T07:59:00.000Z',
    expiresAt: '2026-09-29T08:05:00.000Z',
    keyId: 'key-1',
    signature: 'signature',
  })
  assert.equal(fake.calls.some(call => call.sql.includes('INSERT INTO changfu.order_executions')), false)
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('开始提交命中不一致幂等记录时回滚', async () => {
  const fake = fakeClient((sql) => sql.includes('FROM changfu.order_executions execution')
    ? { rows: [signedIntentRow({ broker_request_hash: 'different' })], rowCount: 1 }
    : { rows: [], rowCount: null })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).beginSubmission({
      intentId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      idempotencyKey: 'idem-1',
      brokerRequestHash: 'request-hash',
      gate: { provider: 'FUTU', hardGateEnabled: true },
      now,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'SUBMISSION_IDEMPOTENCY_CONFLICT',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(fake.released(), true)
})

test('开始手动提交成功时锁定订单范围、写入执行记录并提交', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('FROM changfu.order_executions execution')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT p.intent_id, p.provider')) {
      return { rows: [signedIntentRow()], rowCount: 1 }
    }
    return { rows: [], rowCount: null }
  })

  const result = await new PostgresLiveTradingRepository(poolForClient(fake.client))
    .beginSubmission({
      intentId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      idempotencyKey: 'idem-new',
      brokerRequestHash: 'request-hash',
      gate: { provider: 'FUTU', hardGateEnabled: true },
      now,
    })

  assert.match(result.executionId, /^[0-9a-f-]{36}$/)
  assert.equal((result.intent as { intentId: string }).intentId, intentId)
  assert.deepEqual(
    fake.calls.find(call => call.sql.includes('pg_advisory_xact_lock'))?.values,
    [`live-order:${userId}:${brokerConnectionId}:AAPL`],
  )
  const pendingSelect = fake.calls.find(call => call.sql.includes('SELECT p.intent_id, p.provider'))
  assert.match(String(pendingSelect?.values[4]), /^[0-9a-f]{64}$/)
  assert.notEqual(pendingSelect?.values[4], 'claim-token')
  assert.equal(fake.calls.some(call => call.sql.includes('INSERT INTO changfu.order_executions')), true)
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('开始自动提交但交易会话失效时回滚且不创建执行记录', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('FROM changfu.order_executions execution')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT p.intent_id, p.provider')) {
      return {
        rows: [signedIntentRow({
          submission_mode: 'AUTO_EXECUTE',
          trading_session_id: '66666666-6666-4666-8666-666666666666',
        })],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM changfu.trading_sessions')) {
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: null }
  })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).beginSubmission({
      intentId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      idempotencyKey: 'idem-auto',
      brokerRequestHash: 'request-hash',
      gate: { provider: 'FUTU', hardGateEnabled: true },
      now,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'AUTO_SESSION_REQUIRED',
  )
  assert.equal(fake.calls.some(call => call.sql.includes('INSERT INTO changfu.order_executions')), false)
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('开始提交找不到订单锁范围时回滚', async () => {
  const fake = fakeClient((sql) => sql.includes('FROM changfu.order_executions execution')
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: null })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).beginSubmission({
      intentId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      idempotencyKey: 'idem-missing',
      brokerRequestHash: 'request-hash',
      gate: { provider: 'FUTU', hardGateEnabled: true },
      now,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_NOT_FOUND',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('开始提交在硬门禁关闭时不连接数据库', async () => {
  let connected = false
  const pool = {
    connect: async () => {
      connected = true
      throw new Error('unreachable')
    },
  } as unknown as Pool

  await assert.rejects(
    () => new PostgresLiveTradingRepository(pool).beginSubmission({
      intentId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      idempotencyKey: 'idem-gated',
      brokerRequestHash: 'request-hash',
      gate: { provider: 'FUTU', hardGateEnabled: false },
      now,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'PROVIDER_HARD_GATE_DISABLED',
  )
  assert.equal(connected, false)
})

test('记录提交成功回执时同步订单投影和事件数值摘要', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('UPDATE changfu.order_executions')) {
      return { rows: [{ intent_id: intentId }], rowCount: 1 }
    }
    if (sql.includes('UPDATE changfu.pending_orders')) {
      return {
        rows: [{
          provider: 'FUTU',
          broker_connection_id: brokerConnectionId,
          quantity: '2.5',
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: null }
  })

  await new PostgresLiveTradingRepository(poolForClient(fake.client)).recordExecutionResult({
    executionId,
    userId,
    deviceId,
    status: 'SUBMITTED',
    brokerOrderId: 'broker-order-1',
    resultCode: 'OK',
    responseSummary: { filledQuantity: '1.5', averagePrice: '193.25' },
    now,
  })

  const event = fake.calls.find(call => call.sql.includes('INSERT INTO changfu.order_events'))
  assert.deepEqual(event?.values.slice(3, 9), [
    'broker-order-1',
    'SUBMITTED',
    2.5,
    1.5,
    193.25,
    'OK',
  ])
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(fake.released(), true)
})

test('记录提交回执找不到执行记录时回滚', async () => {
  const fake = fakeClient((sql) => sql.includes('UPDATE changfu.order_executions')
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: null })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).recordExecutionResult({
      executionId,
      userId,
      deviceId,
      status: 'UNKNOWN',
      responseSummary: null,
      now,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'EXECUTION_RESULT_CONFLICT',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('拒绝订单成功时持有范围锁并提交', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    if (sql.includes('UPDATE changfu.pending_orders pending')) {
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: null }
  })

  await new PostgresLiveTradingRepository(poolForClient(fake.client)).rejectOrder({
    intentId,
    userId,
    deviceId,
    reasonCode: 'USER_REJECTED',
  })

  assert.equal(fake.calls.some(call => call.sql.includes('pg_advisory_xact_lock')), true)
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('拒绝订单更新冲突时回滚', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: sql.includes('UPDATE changfu.pending_orders pending') ? 0 : null }
  })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).rejectOrder({
      intentId,
      userId,
      deviceId,
      reasonCode: 'USER_REJECTED',
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_REJECT_CONFLICT',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('首次请求撤单时更新订单状态、创建 action 并提交', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT pending.provider')) {
      return {
        rows: [{ provider: 'FUTU', broker_connection_id: brokerConnectionId, state: 'SUBMITTED' }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT action_id, intent_id')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('INSERT INTO changfu.order_actions')) {
      return { rows: [{ action_id: actionId }], rowCount: 1 }
    }
    return { rows: [], rowCount: null }
  })

  const result = await new PostgresLiveTradingRepository(poolForClient(fake.client)).requestCancel({
    intentId,
    userId,
    deviceId,
    reasonCode: 'USER_REQUESTED',
    idempotencyKey: 'cancel-1',
  })

  assert.deepEqual(result, { actionId })
  assert.equal(
    fake.calls.some(call => call.sql.includes("SET state = 'CANCEL_REQUESTED'")),
    true,
  )
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('重复撤单请求复用已落库 action 且不重复改变取消状态', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT pending.provider')) {
      return {
        rows: [{
          provider: 'FUTU',
          broker_connection_id: brokerConnectionId,
          state: 'CANCEL_PENDING',
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT action_id, intent_id')) {
      return { rows: [{ action_id: actionId, intent_id: intentId }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO changfu.order_actions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("WHERE intent_id = $1::uuid AND action_type = 'CANCEL'")) {
      return { rows: [{ action_id: actionId }], rowCount: 1 }
    }
    return { rows: [], rowCount: null }
  })

  const result = await new PostgresLiveTradingRepository(poolForClient(fake.client)).requestCancel({
    intentId,
    userId,
    deviceId,
    reasonCode: 'RETRY',
    idempotencyKey: 'cancel-1',
  })

  assert.deepEqual(result, { actionId })
  assert.equal(
    fake.calls.some(call => call.sql.includes("SET state = 'CANCEL_REQUESTED'")),
    false,
  )
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('撤单幂等键绑定其他订单时回滚', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT pending.provider')) {
      return {
        rows: [{
          provider: 'FUTU',
          broker_connection_id: brokerConnectionId,
          state: 'CANCEL_REQUESTED',
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT action_id, intent_id')) {
      return {
        rows: [{ action_id: actionId, intent_id: '77777777-7777-4777-8777-777777777777' }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: null }
  })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).requestCancel({
      intentId,
      userId,
      deviceId,
      reasonCode: 'RETRY',
      idempotencyKey: 'cancel-conflict',
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_ACTION_IDEMPOTENCY_CONFLICT',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('撤单前置订单状态不满足时回滚', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('SELECT broker_connection_id, normalized_symbol')) {
      return {
        rows: [{ broker_connection_id: brokerConnectionId, normalized_symbol: 'AAPL' }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).requestCancel({
      intentId,
      userId,
      deviceId,
      reasonCode: 'INVALID_STATE',
      idempotencyKey: 'cancel-invalid',
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_CANCEL_PRECONDITION_FAILED',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('待执行 action 列表限定连接并转换版本号', async () => {
  let captured: QueryCall | undefined
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      captured = { sql, values }
      return { rows: [{ actionId, state: 'PENDING', version: '5' }], rowCount: 1 }
    },
  } as unknown as Pool

  const rows = await new PostgresLiveTradingRepository(pool)
    .listOrderActions(userId, deviceId, brokerConnectionId)

  assert.deepEqual(rows, [{ actionId, state: 'PENDING', version: 5 }])
  assert.deepEqual(captured?.values, [userId, deviceId, brokerConnectionId])
  assert.match(captured?.sql ?? '', /state IN \('PENDING', 'CLAIMED', 'EXECUTING', 'UNKNOWN'\)/)
})

test('action claim 无匹配行时返回冲突', async () => {
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool

  await assert.rejects(
    () => new PostgresLiveTradingRepository(pool).claimOrderAction({
      actionId,
      userId,
      deviceId,
      expectedVersion: 2,
      now,
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_ACTION_CLAIM_CONFLICT',
  )
})

test('记录撤单完成结果时完成 action、同步订单并写入事件', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('UPDATE changfu.order_actions')) {
      return { rows: [{ intent_id: intentId }], rowCount: 1 }
    }
    if (sql.includes('UPDATE changfu.pending_orders AS pending')) {
      return {
        rows: [{
          provider: 'FUTU',
          broker_connection_id: brokerConnectionId,
          quantity: '4',
          broker_order_id: 'broker-order-1',
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: null }
  })

  await new PostgresLiveTradingRepository(poolForClient(fake.client)).recordOrderActionResult({
    actionId,
    userId,
    deviceId,
    claimToken: 'claim-token',
    status: 'CANCELLED',
    resultSummary: { filledQuantity: 1, averagePrice: 20.5 },
  })

  const actionUpdate = fake.calls.find(call => call.sql.includes('UPDATE changfu.order_actions'))
  const event = fake.calls.find(call => call.sql.includes('INSERT INTO changfu.order_events'))
  assert.equal(actionUpdate?.values[4], 'COMPLETED')
  assert.deepEqual(event?.values.slice(3, 9), [
    'broker-order-1',
    'CANCELLED',
    4,
    1,
    20.5,
    null,
  ])
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('记录 action 结果遇到已终态订单时兼容提交且不重复写事件', async () => {
  const fake = fakeClient((sql) => {
    if (sql.includes('UPDATE changfu.order_actions')) {
      return { rows: [{ intent_id: intentId }], rowCount: 1 }
    }
    if (sql.includes('UPDATE changfu.pending_orders AS pending')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("pending.state IN ('FILLED', 'CANCELLED')")) {
      return {
        rows: [{
          provider: 'FUTU',
          broker_connection_id: brokerConnectionId,
          quantity: '4',
          broker_order_id: 'broker-order-1',
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: null }
  })

  await new PostgresLiveTradingRepository(poolForClient(fake.client)).recordOrderActionResult({
    actionId,
    userId,
    deviceId,
    claimToken: 'claim-token',
    status: 'FILLED',
  })

  assert.equal(fake.calls.some(call => call.sql.includes('INSERT INTO changfu.order_events')), false)
  assert.equal(fake.calls.at(-1)?.sql, 'COMMIT')
})

test('记录 action 结果找不到 action 时回滚', async () => {
  const fake = fakeClient((sql) => sql.includes('UPDATE changfu.order_actions')
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: null })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).recordOrderActionResult({
      actionId,
      userId,
      deviceId,
      claimToken: 'wrong-token',
      status: 'CANCEL_PENDING',
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_ACTION_RESULT_CONFLICT',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('记录 action 结果无法同步且订单非终态时回滚', async () => {
  const fake = fakeClient((sql) => sql.includes('UPDATE changfu.order_actions')
    ? { rows: [{ intent_id: intentId }], rowCount: 1 }
    : { rows: [], rowCount: 0 })

  await assert.rejects(
    () => new PostgresLiveTradingRepository(poolForClient(fake.client)).recordOrderActionResult({
      actionId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      status: 'CANCEL_UNCERTAIN',
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'ORDER_ACTION_PROJECTION_CONFLICT',
  )
  assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK')
})

test('action 结果摘要数组深处含敏感字段时在连接数据库前拒绝', async () => {
  let connected = false
  const pool = {
    connect: async () => {
      connected = true
      throw new Error('unreachable')
    },
  } as unknown as Pool

  await assert.rejects(
    () => new PostgresLiveTradingRepository(pool).recordOrderActionResult({
      actionId,
      userId,
      deviceId,
      claimToken: 'claim-token',
      status: 'FAILED',
      resultSummary: { attempts: [{ private_key: 'must-not-persist' }] },
    }),
    (error: unknown) => error instanceof LiveTradingConflictError
      && error.code === 'UNSAFE_EXECUTION_SUMMARY',
  )
  assert.equal(connected, false)
})
