import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { signAccessToken } from './accessToken.js'

const refreshTtlMs = 30 * 24 * 60 * 60 * 1_000
const scryptKeyLength = 64

export type DesktopLogin = {
  username: string
  password: string
  deviceId: string
  deviceFingerprint: string
  displayName: string
  platform: 'MACOS' | 'WINDOWS'
  appVersion: string
  publicKey: string
}

export type TokenPair = {
  accessToken: string
  accessExpiresAt: string
  refreshToken: string
  refreshExpiresAt: string
  deviceId: string
  mustChangePassword: boolean
}

export class LoginRejectedError extends Error {
  constructor() {
    super('用户名或密码错误，或账号不可用')
    this.name = 'LoginRejectedError'
  }
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, scryptKeyLength, (error, key) => {
      if (error) reject(error)
      else resolve(key as Buffer)
    })
  })
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, encoded] = stored.split('$')
  if (algorithm !== 'scrypt' || !salt || !encoded) return false
  const expected = Buffer.from(encoded, 'hex')
  const actual = await derivePassword(password, salt)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function validPassword(password: string): boolean {
  return (
    password.length >= 12
    && password.length <= 256
    && /[A-Za-z]/.test(password)
    && /\d/.test(password)
  )
}

async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new PasswordChangeError('PASSWORD_POLICY_INVALID')
  const salt = randomBytes(16).toString('hex')
  const key = await derivePassword(password, salt)
  return `scrypt$${salt}$${key.toString('hex')}`
}

