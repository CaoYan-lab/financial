import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Pool } from 'pg'
import {
  loadTradingCatalog,
  publicTradingCatalog,
  TradingCatalogError,
} from '../packages/catalog/src/tradingCatalog.js'
import {
  IdempotencyConflictError,
  IdempotencyService,
  requestHash,
} from '../packages/idempotency/src/idempotencyService.js'
import {
  PostgresTradingDecisionAuthority,
  TradingAuthorityError,
} from '../apps/decision-worker/src/tradingDecisionAuthority.js'
import type { ContextEnvelope } from '../packages/domain/src/contracts.js'
import { PostgresControlPlaneRepository } from '../packages/persistence/src/postgresControlPlaneRepository.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('交易目录加载时校验提示词哈希且公共响应剥离内部字段', async () => {
  const catalog = await loadTradingCatalog(resolve(root, 'catalog/trading/catalog.v1.yaml'))
  const publicCatalog = publicTradingCatalog(catalog)
  assert.equal(catalog.models[0]?.deploymentId, 'env:CHANGFU_ARK_MODEL')
  assert.equal('deploymentId' in publicCatalog.models[0]!, false)
  assert.equal('body' in publicCatalog.prompts[0]!, false)
  assert.equal(JSON.stringify(publicCatalog).includes('仅基于已验证行情'), false)
})

test('交易目录提示词正文与哈希不一致时失败关闭', async () => {
  const source = resolve(root, 'catalog/trading/catalog.v1.yaml')
  const text = await import('node:fs/promises').then(module => module.readFile(source, 'utf8'))
  const mutated = text.replace('仅基于已验证行情', '允许未经验证行情')
  const temporary = resolve(root, 'catalog/trading/catalog.invalid.test.yaml')
  const fs = await import('node:fs/promises')
  await fs.writeFile(temporary, mutated)
  try {
    await assert.rejects(() => loadTradingCatalog(temporary), TradingCatalogError)
  } finally {
    await fs.unlink(temporary)
  }
})

test('幂等服务复用相同请求响应并拒绝同键不同请求', async () => {
  let record: {
    hash: string
    status: number | null
    body: unknown
    expiresAt: Date
  } | null = null
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO changfu.idempotency_records')) {
        if (record) return { rowCount: 0, rows: [] }
        record = {
          hash: String(values?.[3]),
          status: null,
          body: null,
          expiresAt: values?.[4] as Date,
        }
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('SELECT request_hash')) {
        return {
          rowCount: record ? 1 : 0,
          rows: record ? [{
            request_hash: record.hash,
            response_status: record.status,
            response_body: record.body,
            expires_at: record.expiresAt,
          }] : [],
        }
      }
      if (sql.includes('UPDATE changfu.idempotency_records')) {
        if (!record) return { rowCount: 0, rows: [] }
        record.status = Number(values?.[4])
        record.body = JSON.parse(String(values?.[5]))
        return { rowCount: 1, rows: [] }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  const service = new IdempotencyService(pool)
  const hash = requestHash(Buffer.from('{"value":1}'))
  const input = { userId: '42', operation: 'test', key: 'same-key-1234567', requestHash: hash }

  assert.equal(await service.begin(input), null)
  await service.complete({ ...input, response: { status: 201, body: { ok: true } } })
  assert.deepEqual(await service.begin(input), { status: 201, body: { ok: true } })
  await assert.rejects(
    () => service.begin({ ...input, requestHash: requestHash(Buffer.from('{"value":2}')) }),
    (error: unknown) => error instanceof IdempotencyConflictError && error.code === 'KEY_REUSED',
  )
})

test('模型运行历史按用户和券商连接隔离并返回连接标识', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values: values ?? [] })
      if (sql.includes('count(*)')) return { rows: [{ total: '1' }] }
      return {
        rows: [{
          requestId: 'run-1',
          brokerConnectionId: 'broker-longbridge',
          purpose: 'SINGLE_DECISION',
        }],
      }
    },
  } as unknown as Pool

  const page = await new PostgresControlPlaneRepository(pool)
    .listModelRuns('42', 'broker-longbridge', 10, 0)

  assert.equal(
    (page.items[0] as { brokerConnectionId: string }).brokerConnectionId,
    'broker-longbridge',
  )
  assert.equal(queries.length, 2)
  for (const query of queries) {
    assert.match(query.sql, /user_id = \$1::bigint AND broker_connection_id = \$2::uuid/)
    assert.deepEqual(query.values.slice(0, 2), ['42', 'broker-longbridge'])
  }
  assert.match(queries.find(query => !query.sql.includes('count(*)'))!.sql, /AS "brokerConnectionId"/)
})

