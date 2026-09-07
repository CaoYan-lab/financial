import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { queryOne } from '../db/pgClient.js'
import { signToken } from './jwt.js'

export type CloudUserRow = {
  id: string
  username: string
  password_hash: string
  last_login_at: Date | null
}

export type LoginResult = {
  ok: boolean
  token?: string
  username?: string
  error?: string
}

const SCRYPT_KEYLEN = 64

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `scrypt$${salt}$${derived}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, hash] = parts
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function writeAudit(eventType: string, username: string | null, ip: string | undefined, detail?: Record<string, unknown>): Promise<void> {
  try {
    await queryOne(
      `INSERT INTO audit_log (event_type, username, ip, detail)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [eventType, username, ip ?? null, detail ? JSON.stringify(detail) : null],
    )
  } catch {
    // 审计失败不阻断登录主流程
  }
}

/**
 * 首次启动播种：cloud_users 为空且配置了 ADMIN_USERNAME/ADMIN_PASSWORD 时创建管理员。
 * 仅播种一次，之后忽略环境变量。
 */
export async function ensureAdminSeeded(): Promise<{ seeded: boolean; username?: string }> {
  const adminUsername = process.env.ADMIN_USERNAME?.trim()
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminUsername || !adminPassword) return { seeded: false }
  const existing = await queryOne<{ username: string }>('SELECT username FROM cloud_users LIMIT 1')
  if (existing) return { seeded: false }
  await queryOne(
    `INSERT INTO cloud_users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [adminUsername, hashPassword(adminPassword)],
  )
  return { seeded: true, username: adminUsername }
}

export async function login(
  username: string,
  password: string,
  ip?: string,
): Promise<LoginResult> {
  if (!username || !password) {
    return { ok: false, error: '用户名和密码不能为空' }
  }
  const user = await queryOne<CloudUserRow>('SELECT * FROM cloud_users WHERE username = $1', [username])
  if (!user || !verifyPassword(password, user.password_hash)) {
    await writeAudit('login_failed', username, ip)
    return { ok: false, error: '用户名或密码错误' }
  }
  await queryOne('UPDATE cloud_users SET last_login_at = now() WHERE id = $1 RETURNING id', [user.id])
  await writeAudit('login_success', username, ip)
  const token = signToken({ sub: String(user.id), username: user.username })
  return { ok: true, token, username: user.username }
}

export async function findUserByUsername(username: string): Promise<Pick<CloudUserRow, 'id' | 'username'> | null> {
  return queryOne<{ id: string; username: string }>('SELECT id, username FROM cloud_users WHERE username = $1', [username])
}
