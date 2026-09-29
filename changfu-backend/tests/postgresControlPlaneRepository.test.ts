import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import {
  ControlPlaneConflictError,
  PostgresControlPlaneRepository,
  type TradingConfigData,
} from '../packages/persistence/src/postgresControlPlaneRepository.js'

type QueryResult = {
  rows: Array<Record<string, any>>
  rowCount?: number | null
}

type QueryStep =
  | QueryResult
  | Error
  | ((sql: string, values: unknown[]) => QueryResult | Promise<QueryResult>)

type QueryCall = {
  sql: string
  values: unknown[]
}

function scriptedQuery(steps: QueryStep[]): {
  calls: QueryCall[]
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>
} {
  const calls: QueryCall[] = []
  return {
    calls,
    query: async (sql, values = []) => {
      calls.push({ sql, values })
      const step = steps.shift()
      if (step === undefined) throw new Error(`未配置 SQL 响应: ${sql}`)
      if (step instanceof Error) throw step
      return typeof step === 'function' ? step(sql, values) : step
    },
  }
}

function directPool(steps: QueryStep[]): {
  pool: Pool
  calls: QueryCall[]
} {
  const script = scriptedQuery(steps)
  return {
    pool: { query: script.query } as unknown as Pool,
    calls: script.calls,
  }
}

function transactionalPool(steps: QueryStep[]): {
  pool: Pool
  calls: QueryCall[]
  released: () => boolean
} {
  const script = scriptedQuery(steps)
  let didRelease = false
  const client = {
    query: script.query,
    release: () => {
      didRelease = true
    },
  }
  return {
    pool: { connect: async () => client } as unknown as Pool,
    calls: script.calls,
    released: () => didRelease,
  }
}

function assertConflict(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ControlPlaneConflictError)
    assert.equal(error.code, code)
    assert.equal(error.name, 'ControlPlaneConflictError')
    assert.equal(error.message, '控制面资源版本或状态冲突')
    return true
  }
}

const tradingConfig: TradingConfigData = {
  catalogVersion: 'catalog-v1',
  executionMode: 'CANDIDATE_POOL',
  confirmationMode: 'MANUAL_CONFIRM',
  models: {
    singleDecision: 'single-model',
    portfolioReview: 'portfolio-model',
    managedOrderReview: 'managed-model',
  },
  strategyId: 'strategy-v1',
  singlePromptId: 'single-prompt-v1',
  portfolioPromptId: 'portfolio-prompt-v1',
  managedOrderPromptId: 'managed-prompt-v1',
  scanIntervalSeconds: 30,
  portfolioReviewIntervalSeconds: 60,
  candidateTtlSeconds: 300,
  maxConcurrency: 2,
  disableUsOvernightEvaluation: true,
  riskPolicyId: 'risk-v1',
}

test('listBrokerConnections 返回数据库行并按用户查询', async () => {
  const rows = [{ brokerConnectionId: 'connection-1', provider: 'FUTU' }]
  const { pool, calls } = directPool([{ rows }])

  const result = await new PostgresControlPlaneRepository(pool).listBrokerConnections('42')

  assert.equal(result, rows)
  assert.deepEqual(calls[0]?.values, ['42'])
  assert.match(calls[0]!.sql, /status <> 'DELETED'/)
})

test('upsertBrokerConnection 写入连接并返回持久化结果', async () => {
  const row = { brokerConnectionId: 'connection-1', provider: 'FUTU', status: 'ACTIVE' }
  const { pool, calls } = directPool([{ rows: [row] }])

  const result = await new PostgresControlPlaneRepository(pool).upsertBrokerConnection({
    userId: '42',
    provider: 'FUTU',
    accountIdHash: 'hash',
    environment: 'REAL',
    displayName: '主账户',
  })

  assert.equal(result, row)
  assert.match(String(calls[0]?.values[0]), /^[0-9a-f-]{36}$/)
  assert.deepEqual(calls[0]?.values.slice(1), ['42', 'FUTU', '主账户', 'hash', 'REAL'])
  assert.match(calls[0]!.sql, /ON CONFLICT/)
})

