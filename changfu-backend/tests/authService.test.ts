import assert from 'node:assert/strict'
import { generateKeyPairSync, scryptSync } from 'node:crypto'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import {
  AuthService,
  LoginRejectedError,
} from '../packages/auth/src/authService.js'
import { verifyAccessToken } from '../packages/auth/src/accessToken.js'

function passwordHash(password: string): string {
  const salt = '00112233445566778899aabbccddeeff'
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`
}

function signing() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    config: {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'test-access-key',
      issuer: 'changfu-gateway',
      audience: 'changfu-desktop',
    },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

test('登录复用现有账号并原子注册设备和 refresh 会话', async () => {
  const statements: string[] = []
  const client = {
    query: async (sql: string) => {
      statements.push(sql)
      if (sql.includes('RETURNING device_id')) return { rowCount: 1, rows: [{ device_id: 'device' }] }
      return { rowCount: 1, rows: [] }
    },
    release() {},
  } as unknown as PoolClient
  const pool = {
    query: async () => ({
      rowCount: 1,
      rows: [{ id: '42', password_hash: passwordHash('correct-password') }],
    }),
    connect: async () => client,
  } as unknown as Pool
  const keys = signing()
  const service = new AuthService(pool, keys.config)

  const tokens = await service.login({
    username: 'owner',
    password: 'correct-password',
    deviceId: '22222222-2222-4222-8222-222222222222',
    deviceFingerprint: 'stable-device-fingerprint',
    displayName: '办公 Mac',
    platform: 'MACOS',
    appVersion: '0.1.0',
    publicKey: keys.publicKeyPem,
  })

  const claims = verifyAccessToken(tokens.accessToken, {
    publicKeyPem: keys.publicKeyPem,
    issuer: keys.config.issuer,
    audience: keys.config.audience,
  })
  assert.equal(claims.sub, '42')
  assert.equal(claims.device_id, '22222222-2222-4222-8222-222222222222')
  assert.equal(tokens.refreshToken.length >= 64, true)
  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements.some(sql => sql.includes('INSERT INTO changfu.devices')), true)
  assert.equal(statements.some(sql => sql.includes('INSERT INTO changfu.device_sessions')), true)
  assert.equal(statements.some(sql => sql.includes('INSERT INTO changfu.security_audit')), true)
  assert.equal(statements.at(-1), 'COMMIT')
})

test('错误密码不注册设备', async () => {
  let connected = false
  const pool = {
    query: async () => ({
      rowCount: 1,
      rows: [{ id: '42', password_hash: passwordHash('correct-password') }],
    }),
    connect: async () => {
      connected = true
      throw new Error('不应连接')
    },
  } as unknown as Pool
  const service = new AuthService(pool, signing().config)

  await assert.rejects(() => service.login({
    username: 'owner',
    password: 'wrong-password',
    deviceId: '22222222-2222-4222-8222-222222222222',
    deviceFingerprint: 'stable-device-fingerprint',
    displayName: '办公 Mac',
    platform: 'MACOS',
    appVersion: '0.1.0',
    publicKey: 'unused',
  }), LoginRejectedError)
  assert.equal(connected, false)
})

test('refresh token 单次轮换并可注销', async () => {
  const poolStatements: Array<{ sql: string; values: unknown[] | undefined }> = []
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      poolStatements.push({ sql, values })
      if (sql.includes('SELECT s.session_id')) {
        return {
          rowCount: 1,
          rows: [{
            session_id: '55555555-5555-4555-8555-555555555555',
            user_id: '42',
            device_id: '22222222-2222-4222-8222-222222222222',
          }],
        }
      }
      return { rowCount: 1, rows: [] }
    },
    release() {},
  } as unknown as PoolClient
  const pool = {
    connect: async () => client,
    query: async (sql: string, values?: unknown[]) => {
      poolStatements.push({ sql, values })
      return { rowCount: 1, rows: [] }
    },
  } as unknown as Pool
  const service = new AuthService(pool, signing().config)

  const refreshed = await service.refresh('r'.repeat(64))
  assert.equal(refreshed.refreshToken === 'r'.repeat(64), false)
  assert.equal(poolStatements.some(item => item.sql.includes('FOR UPDATE OF s')), true)
  assert.equal(poolStatements.some(item => item.sql.includes('ON CONFLICT (session_id)')), true)

  await service.logout(refreshed.refreshToken)
  assert.equal(poolStatements.some(item => item.sql.includes('SET revoked_at = now()')), true)
})
