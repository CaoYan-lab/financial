import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import {
  credentialAad,
  decodeCredentialKey,
  decryptCredential,
  encryptCredential,
} from '../packages/model-provider/src/credentialCrypto.js'
import {
  assertSafeModelEndpoint,
  assertSafeOfficialModelEndpoint,
} from '../packages/model-provider/src/endpointSecurity.js'
import {
  ModelProviderConfigError,
  PostgresModelProviderConfigRepository,
} from '../packages/model-provider/src/postgresModelProviderConfigRepository.js'

type QueryResult = {
  rows: unknown[]
  rowCount?: number
}

function mockPool(
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>,
  statements: string[] = [],
): Pool {
  const execute = async (sql: string, values?: unknown[]) => {
    statements.push(sql.trim())
    return query(sql, values)
  }
  const client = {
    query: execute,
    release: () => statements.push('RELEASE'),
  } as unknown as PoolClient
  return {
    query: execute,
    connect: async () => client,
  } as unknown as Pool
}

function configRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config_id: '11111111-1111-4111-8111-111111111111',
    display_name: '自有模型',
    protocol: 'OPENAI_RESPONSES',
    endpoint: 'https://api.example.com/v1/responses',
    model: 'model-1',
    api_key_ciphertext: Buffer.from('ciphertext'),
    api_key_nonce: Buffer.alloc(12, 1),
    api_key_auth_tag: Buffer.alloc(16, 2),
    api_key_last_four: '1234',
    enabled: true,
    updated_at: new Date('2026-09-19T00:00:00.000Z'),
    ...overrides,
  }
}

test('第三方模型 API Key 使用用户与配置绑定的 AES-GCM 密文', () => {
  const encodedKey = Buffer.alloc(32, 7).toString('base64')
  const key = decodeCredentialKey(encodedKey)
  const aad = credentialAad('42', '11111111-1111-4111-8111-111111111111')
  const encrypted = encryptCredential('sk-private-value', key, aad)

  assert.notEqual(encrypted.ciphertext.toString('utf8'), 'sk-private-value')
  assert.equal(encrypted.nonce.length, 12)
  assert.equal(encrypted.authTag.length, 16)
  assert.equal(decryptCredential(encrypted, key, aad), 'sk-private-value')
  assert.throws(
    () => decryptCredential(
      encrypted,
      key,
      credentialAad('43', '11111111-1111-4111-8111-111111111111'),
    ),
  )
})

test('第三方模型主密钥必须是规范的 32 字节 base64', () => {
  assert.throws(() => decodeCredentialKey('not-a-key'), /MODEL_CREDENTIAL_KEY_INVALID/)
  assert.throws(
    () => encryptCredential('secret', Buffer.alloc(16), Buffer.from('aad')),
    /MODEL_CREDENTIAL_KEY_INVALID/,
  )
  assert.throws(
    () => decryptCredential(
      { ciphertext: Buffer.alloc(8), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16) },
      Buffer.alloc(16),
      Buffer.from('aad'),
    ),
    /MODEL_CREDENTIAL_KEY_INVALID/,
  )
})

test('第三方模型 Endpoint 拒绝非 HTTPS、本机名和 IP 字面量', async () => {
  await assert.rejects(
    () => assertSafeModelEndpoint('http://api.example.com/v1/responses'),
    /MODEL_ENDPOINT_NOT_ALLOWED/,
  )
  await assert.rejects(
    () => assertSafeModelEndpoint('https://localhost/v1/responses'),
    /MODEL_ENDPOINT_NOT_ALLOWED/,
  )
  await assert.rejects(
    () => assertSafeModelEndpoint('https://127.0.0.1/v1/responses'),
    /MODEL_ENDPOINT_NOT_ALLOWED/,
  )
})

test('官方 Ark Endpoint 仅放行部署 VPC 内的 PrivateLink 地址', async () => {
  const privateLinkLookup = async () => [
    { address: '10.20.1.110', family: 4 },
    { address: '10.20.2.194', family: 4 },
  ]
  await assert.doesNotReject(
    () => assertSafeOfficialModelEndpoint(
      'https://ark.cn-beijing.volces.com/api/v3/responses',
      privateLinkLookup,
    ),
  )
  await assert.rejects(
    () => assertSafeModelEndpoint(
      'https://ark.cn-beijing.volces.com/api/v3/responses',
      privateLinkLookup,
    ),
    /MODEL_ENDPOINT_NOT_ALLOWED/,
  )
  await assert.rejects(
    () => assertSafeOfficialModelEndpoint(
      'https://api.example.com/v1/responses',
      privateLinkLookup,
    ),
    /MODEL_ENDPOINT_NOT_ALLOWED/,
  )
  await assert.rejects(
    () => assertSafeOfficialModelEndpoint(
      'https://ark.cn-beijing.volces.com/api/v3/responses',
      async () => [{ address: '10.21.1.10', family: 4 }],
    ),
    /MODEL_ENDPOINT_NOT_ALLOWED/,
  )
})