test('updateBrokerConnection 更新可选字段并返回连接', async () => {
  const row = { brokerConnectionId: 'connection-1', displayName: '新名称', status: 'DISABLED' }
  const { pool, calls } = directPool([{ rows: [row] }])

  const result = await new PostgresControlPlaneRepository(pool).updateBrokerConnection({
    userId: '42',
    brokerConnectionId: 'connection-1',
    displayName: '新名称',
    status: 'DISABLED',
  })

  assert.equal(result, row)
  assert.deepEqual(calls[0]?.values, ['connection-1', '42', '新名称', 'DISABLED'])
})

test('updateBrokerConnection 将缺省字段写为 null', async () => {
  const { pool, calls } = directPool([{ rows: [{ brokerConnectionId: 'connection-1' }] }])

  await new PostgresControlPlaneRepository(pool).updateBrokerConnection({
    userId: '42',
    brokerConnectionId: 'connection-1',
  })

  assert.deepEqual(calls[0]?.values, ['connection-1', '42', null, null])
})

test('updateBrokerConnection 在连接不存在时报告冲突', async () => {
  const { pool } = directPool([{ rows: [] }])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(pool).updateBrokerConnection({
      userId: '42',
      brokerConnectionId: 'missing',
    }),
    assertConflict('BROKER_CONNECTION_NOT_FOUND'),
  )
})

test('getResearchPool 映射有效权益、版本和更新时间', async () => {
  const renewsAt = new Date('2026-10-01T00:00:00.000Z')
  const updatedAt = new Date('2026-09-30T08:00:00.000Z')
  const items = [{ symbol: 'US.AAPL', market: 'US' }]
  const { pool } = directPool([
    {
      rows: [{
        status: 'ACTIVE',
        plan_name: 'PRO',
        capacity: 20,
        replacement_limit: 5,
        replacement_used: 2,
        renews_at: renewsAt,
      }],
    },
    { rows: [{ version: '7', updated_at: updatedAt }] },
    { rows: items },
  ])

  const result = await new PostgresControlPlaneRepository(pool).getResearchPool('42')

  assert.deepEqual(result, {
    entitlement: {
      status: 'ACTIVE',
      planName: 'PRO',
      capacity: 20,
      replacementLimit: 5,
      replacementUsed: 2,
      renewsAt: renewsAt.toISOString(),
    },
    version: 7,
    items,
    updatedAt: updatedAt.toISOString(),
  })
})

test('getResearchPool 在权益和池记录缺失时返回安全默认值', async () => {
  const { pool } = directPool([{ rows: [] }, { rows: [] }, { rows: [] }])

  const result = await new PostgresControlPlaneRepository(pool).getResearchPool('42')

  assert.deepEqual(result, {
    entitlement: {
      status: 'UNAVAILABLE',
      planName: null,
      capacity: 0,
      replacementLimit: 0,
      replacementUsed: 0,
      renewsAt: null,
    },
    version: 1,
    items: [],
    updatedAt: '1970-01-01T00:00:00.000Z',
  })
})

test('addResearchPoolItem 成功提交并递增研究池版本', async () => {
  const updatedAt = new Date('2026-09-30T08:00:00.000Z')
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 1, replacement_used: 0 }] },
    { rows: [{ count: '1' }] },
    { rows: [], rowCount: 1 },
    { rows: [{ version: '3', updated_at: updatedAt }] },
    { rows: [] },
  ])

  const result = await new PostgresControlPlaneRepository(tx.pool).addResearchPoolItem({
    userId: '42',
    symbol: 'US.AAPL',
    market: 'US',
    instrumentType: 'STOCK',
  })

  assert.deepEqual(result, { version: 3, updatedAt: updatedAt.toISOString() })
  assert.deepEqual(tx.calls.map(call => call.sql.trim().split(/\s+/)[0]), [
    'BEGIN', 'SELECT', 'SELECT', 'INSERT', 'INSERT', 'COMMIT',
  ])
  assert.equal(tx.released(), true)
})

