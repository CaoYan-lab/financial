import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import {
  hashAdminPassword,
  validateAdminPassword,
  verifyAdminPassword,
} from '../packages/admin/src/password.js'
import {
  adminSessionCookie,
  hashOpaqueToken,
  parseCookies,
  randomOpaqueToken,
  sessionCookie,
} from '../packages/admin/src/session.js'
import {
  AdminAuthenticationError,
  PostgresAdminRepository,
} from '../packages/persistence/src/postgresAdminRepository.js'

test('管理员密码使用带随机盐的 scrypt 哈希并执行强度校验', async () => {
  const password = 'Strong-Admin-Password-2026!'
  assert.equal(validateAdminPassword(password), true)
  assert.equal(validateAdminPassword('weak-password'), false)
  const first = await hashAdminPassword(password)
  const second = await hashAdminPassword(password)
  assert.notEqual(first, second)
  assert.equal(first.includes(password), false)
  assert.equal(await verifyAdminPassword(password, first), true)
  assert.equal(await verifyAdminPassword('Wrong-Password-2026!', first), false)
})

test('管理员 Session Cookie 不暴露到脚本且令牌只保存哈希', () => {
  const token = randomOpaqueToken()
  assert.equal(token.length >= 64, true)
  assert.match(hashOpaqueToken(token), /^[a-f0-9]{64}$/)
  const cookie = sessionCookie(token, true)
  assert.match(cookie, new RegExp(`^${adminSessionCookie}=`))
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /SameSite=Strict/)
  assert.equal(parseCookies(cookie).get(adminSessionCookie), token)
})

test('登录拒绝在提交失败审计后不对已结束事务执行回滚', async () => {
  const statements: string[] = []
  const passwordHash = await hashAdminPassword('Correct-Password-2026!')
  const client = {
    async query(sql: string) {
      const normalized = sql.trim()
      statements.push(normalized)
      if (normalized.startsWith('SELECT admin_user_id')) {
        return {
          rows: [{
            admin_user_id: '11111111-1111-4111-8111-111111111111',
            username: 'admin',
            password_hash: passwordHash,
            role: 'SUPER_ADMIN',
            enabled: true,
            must_change_password: true,
            failed_login_count: 0,
            locked_until: null,
          }],
        }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  } as unknown as PoolClient
  const pool = {
    connect: async () => client,
  } as unknown as Pool
  const repository = new PostgresAdminRepository(pool)

  await assert.rejects(
    repository.login({
      username: 'admin',
      password: 'Wrong-Password-2026!',
      requestId: '22222222-2222-4222-8222-222222222222',
      sourceIp: '127.0.0.1',
    }),
    AdminAuthenticationError,
  )
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(statements.includes('ROLLBACK'), false)
})
