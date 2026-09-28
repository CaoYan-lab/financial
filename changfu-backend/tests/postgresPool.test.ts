import assert from 'node:assert/strict'
import test from 'node:test'
import { postgresPoolConfig } from '../packages/runtime/src/postgresPool.js'

test('PostgreSQL 连接池使用服务默认值', () => {
  assert.deepEqual(
    postgresPoolConfig(
      'postgresql://example',
      { max: 5, applicationName: 'changfu-test' },
      {},
    ),
    {
      connectionString: 'postgresql://example',
      application_name: 'changfu-test',
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    },
  )
})

test('PostgreSQL 连接池读取受限环境变量', () => {
  const config = postgresPoolConfig(
    'postgresql://example',
    { max: 5, applicationName: 'changfu-test' },
    {
      CHANGFU_PG_POOL_MAX: '3',
      CHANGFU_PG_CONNECTION_TIMEOUT_MS: '9000',
      CHANGFU_PG_IDLE_TIMEOUT_MS: '45000',
    },
  )
  assert.equal(config.max, 3)
  assert.equal(config.connectionTimeoutMillis, 9_000)
  assert.equal(config.idleTimeoutMillis, 45_000)
})

test('PostgreSQL 连接池拒绝无效参数', () => {
  assert.throws(
    () => postgresPoolConfig(
      'postgresql://example',
      { max: 5, applicationName: 'changfu-test' },
      { CHANGFU_PG_POOL_MAX: '0' },
    ),
    /CHANGFU_PG_POOL_MAX_INVALID/,
  )
})