test('addResearchPoolItem 在容量耗尽时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 1, replacement_limit: 1, replacement_used: 0 }] },
    { rows: [{ count: '1' }] },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).addResearchPoolItem({
      userId: '42',
      symbol: 'US.AAPL',
      market: 'US',
      instrumentType: 'STOCK',
    }),
    assertConflict('RESEARCH_POOL_CAPACITY_EXCEEDED'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(tx.released(), true)
})

test('addResearchPoolItem 在符号重复时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 1, replacement_used: 0 }] },
    { rows: [{ count: '0' }] },
    { rows: [], rowCount: 0 },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).addResearchPoolItem({
      userId: '42',
      symbol: 'US.AAPL',
      market: 'US',
      instrumentType: 'STOCK',
    }),
    assertConflict('RESEARCH_SYMBOL_EXISTS'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('addResearchPoolItem 在权益无效时回滚', async () => {
  const tx = transactionalPool([{ rows: [] }, { rows: [] }, { rows: [] }])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).addResearchPoolItem({
      userId: '42',
      symbol: 'US.AAPL',
      market: 'US',
      instrumentType: 'STOCK',
    }),
    assertConflict('RESEARCH_ENTITLEMENT_INACTIVE'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('removeResearchPoolItem 成功删除并提交新版本', async () => {
  const updatedAt = new Date('2026-09-30T08:00:00.000Z')
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 1, replacement_used: 0 }] },
    { rows: [], rowCount: 1 },
    { rows: [{ version: '2', updated_at: updatedAt }] },
    { rows: [] },
  ])

  const result = await new PostgresControlPlaneRepository(tx.pool)
    .removeResearchPoolItem('42', 'US.AAPL')

  assert.deepEqual(result, { version: 2, updatedAt: updatedAt.toISOString() })
  assert.equal(tx.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(tx.released(), true)
})

test('removeResearchPoolItem 在符号不存在时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 1, replacement_used: 0 }] },
    { rows: [], rowCount: 0 },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool)
      .removeResearchPoolItem('42', 'US.MISSING'),
    assertConflict('RESEARCH_SYMBOL_NOT_FOUND'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('replaceResearchPoolItem 成功替换、计数并提交', async () => {
  const updatedAt = new Date('2026-09-30T08:00:00.000Z')
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 2, replacement_used: 1 }] },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [{ version: '8', updated_at: updatedAt }] },
    { rows: [] },
  ])

  const result = await new PostgresControlPlaneRepository(tx.pool).replaceResearchPoolItem({
    userId: '42',
    oldSymbol: 'US.OLD',
    symbol: 'US.NEW',
    market: 'US',
    instrumentType: 'ETF',
  })

  assert.deepEqual(result, { version: 8, updatedAt: updatedAt.toISOString() })
  assert.match(tx.calls[4]!.sql, /replacement_used = replacement_used \+ 1/)
  assert.equal(tx.calls.at(-1)?.sql, 'COMMIT')
})

