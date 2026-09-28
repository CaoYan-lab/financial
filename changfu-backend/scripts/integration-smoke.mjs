import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  scryptSync,
  sign,
} from 'node:crypto'
import pg from 'pg'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
const gatewayUrl = process.env.CHANGFU_GATEWAY_URL ?? 'http://127.0.0.1:4310'
if (!databaseUrl) throw new Error('缺少 CHANGFU_DATABASE_URL')

const pool = new pg.Pool({ connectionString: databaseUrl })
const testUsername = `changfu_e2e_${randomUUID().replaceAll('-', '')}`
const deviceKeys = generateKeyPairSync('ed25519')
const devicePublicKey = deviceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const userId = await createTestUser()
const deviceId = randomUUID()
let brokerConnectionId

try {
  const health = await request('/v1/health')
  assert.equal(health.response.status, 200)
  assert.equal(health.body.configured, true)

  const login = await request('/v1/auth/login', {
    username: testUsername,
    password: 'ChangFu-E2E-Password',
    deviceId,
    deviceFingerprint: `integration-${randomUUID()}`,
    displayName: '长富集成测试设备',
    platform: 'MACOS',
    appVersion: '0.1.0',
    publicKey: devicePublicKey,
  })
  assert.equal(login.response.status, 200)
  assert.equal(typeof login.body.accessToken, 'string')
  assert.equal(typeof login.body.refreshToken, 'string')

  const refresh = await request('/v1/auth/refresh', {
    refreshToken: login.body.refreshToken,
  })
  assert.equal(refresh.response.status, 200)
  assert.notEqual(refresh.body.refreshToken, login.body.refreshToken)

  const reused = await request('/v1/auth/refresh', {
    refreshToken: login.body.refreshToken,
  })
  assert.equal(reused.response.status, 401)

  const ad = await request('/v1/ads/active?placement=startup', undefined, {
    authorization: `Bearer ${refresh.body.accessToken}`,
  })
  assert.equal(ad.response.status, 200)
  assert.equal(ad.body.placement, 'startup')

  const brokerConnection = await request('/v1/broker-connections/futu', {
    accountIdHash: 'a'.repeat(64),
    environment: 'SIMULATE',
    displayName: '长富集成测试账户',
  }, {
    authorization: `Bearer ${refresh.body.accessToken}`,
    'idempotency-key': randomUUID(),
  })
  assert.equal(brokerConnection.response.status, 200)
  brokerConnectionId = brokerConnection.body.brokerConnectionId
  assert.equal(typeof brokerConnectionId, 'string')
  const context = signedContext()
  const model = await request('/v1/model/runs', {
    context,
    userMessage: '根据缺失数据说明为什么当前应保持观望。',
  }, {
    authorization: `Bearer ${refresh.body.accessToken}`,
    'idempotency-key': randomUUID(),
  })
  assert.equal(model.response.status, 200)
  assert.equal(model.body.requestId, context.requestId)
  assert.equal(model.body.orderIntent, null)
  const persisted = await pool.query(
    `SELECT status, result, item_counts,
            result ?| ARRAY['account', 'positions', 'quotes', 'minuteBars', 'tickerPoints', 'orderBooks']
              AS contains_raw_context
       FROM changfu.model_runs
      WHERE request_id = $1::uuid`,
    [context.requestId],
  )
  assert.equal(persisted.rowCount, 1)
  assert.equal(persisted.rows[0].status, 'COMPLETED')
  assert.equal(persisted.rows[0].contains_raw_context, false)

  const logout = await request('/v1/auth/logout', {
    refreshToken: refresh.body.refreshToken,
  })
  assert.equal(logout.response.status, 204)

  const loggedOut = await request('/v1/auth/refresh', {
    refreshToken: refresh.body.refreshToken,
  })
  assert.equal(loggedOut.response.status, 401)
  console.log('通过：Gateway、Worker、PostgreSQL、模型与认证全链路集成冒烟')
} finally {
  await cleanup()
  await pool.end()
}

async function createTestUser() {
  const password = 'ChangFu-E2E-Password'
  const salt = randomUUID().replaceAll('-', '')
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO public.cloud_users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id`,
      [testUsername, passwordHash],
    )
    const row = inserted.rows[0]
    await client.query(
      `INSERT INTO multiuser.user_profiles (user_id, display_name, role, active)
       VALUES ($1::bigint, '长富集成测试', 'member', true)`,
      [row.id],
    )
    await client.query('COMMIT')
    return row.id
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function request(path, body, headers = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return {
    response,
    body: text ? JSON.parse(text) : null,
  }
}

function signedContext() {
  const now = new Date()
  const context = {
    schemaVersion: '1.0',
    requestId: randomUUID(),
    deviceId,
    brokerConnectionId,
    purpose: 'CHAT',
    capturedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence: 1,
    account: {
      accountIdHash: 'a'.repeat(64),
      broker: 'FUTU',
      environment: 'SIMULATE',
      totalAssets: { value: '0', currency: 'USD' },
      cash: { value: '0', currency: 'USD' },
      buyingPower: { value: '0', currency: 'USD' },
    },
    positions: [],
    marketSessions: [],
    quotes: [],
    minuteBars: [],
    tickerPoints: [],
    orderBooks: [],
    openOrders: [],
    recentDeals: [],
    research: {
      entitlementStatus: 'active',
      planName: '集成测试套餐',
      poolLimit: 1,
      poolSymbols: ['US.TEST'],
      conversationSymbols: ['US.TEST'],
    },
    capabilities: [
      {
        id: 'quantitative',
        kind: 'skill',
        title: '量化研究',
        promptVersion: 'research-quantitative-v1',
        modelProfile: 'deep',
        toolPolicyVersion: 'research-readonly-v1',
      },
      {
        id: 'sellPut',
        kind: 'skill',
        title: 'SELL PUT 期权研究',
        promptVersion: 'top30-mega-cap-csp-v3',
        modelProfile: 'risk',
        toolPolicyVersion: 'research-readonly-v1',
      },
    ],
    strategyConfigVersion: 'conversation-capabilities-v1',
    clientPolicyVersion: 'macos-v1',
    dataGaps: ['集成测试未提供真实账户与行情'],
  }
  const contentHash = createHash('sha256').update(canonicalize(context)).digest('hex')
  return {
    ...context,
    contentHash,
    deviceSignature: sign(
      null,
      Buffer.from(contentHash, 'hex'),
      deviceKeys.privateKey,
    ).toString('base64url'),
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function cleanup() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM changfu.security_audit WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM changfu.device_sessions WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM changfu.model_runs WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM changfu.broker_connections WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM changfu.devices WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM multiuser.user_profiles WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM public.cloud_users WHERE id = $1::bigint', [userId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
