import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { query, queryOne } from '../../db/pgClient.js'
import { getPasswordHash } from '../auth/profileStore.js'
import { hashPassword, validatePassword, verifyPassword } from '../auth/passwordService.js'

const UNLOCK_TTL_SECONDS = 10 * 60

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function contextHash(value?: string): string | null {
  return value ? createHash('sha256').update(value).digest('hex') : null
}

export async function futuSecretConfigured(ownerUserId: string): Promise<boolean> {
  const row = await queryOne<{ configured: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM multiuser.futu_owner_secret WHERE owner_user_id = $1
     ) AS configured`,
    [ownerUserId],
  )
  return row?.configured === true
}

export async function setFutuSecondaryPassword(input: {
  ownerUserId: string
  currentPassword: string
  secondaryPassword: string
}): Promise<void> {
  const validationError = validatePassword(input.secondaryPassword)
  if (validationError) throw new Error(validationError)
  const primaryHash = await getPasswordHash(input.ownerUserId)
  if (!primaryHash || !verifyPassword(input.currentPassword, primaryHash)) {
    throw new Error('当前登录密码错误')
  }
  if (verifyPassword(input.secondaryPassword, primaryHash)) {
    throw new Error('Futu 二次密码不能与登录密码相同')
  }
  await query(
    `INSERT INTO multiuser.futu_owner_secret (owner_user_id, password_hash, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (owner_user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [input.ownerUserId, hashPassword(input.secondaryPassword)],
  )
  await query(
    `UPDATE multiuser.futu_unlock_sessions
     SET revoked_at = now()
     WHERE owner_user_id = $1 AND revoked_at IS NULL`,
    [input.ownerUserId],
  )
}

export async function createFutuUnlock(input: {
  ownerUserId: string
  secondaryPassword: string
  ip?: string
  userAgent?: string
}): Promise<string> {
  const secret = await queryOne<{ password_hash: string }>(
    'SELECT password_hash FROM multiuser.futu_owner_secret WHERE owner_user_id = $1',
    [input.ownerUserId],
  )
  if (!secret) throw new Error('FUTU_STEP_UP_SETUP_REQUIRED')
  if (!verifyPassword(input.secondaryPassword, secret.password_hash)) {
    throw new Error('FUTU_SECONDARY_PASSWORD_INVALID')
  }
  const token = randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO multiuser.futu_unlock_sessions
       (id, owner_user_id, token_hash, ip_hash, user_agent_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [
      randomUUID(),
      input.ownerUserId,
      tokenHash(token),
      contextHash(input.ip),
      contextHash(input.userAgent),
      UNLOCK_TTL_SECONDS,
    ],
  )
  return token
}

export async function validateFutuUnlock(
  ownerUserId: string,
  token: string | null,
): Promise<boolean> {
  if (!token) return false
  const row = await queryOne<{ id: string }>(
    `UPDATE multiuser.futu_unlock_sessions
     SET last_seen_at = now(),
         expires_at = now() + make_interval(secs => $3)
     WHERE owner_user_id = $1
       AND token_hash = $2
       AND revoked_at IS NULL
       AND expires_at > now()
     RETURNING id`,
    [ownerUserId, tokenHash(token), UNLOCK_TTL_SECONDS],
  )
  return Boolean(row)
}

export async function revokeFutuUnlock(ownerUserId: string, token: string | null): Promise<void> {
  if (!token) return
  await query(
    `UPDATE multiuser.futu_unlock_sessions
     SET revoked_at = now()
     WHERE owner_user_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
    [ownerUserId, tokenHash(token)],
  )
}

export function futuUnlockMaxAgeSeconds(): number {
  return UNLOCK_TTL_SECONDS
}