test('replaceResearchPoolItem 在替换额度耗尽时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 1, replacement_used: 1 }] },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).replaceResearchPoolItem({
      userId: '42',
      oldSymbol: 'US.OLD',
      symbol: 'US.NEW',
      market: 'US',
      instrumentType: 'STOCK',
    }),
    assertConflict('RESEARCH_REPLACEMENT_LIMIT_EXCEEDED'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('replaceResearchPoolItem 在旧符号不存在时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 2, replacement_used: 0 }] },
    { rows: [], rowCount: 0 },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).replaceResearchPoolItem({
      userId: '42',
      oldSymbol: 'US.MISSING',
      symbol: 'US.NEW',
      market: 'US',
      instrumentType: 'STOCK',
    }),
    assertConflict('RESEARCH_SYMBOL_NOT_FOUND'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('replaceResearchPoolItem 在新符号重复时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ capacity: 2, replacement_limit: 2, replacement_used: 0 }] },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).replaceResearchPoolItem({
      userId: '42',
      oldSymbol: 'US.OLD',
      symbol: 'US.EXISTS',
      market: 'US',
      instrumentType: 'STOCK',
    }),
    assertConflict('RESEARCH_SYMBOL_EXISTS'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('getTradingConfig 合并连接、提供商、数字版本和配置', async () => {
  const { pool } = directPool([{
    rows: [{ provider: 'LONGBRIDGE', version: '4', config: tradingConfig }],
  }])

  const result = await new PostgresControlPlaneRepository(pool)
    .getTradingConfig('42', 'connection-1')

  assert.deepEqual(result, {
    brokerConnectionId: 'connection-1',
    provider: 'LONGBRIDGE',
    version: 4,
    ...tradingConfig,
  })
})

test('getTradingConfig 在配置不存在时返回 null', async () => {
  const { pool } = directPool([{ rows: [] }])

  assert.equal(
    await new PostgresControlPlaneRepository(pool).getTradingConfig('42', 'missing'),
    null,
  )
})

test('listModelRuns 返回分页结果并处理缺失计数', async () => {
  const items = [{ requestId: 'run-1' }]
  const { pool, calls } = directPool([{ rows: items }, { rows: [] }])

  const result = await new PostgresControlPlaneRepository(pool)
    .listModelRuns('42', 'connection-1', 25)

  assert.deepEqual(result, { items, total: 0 })
  assert.deepEqual(calls[0]?.values, ['42', 'connection-1', 25, 0])
})

test('getModelRun 返回匹配记录', async () => {
  const row = { requestId: 'run-1', status: 'SUCCEEDED' }
  const { pool } = directPool([{ rows: [row] }])

  assert.equal(
    await new PostgresControlPlaneRepository(pool).getModelRun('42', 'run-1'),
    row,
  )
})

test('getModelRun 在记录不存在时返回 null', async () => {
  const { pool } = directPool([{ rows: [] }])

  assert.equal(
    await new PostgresControlPlaneRepository(pool).getModelRun('42', 'missing'),
    null,
  )
})

test('listSignals 返回数据库行并传递限制', async () => {
  const rows = [{ signalId: 'signal-1' }]
  const { pool, calls } = directPool([{ rows }])

  assert.equal(
    await new PostgresControlPlaneRepository(pool).listSignals('42', 'connection-1', 10),
    rows,
  )
  assert.deepEqual(calls[0]?.values, ['42', 'connection-1', 10])
})

test('listCandidates 将 bigint 版本转换为数字', async () => {
  const { pool } = directPool([{
    rows: [{ candidateId: 'candidate-1', poolVersion: '9', configVersion: '4' }],
  }])

  const result = await new PostgresControlPlaneRepository(pool)
    .listCandidates('42', 'connection-1', 10) as Array<Record<string, unknown>>

  assert.deepEqual(result, [{ candidateId: 'candidate-1', poolVersion: 9, configVersion: 4 }])
})

test('putTradingConfig 成功保存当前版本和历史版本后提交', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ broker: 'FUTU' }] },
    { rows: [{ version: '2' }] },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [] },
  ])

  const result = await new PostgresControlPlaneRepository(tx.pool).putTradingConfig({
    userId: '42',
    brokerConnectionId: 'connection-1',
    expectedVersion: 2,
    config: tradingConfig,
  })

  assert.deepEqual(result, {
    brokerConnectionId: 'connection-1',
    provider: 'FUTU',
    version: 3,
    ...tradingConfig,
  })
  assert.equal(tx.calls[3]?.values[7], JSON.stringify(tradingConfig))
  assert.equal(tx.calls[4]?.values[4], JSON.stringify(tradingConfig))
  assert.equal(tx.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(tx.released(), true)
})

test('putTradingConfig 支持从版本零首次创建配置', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ broker: 'LONGBRIDGE' }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ])

  const result = await new PostgresControlPlaneRepository(tx.pool).putTradingConfig({
    userId: '42',
    brokerConnectionId: 'connection-1',
    expectedVersion: 0,
    config: tradingConfig,
  }) as { version: number }

  assert.equal(result.version, 1)
})

test('putTradingConfig 在活动连接不存在时回滚', async () => {
  const tx = transactionalPool([{ rows: [] }, { rows: [] }, { rows: [] }])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).putTradingConfig({
      userId: '42',
      brokerConnectionId: 'missing',
      expectedVersion: 0,
      config: tradingConfig,
    }),
    assertConflict('BROKER_CONNECTION_NOT_FOUND'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(tx.released(), true)
})