test('候选池仅查询当前候选模式配置并将 PostgreSQL bigint 版本序列化为数字', async () => {
  let queryText = ''
  const pool = {
    query: async (sql: string) => {
      queryText = sql
      return {
        rows: [{
          candidateId: 'candidate-1',
          brokerConnectionId: 'broker-futu',
          poolVersion: '7',
          configVersion: '3',
        }],
      }
    },
  } as unknown as Pool

  const items = await new PostgresControlPlaneRepository(pool)
    .listCandidates('42', 'broker-futu', 100) as Array<{
      poolVersion: number
      configVersion: number
    }>

  assert.equal(items[0]?.poolVersion, 7)
  assert.equal(items[0]?.configVersion, 3)
  assert.match(queryText, /JOIN changfu\.trading_configs config/)
  assert.match(queryText, /config\.config ->> 'executionMode' = 'CANDIDATE_POOL'/)
  assert.match(queryText, /candidate\.config_version = config\.version/)
})

test('Worker 只接受与权威券商、配置、目录和研究池一致的交易请求', async () => {
  const catalog = await loadTradingCatalog(resolve(root, 'catalog/trading/catalog.v1.yaml'))
  const previousModel = process.env.CHANGFU_ARK_MODEL
  process.env.CHANGFU_ARK_MODEL = 'ep-test'
  let instrumentType: 'STOCK' | 'OPTION' = 'STOCK'
  let canonicalPoolLookup = false
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM changfu.broker_connections c')) {
        return {
          rows: [{
            provider: 'FUTU',
            config_provider: 'FUTU',
            config_version: '3',
            catalog_version: catalog.catalogVersion,
            entitlement_status: 'ACTIVE',
            pool_version: '7',
            account_id_hash: 'a'.repeat(64),
            environment: 'REAL',
            auto_submit_enabled: false,
            config: {
              catalogVersion: catalog.catalogVersion,
              executionMode: 'CANDIDATE_POOL',
              confirmationMode: 'MANUAL_CONFIRM',
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
            },
          }],
        }
      }
      if (sql.includes('FROM changfu.provider_research_pool_items')) {
        canonicalPoolLookup = sql.includes('canonical_symbol = ANY')
        return { rows: [{ symbol: 'US.TEST', market: 'US', instrument_type: instrumentType }] }
      }
      return { rows: [] }
    },
  } as unknown as Pool
  const context = {
    schemaVersion: '2.0',
    brokerConnectionId: '33333333-3333-4333-8333-333333333333',
    provider: 'FUTU',
    deviceId: '22222222-2222-4222-8222-222222222222',
    account: {
      accountIdHash: 'a'.repeat(64),
      environment: 'REAL',
    },
    purpose: 'SINGLE_DECISION',
    tradingConfigVersion: 3,
    researchPoolVersion: 7,
    catalogVersion: catalog.catalogVersion,
    requestedSymbols: ['US.TEST'],
  } as unknown as ContextEnvelope
  try {
    const resolved = await new PostgresTradingDecisionAuthority(pool, catalog)
      .resolve('42', context)
    assert.equal(resolved?.model.deploymentId, 'ep-test')
    assert.equal(resolved?.prompt.id, 'single-decision-v1')
    assert.equal(resolved?.executionMode, 'CANDIDATE_POOL')
    assert.equal(canonicalPoolLookup, true)

    await assert.rejects(
      () => new PostgresTradingDecisionAuthority(pool, catalog).resolve(
        '42',
        { ...context, requestedSymbols: ['US.TEST', 'US.SECOND'] },
      ),
      (error: unknown) => error instanceof TradingAuthorityError
        && error.code === 'SINGLE_DECISION_REQUIRES_ONE_SYMBOL',
    )
    await assert.rejects(
      () => new PostgresTradingDecisionAuthority(pool, catalog).resolve(
        '42',
        { ...context, provider: 'LONGBRIDGE' },
      ),
      (error: unknown) => error instanceof TradingAuthorityError
        && error.code === 'BROKER_PROVIDER_MISMATCH',
    )
    instrumentType = 'OPTION'
    await assert.rejects(
      () => new PostgresTradingDecisionAuthority(pool, catalog).resolve('42', context),
      (error: unknown) => error instanceof TradingAuthorityError
        && error.code === 'INSTRUMENT_NOT_TRADABLE_IN_PHASE_2',
    )
  } finally {
    if (previousModel === undefined) delete process.env.CHANGFU_ARK_MODEL
    else process.env.CHANGFU_ARK_MODEL = previousModel
  }
})