test('第三方模型读取同时返回当前旗舰权益与脱敏配置', async () => {
  const row = configRow()
  const pool = mockPool(async sql => {
    if (sql.includes('FROM changfu.user_subscriptions')) {
      return { rows: [{ plan_code: 'FLAGSHIP' }] }
    }
    if (sql.includes('FROM changfu.third_party_model_configs')) {
      return { rows: [row] }
    }
    throw new Error(`UNEXPECTED_QUERY: ${sql}`)
  })
  const repository = new PostgresModelProviderConfigRepository(pool, '')

  const result = await repository.get('42')

  assert.equal(result.eligible, true)
  assert.equal(result.planCode, 'FLAGSHIP')
  assert.deepEqual(result.config, {
    configId: row.config_id,
    displayName: '自有模型',
    protocol: 'OPENAI_RESPONSES',
    endpoint: 'https://api.example.com/v1/responses',
    model: 'model-1',
    enabled: true,
    keyConfigured: true,
    keyLastFour: '1234',
    updatedAt: '2026-09-19T00:00:00.000Z',
  })
  assert.equal('apiKey' in result.config!, false)
})

test('非旗舰用户写入第三方模型配置时事务回滚', async () => {
  const statements: string[] = []
  const pool = mockPool(async sql => {
    if (sql.trim() === 'BEGIN' || sql.trim() === 'ROLLBACK') return { rows: [] }
    if (sql.includes('FROM changfu.user_subscriptions')) {
      return { rows: [{ plan_code: 'PRO' }] }
    }
    throw new Error(`UNEXPECTED_QUERY: ${sql}`)
  }, statements)
  const repository = new PostgresModelProviderConfigRepository(
    pool,
    Buffer.alloc(32, 3).toString('base64'),
  )

  await assert.rejects(
    repository.upsert({
      userId: '42',
      displayName: '自有模型',
      protocol: 'OPENAI_RESPONSES',
      endpoint: 'https://api.example.com/v1/responses',
      model: 'model-1',
      apiKey: 'sk-private-value',
      enabled: true,
    }),
    error => error instanceof ModelProviderConfigError
      && error.code === 'FLAGSHIP_SUBSCRIPTION_REQUIRED',
  )
  assert.deepEqual(statements.slice(-2), ['ROLLBACK', 'RELEASE'])
  assert.equal(statements.some(sql => sql.includes('INSERT INTO')), false)
})

test('旗舰用户配置 API Key 只以 AES-GCM 密文写入并可保留旧密钥', async () => {
  const masterKey = Buffer.alloc(32, 4)
  const configId = '11111111-1111-4111-8111-111111111111'
  const previous = encryptCredential(
    'sk-existing-key',
    masterKey,
    credentialAad('42', configId),
  )
  let existing: Record<string, unknown> | null = null
  let insertValues: unknown[] = []
  const pool = mockPool(async (sql, values) => {
    const normalized = sql.trim()
    if (['BEGIN', 'COMMIT'].includes(normalized)) return { rows: [] }
    if (sql.includes('FROM changfu.user_subscriptions')) {
      return { rows: [{ plan_code: 'FLAGSHIP' }] }
    }
    if (sql.includes('FROM changfu.third_party_model_configs')) {
      return { rows: existing ? [existing] : [] }
    }
    if (sql.includes('INSERT INTO changfu.third_party_model_configs')) {
      insertValues = values ?? []
      const saved = configRow({
        config_id: values?.[0],
        display_name: values?.[2],
        protocol: values?.[3],
        endpoint: values?.[4],
        model: values?.[5],
        api_key_ciphertext: values?.[6],
        api_key_nonce: values?.[7],
        api_key_auth_tag: values?.[8],
        api_key_last_four: values?.[9],
        enabled: values?.[10],
      })
      return { rows: [saved] }
    }
    throw new Error(`UNEXPECTED_QUERY: ${sql}`)
  })
  const repository = new PostgresModelProviderConfigRepository(
    pool,
    masterKey.toString('base64'),
  )

  const created = await repository.upsert({
    userId: '42',
    displayName: '自有模型',
    protocol: 'OPENAI_RESPONSES',
    endpoint: 'https://api.example.com/v1/responses',
    model: 'model-1',
    apiKey: 'sk-private-value',
    enabled: true,
  })
  const createdId = String(insertValues[0])
  assert.equal(created.config?.keyLastFour, 'alue')
  assert.notEqual((insertValues[6] as Buffer).toString('utf8'), 'sk-private-value')
  assert.equal(
    decryptCredential(
      {
        ciphertext: insertValues[6] as Buffer,
        nonce: insertValues[7] as Buffer,
        authTag: insertValues[8] as Buffer,
      },
      masterKey,
      credentialAad('42', createdId),
    ),
    'sk-private-value',
  )

  existing = configRow({
    config_id: configId,
    api_key_ciphertext: previous.ciphertext,
    api_key_nonce: previous.nonce,
    api_key_auth_tag: previous.authTag,
    api_key_last_four: '-key',
  })
  await repository.upsert({
    userId: '42',
    displayName: '更新模型',
    protocol: 'OPENAI_CHAT_COMPLETIONS',
    endpoint: 'https://api.example.com/v1/chat/completions',
    model: 'model-2',
    apiKey: null,
    enabled: false,
  })
  assert.equal(insertValues[0], configId)
  assert.deepEqual(insertValues.slice(6, 9), [
    previous.ciphertext,
    previous.nonce,
    previous.authTag,
  ])
  assert.equal(insertValues[9], '-key')
})