test('putTradingConfig 在预期版本不匹配时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ broker: 'FUTU' }] },
    { rows: [{ version: '3' }] },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).putTradingConfig({
      userId: '42',
      brokerConnectionId: 'connection-1',
      expectedVersion: 2,
      config: tradingConfig,
    }),
    assertConflict('TRADING_CONFIG_VERSION_CONFLICT'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('putTradingConfig 在 SQL 异常时回滚并保留原错误', async () => {
  const failure = new Error('write failed')
  const tx = transactionalPool([
    { rows: [] },
    { rows: [{ broker: 'FUTU' }] },
    { rows: [] },
    failure,
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).putTradingConfig({
      userId: '42',
      brokerConnectionId: 'connection-1',
      expectedVersion: 0,
      config: tradingConfig,
    }),
    failure,
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(tx.released(), true)
})

test('activateTradingSession 在硬门禁关闭时不连接数据库', async () => {
  let connected = false
  const pool = {
    connect: async () => {
      connected = true
      throw new Error('不应连接')
    },
  } as unknown as Pool

  await assert.rejects(
    () => new PostgresControlPlaneRepository(pool).activateTradingSession({
      userId: '42',
      deviceId: 'device-1',
      brokerConnectionId: 'connection-1',
      provider: 'FUTU',
      hardGateEnabled: false,
      configVersion: 3,
      riskPolicyVersion: 'risk-v1',
      confirmationDigest: 'digest',
      appSessionId: 'app-session-1',
    }),
    assertConflict('PROVIDER_HARD_GATE_DISABLED'),
  )
  assert.equal(connected, false)
})

test('activateTradingSession 成功创建九十秒会话并提交', async () => {
  const now = new Date('2026-09-30T08:00:00.000Z')
  const tx = transactionalPool([
    { rows: [] },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ session_id: 'session-1' }], rowCount: 1 },
    { rows: [] },
  ])

  const result = await new PostgresControlPlaneRepository(tx.pool).activateTradingSession({
    userId: '42',
    deviceId: 'device-1',
    brokerConnectionId: 'connection-1',
    provider: 'FUTU',
    hardGateEnabled: true,
    configVersion: 3,
    riskPolicyVersion: 'risk-v1',
    confirmationDigest: 'digest',
    appSessionId: 'app-session-1',
    now,
  })

  assert.deepEqual(result, {
    sessionId: 'session-1',
    brokerConnectionId: 'connection-1',
    deviceId: 'device-1',
    mode: 'AUTO_EXECUTE',
    status: 'ACTIVE',
    configVersion: 3,
    riskPolicyVersion: 'risk-v1',
    appSessionId: 'app-session-1',
    expiresAt: '2026-09-30T08:01:30.000Z',
    version: 1,
  })
  assert.equal(tx.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(tx.released(), true)
})

test('activateTradingSession 在已有活动会话时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [] },
    { rows: [{ '?column?': 1 }], rowCount: 1 },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).activateTradingSession({
      userId: '42',
      deviceId: 'device-1',
      brokerConnectionId: 'connection-1',
      provider: 'FUTU',
      hardGateEnabled: true,
      configVersion: 3,
      riskPolicyVersion: 'risk-v1',
      confirmationDigest: 'digest',
      appSessionId: 'app-session-1',
      now: new Date('2026-09-30T08:00:00.000Z'),
    }),
    assertConflict('TRADING_SESSION_ALREADY_ACTIVE'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(tx.released(), true)
})

test('activateTradingSession 在数据库前置条件不满足时回滚', async () => {
  const tx = transactionalPool([
    { rows: [] },
    { rows: [] },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [] },
  ])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(tx.pool).activateTradingSession({
      userId: '42',
      deviceId: 'device-1',
      brokerConnectionId: 'connection-1',
      provider: 'FUTU',
      hardGateEnabled: true,
      configVersion: 3,
      riskPolicyVersion: 'risk-v1',
      confirmationDigest: 'digest',
      appSessionId: 'app-session-1',
      now: new Date('2026-09-30T08:00:00.000Z'),
    }),
    assertConflict('AUTO_SESSION_PRECONDITION_FAILED'),
  )
  assert.equal(tx.calls.at(-1)?.sql, 'ROLLBACK')
})