export class PasswordChangeError extends Error {
  constructor(readonly code: 'CURRENT_PASSWORD_INVALID' | 'PASSWORD_POLICY_INVALID') {
    super(code === 'CURRENT_PASSWORD_INVALID' ? '当前密码错误' : '新密码不符合安全要求')
    this.name = 'PasswordChangeError'
  }
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly signing: {
      privateKeyPem: string
      keyId: string
      issuer: string
      audience: string
    },
  ) {}

  async login(input: DesktopLogin): Promise<TokenPair> {
    const user = await this.pool.query<{
      id: string
      password_hash: string
      must_change_password: boolean
    }>(
      `SELECT u.id, u.password_hash, p.must_change_password
         FROM public.cloud_users u
         JOIN multiuser.user_profiles p ON p.user_id = u.id
        WHERE u.username = $1
          AND p.active = true`,
      [input.username],
    )
    const row = user.rows[0]
    if (!row || !(await verifyPassword(input.password, row.password_hash))) {
      throw new LoginRejectedError()
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const enrolled = await client.query<{ device_id: string }>(
        `INSERT INTO changfu.devices (
           device_id, user_id, display_name, platform, app_version,
           public_key, fingerprint_hash, status, last_seen_at
         ) VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7, 'ACTIVE', now())
         ON CONFLICT (user_id, fingerprint_hash) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               platform = EXCLUDED.platform,
               app_version = EXCLUDED.app_version,
               public_key = EXCLUDED.public_key,
               status = 'ACTIVE',
               last_seen_at = now()
         RETURNING device_id`,
        [
          input.deviceId,
          row.id,
          input.displayName,
          input.platform,
          input.appVersion,
          input.publicKey,
          createHash('sha256').update(input.deviceFingerprint).digest('hex'),
        ],
      )
      if (enrolled.rowCount !== 1) throw new LoginRejectedError()
      const deviceId = enrolled.rows[0]!.device_id
      const tokens = await this.issueTokenPair(
        client,
        row.id,
        deviceId,
        row.must_change_password,
      )
      await client.query(
        'UPDATE public.cloud_users SET last_login_at = now() WHERE id = $1::bigint',
        [row.id],
      )
      await this.writeAudit(client, row.id, deviceId, 'LOGIN', 'SUCCESS')
      await client.query('COMMIT')
      return tokens
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const hash = tokenHash(refreshToken)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<{
        session_id: string
        user_id: string
        device_id: string
        must_change_password: boolean
      }>(
        `SELECT s.session_id, s.user_id, s.device_id, p.must_change_password
           FROM changfu.device_sessions s
           JOIN changfu.devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
           JOIN multiuser.user_profiles p ON p.user_id = s.user_id
          WHERE s.refresh_token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
            AND d.status = 'ACTIVE'
            AND p.active = true
          FOR UPDATE OF s`,
        [hash],
      )
      const session = result.rows[0]
      if (!session) throw new LoginRejectedError()
      const tokens = await this.issueTokenPair(
        client,
        session.user_id,
        session.device_id,
        session.must_change_password,
        session.session_id,
      )
      await client.query('COMMIT')
      return tokens
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async logout(refreshToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE changfu.device_sessions
          SET revoked_at = now()
        WHERE refresh_token_hash = $1
          AND revoked_at IS NULL`,
      [tokenHash(refreshToken)],
    )
  }

  async changePassword(input: {
    userId: string
    deviceId: string
    currentPassword?: string
    nextPassword: string
  }): Promise<void> {
    if (!validPassword(input.nextPassword)) {
      throw new PasswordChangeError('PASSWORD_POLICY_INVALID')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<{
        password_hash: string
        must_change_password: boolean
      }>(
        `SELECT u.password_hash, p.must_change_password
           FROM public.cloud_users u
           JOIN multiuser.user_profiles p ON p.user_id = u.id
          WHERE u.id = $1::bigint
          FOR UPDATE`,
        [input.userId],
      )
      const user = result.rows[0]
      const currentPasswordValid = input.currentPassword
        ? await verifyPassword(input.currentPassword, user?.password_hash ?? '')
        : false
      if (!user || (!user.must_change_password && !currentPasswordValid)) {
        throw new PasswordChangeError('CURRENT_PASSWORD_INVALID')
      }
      await client.query(
        'UPDATE public.cloud_users SET password_hash = $2 WHERE id = $1::bigint',
        [input.userId, await hashPassword(input.nextPassword)],
      )
      await client.query(
        `UPDATE multiuser.user_profiles
            SET must_change_password = false,
                sessions_valid_after = now(),
                updated_at = now()
          WHERE user_id = $1::bigint`,
        [input.userId],
      )
      await client.query(
        `UPDATE changfu.device_sessions
            SET revoked_at = now()
          WHERE user_id = $1::bigint
            AND revoked_at IS NULL`,
        [input.userId],
      )
      await this.writeAudit(client, input.userId, input.deviceId, 'PASSWORD_CHANGE', 'SUCCESS')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async issueTokenPair(
    client: PoolClient,
    userId: string,
    deviceId: string,
    mustChangePassword: boolean,
    existingSessionId?: string,
  ): Promise<TokenPair> {
    const access = signAccessToken({
      userId,
      deviceId,
      privateKeyPem: this.signing.privateKeyPem,
      keyId: this.signing.keyId,
      issuer: this.signing.issuer,
      audience: this.signing.audience,
    })
    const refreshToken = randomBytes(48).toString('base64url')
    const refreshExpiresAt = new Date(Date.now() + refreshTtlMs)
    const sessionId = existingSessionId ?? randomUUID()
    await client.query(
      `INSERT INTO changfu.device_sessions (
         session_id, user_id, device_id, refresh_token_hash, expires_at, last_seen_at
       ) VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5::timestamptz, now())
       ON CONFLICT (session_id) DO UPDATE
         SET refresh_token_hash = EXCLUDED.refresh_token_hash,
             expires_at = EXCLUDED.expires_at,
             revoked_at = NULL,
             last_seen_at = now()`,
      [sessionId, userId, deviceId, tokenHash(refreshToken), refreshExpiresAt],
    )
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
      deviceId,
      mustChangePassword,
    }
  }

  private async writeAudit(
    client: PoolClient,
    userId: string,
    deviceId: string,
    eventType: string,
    outcome: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO changfu.security_audit (
         audit_id, user_id, device_id, event_type, outcome
       ) VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5)`,
      [randomUUID(), userId, deviceId, eventType, outcome],
    )
  }
}