test('首次配置未提供 API Key 时回滚且返回固定错误码', async () => {
  const statements: string[] = []
  const pool = mockPool(async sql => {
    const normalized = sql.trim()
    if (normalized === 'BEGIN' || normalized === 'ROLLBACK') return { rows: [] }
    if (sql.includes('FROM changfu.user_subscriptions')) {
      return { rows: [{ plan_code: 'FLAGSHIP' }] }
    }
    if (sql.includes('FROM changfu.third_party_model_configs')) return { rows: [] }
    throw new Error(`UNEXPECTED_QUERY: ${sql}`)
  }, statements)
  const repository = new PostgresModelProviderConfigRepository(
    pool,
    Buffer.alloc(32, 5).toString('base64'),
  )

  await assert.rejects(
    repository.upsert({
      userId: '42',
      displayName: '自有模型',
      protocol: 'OPENAI_RESPONSES',
      endpoint: 'https://api.example.com/v1/responses',
      model: 'model-1',
      apiKey: null,
      enabled: true,
    }),
    error => error instanceof ModelProviderConfigError
      && error.code === 'MODEL_API_KEY_REQUIRED',
  )
  assert.deepEqual(statements.slice(-2), ['ROLLBACK', 'RELEASE'])
})

test('Worker 只解密有效旗舰用户的已启用配置', async () => {
  const masterKey = Buffer.alloc(32, 6)
  const configId = '11111111-1111-4111-8111-111111111111'
  const encrypted = encryptCredential(
    'sk-worker-only',
    masterKey,
    credentialAad('42', configId),
  )
  let effective = true
  const pool = mockPool(async sql => {
    if (!sql.includes('JOIN changfu.user_subscriptions')) {
      throw new Error(`UNEXPECTED_QUERY: ${sql}`)
    }
    return {
      rows: effective ? [configRow({
        config_id: configId,
        api_key_ciphertext: encrypted.ciphertext,
        api_key_nonce: encrypted.nonce,
        api_key_auth_tag: encrypted.authTag,
        api_key_last_four: 'only',
      })] : [],
    }
  })
  const repository = new PostgresModelProviderConfigRepository(
    pool,
    masterKey.toString('base64'),
  )

  assert.deepEqual(await repository.getEffective('42'), {
    configId,
    protocol: 'OPENAI_RESPONSES',
    endpoint: 'https://api.example.com/v1/responses',
    model: 'model-1',
    apiKey: 'sk-worker-only',
  })
  effective = false
  assert.equal(await repository.getEffective('42'), null)
})

test('Worker 按对话指定的配置 ID 精确选择启用配置', async () => {
  const masterKey = Buffer.alloc(32, 8)
  const configId = '11111111-1111-4111-8111-111111111111'
  const encrypted = encryptCredential(
    'sk-selected',
    masterKey,
    credentialAad('42', configId),
  )
  let queryValues: unknown[] = []
  const pool = mockPool(async (sql, values) => {
    assert.match(sql, /c\.config_id = \$2::uuid/)
    queryValues = values ?? []
    return {
      rows: [configRow({
        config_id: configId,
        api_key_ciphertext: encrypted.ciphertext,
        api_key_nonce: encrypted.nonce,
        api_key_auth_tag: encrypted.authTag,
      })],
    }
  })
  const repository = new PostgresModelProviderConfigRepository(
    pool,
    masterKey.toString('base64'),
  )

  const result = await repository.getEffective('42', configId)

  assert.equal(result?.configId, configId)
  assert.deepEqual(queryValues, ['42', configId])
})

test('旗舰用户可删除配置且事务提交', async () => {
  const statements: string[] = []
  const pool = mockPool(async sql => {
    const normalized = sql.trim()
    if (['BEGIN', 'COMMIT'].includes(normalized)) return { rows: [] }
    if (sql.includes('FROM changfu.user_subscriptions')) {
      return { rows: [{ plan_code: 'FLAGSHIP' }] }
    }
    if (sql.includes('DELETE FROM changfu.third_party_model_configs')) return { rows: [] }
    throw new Error(`UNEXPECTED_QUERY: ${sql}`)
  }, statements)
  const repository = new PostgresModelProviderConfigRepository(pool, '')

  assert.deepEqual(await repository.delete('42'), {
    eligible: true,
    planCode: 'FLAGSHIP',
    config: null,
  })
  assert.deepEqual(statements.slice(-2), ['COMMIT', 'RELEASE'])
})