test('renewTradingSession 延长九十秒并映射数字字段', async () => {
  const now = new Date('2026-09-30T08:00:00.000Z')
  const { pool, calls } = directPool([{
    rows: [{
      broker_connection_id: 'connection-1',
      config_version: '3',
      risk_policy_version: 'risk-v1',
      app_session_id: 'app-session-1',
      version: '2',
    }],
  }])

  const result = await new PostgresControlPlaneRepository(pool).renewTradingSession({
    userId: '42',
    deviceId: 'device-1',
    sessionId: 'session-1',
    now,
  })

  assert.deepEqual(result, {
    sessionId: 'session-1',
    brokerConnectionId: 'connection-1',
    deviceId: 'device-1',
    mode: 'AUTO_EXECUTE',
    status: 'ACTIVE',
    configVersion: 3,
    riskPolicyVersion: 'risk-v1',
    appSessionId: 'app-session-1',
    expiresAt: '2026-09-30T08:01:30.000Z',
    version: 2,
  })
  assert.deepEqual(calls[0]?.values, [
    'session-1',
    '42',
    now,
    new Date('2026-09-30T08:01:30.000Z'),
    'device-1',
  ])
})

test('renewTradingSession 在会话过期时报告冲突', async () => {
  const { pool } = directPool([{ rows: [] }])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(pool).renewTradingSession({
      userId: '42',
      deviceId: 'device-1',
      sessionId: 'session-1',
    }),
    assertConflict('TRADING_SESSION_EXPIRED'),
  )
})

test('deactivateTradingSession 成功停用活动会话', async () => {
  const { pool, calls } = directPool([{ rows: [], rowCount: 1 }])

  await new PostgresControlPlaneRepository(pool).deactivateTradingSession({
    userId: '42',
    deviceId: 'device-1',
    sessionId: 'session-1',
  })

  assert.deepEqual(calls[0]?.values, ['session-1', '42', 'device-1'])
})

test('deactivateTradingSession 在活动会话不存在时报告冲突', async () => {
  const { pool } = directPool([{ rows: [], rowCount: 0 }])

  await assert.rejects(
    () => new PostgresControlPlaneRepository(pool).deactivateTradingSession({
      userId: '42',
      deviceId: 'device-1',
      sessionId: 'session-1',
    }),
    assertConflict('TRADING_SESSION_NOT_ACTIVE'),
  )
})

test('getCurrentTradingSession 映射当前活动会话', async () => {
  const now = new Date('2026-09-30T08:00:00.000Z')
  const expiresAt = new Date('2026-09-30T08:01:30.000Z')
  const { pool, calls } = directPool([{
    rows: [{
      session_id: 'session-1',
      device_id: 'device-1',
      config_version: '3',
      risk_policy_version: 'risk-v1',
      app_session_id: 'app-session-1',
      expires_at: expiresAt,
      version: '4',
    }],
  }])

  const result = await new PostgresControlPlaneRepository(pool)
    .getCurrentTradingSession('42', 'connection-1', now)

  assert.deepEqual(result, {
    sessionId: 'session-1',
    brokerConnectionId: 'connection-1',
    deviceId: 'device-1',
    mode: 'AUTO_EXECUTE',
    status: 'ACTIVE',
    configVersion: 3,
    riskPolicyVersion: 'risk-v1',
    appSessionId: 'app-session-1',
    expiresAt: expiresAt.toISOString(),
    version: 4,
  })
  assert.deepEqual(calls[0]?.values, ['connection-1', '42', now])
})

test('getCurrentTradingSession 在活动会话不存在时返回 null', async () => {
  const { pool } = directPool([{ rows: [] }])

  assert.equal(
    await new PostgresControlPlaneRepository(pool)
      .getCurrentTradingSession('42', 'connection-1'),
    null,
  )
})
