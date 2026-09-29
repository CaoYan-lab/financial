import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { hashAdminPassword, verifyAdminPassword } from '../../admin/src/password.js'
import {
  adminSessionAbsoluteTtlMs,
  adminSessionIdleTtlMs,
  hashOpaqueToken,
  randomOpaqueToken,
} from '../../admin/src/session.js'

export type AdminIdentity = {
  adminUserId: string
  username: string
  role: 'SUPER_ADMIN'
  mustChangePassword: boolean
}

export type AdminSession = AdminIdentity & {
  adminSessionId: string
  csrfToken: string
  expiresAt: string
}

type AdminRow = {
  admin_user_id: string
  username: string
  password_hash: string
  role: 'SUPER_ADMIN'
  enabled: boolean
  must_change_password: boolean
  failed_login_count: number
  locked_until: Date | null
}

type SessionRow = {
  admin_session_id: string
  admin_user_id: string
  username: string
  role: 'SUPER_ADMIN'
  must_change_password: boolean
  csrf_token_hash: string
  expires_at: Date
}

export class AdminAuthenticationError extends Error {
  constructor(readonly code = 'ADMIN_LOGIN_REJECTED') {
    super('用户名或密码错误，或账号不可用')
    this.name = 'AdminAuthenticationError'
  }
}

export class PostgresAdminRepository {
  constructor(private readonly pool: Pool) {}

  async seedInitialAdmin(password: string | undefined): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('changfu-admin-seed'))`)
      const count = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM changfu_admin.admin_users',
      )
      if (Number(count.rows[0]?.count ?? 0) > 0) {
        await client.query('COMMIT')
        return false
      }
      if (!password) throw new Error('CHANGFU_ADMIN_INITIAL_PASSWORD_REQUIRED')
      const passwordHash = await hashAdminPassword(password)
      await client.query(
        `INSERT INTO changfu_admin.admin_users (
           admin_user_id, username, password_hash, role, enabled, must_change_password
         ) VALUES ($1::uuid, 'admin', $2, 'SUPER_ADMIN', true, true)`,
        [randomUUID(), passwordHash],
      )
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async login(input: {
    username: string
    password: string
    requestId: string
    sourceIp: string | null
  }): Promise<{ session: AdminSession; token: string }> {
    const username = input.username.trim().toLowerCase()
    const client = await this.pool.connect()
    let transactionOpen = false
    try {
      await client.query('BEGIN')
      transactionOpen = true
      const result = await client.query<AdminRow>(
        `SELECT admin_user_id, username, password_hash, role, enabled,
                must_change_password, failed_login_count, locked_until
           FROM changfu_admin.admin_users
          WHERE username = $1
          FOR UPDATE`,
        [username],
      )
      const admin = result.rows[0]
      const acceptable = Boolean(
        admin
        && admin.enabled
        && (!admin.locked_until || admin.locked_until.getTime() <= Date.now())
        && await verifyAdminPassword(input.password, admin.password_hash),
      )
      if (!admin || !acceptable) {
        if (admin) {
          await client.query(
            `UPDATE changfu_admin.admin_users
                SET failed_login_count = failed_login_count + 1,
                    locked_until = CASE
                      WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes'
                      ELSE locked_until
                    END,
                    updated_at = now()
              WHERE admin_user_id = $1::uuid`,
            [admin.admin_user_id],
          )
          await this.writeAudit(client, {
            actorAdminUserId: admin.admin_user_id,
            action: 'ADMIN_LOGIN',
            resourceType: 'ADMIN_SESSION',
            outcome: 'FAILURE',
            requestId: input.requestId,
            sourceIp: input.sourceIp,
          })
        }
        await client.query('COMMIT')
        transactionOpen = false
        throw new AdminAuthenticationError()
      }

      const token = randomOpaqueToken()
      const csrfToken = randomOpaqueToken()
      const now = new Date()
      const expiresAt = new Date(now.getTime() + adminSessionAbsoluteTtlMs)
      const idleExpiresAt = new Date(now.getTime() + adminSessionIdleTtlMs)
      const sessionId = randomUUID()
      await client.query(
        `INSERT INTO changfu_admin.admin_sessions (
           admin_session_id, admin_user_id, session_token_hash, csrf_token_hash,
           expires_at, idle_expires_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz)`,
        [
          sessionId,
          admin.admin_user_id,
          hashOpaqueToken(token),
          hashOpaqueToken(csrfToken),
          expiresAt,
          idleExpiresAt,
        ],
      )
      await client.query(
        `UPDATE changfu_admin.admin_users
            SET failed_login_count = 0, locked_until = NULL,
                last_login_at = now(), updated_at = now()
          WHERE admin_user_id = $1::uuid`,
        [admin.admin_user_id],
      )
      await this.writeAudit(client, {
        actorAdminUserId: admin.admin_user_id,
        action: 'ADMIN_LOGIN',
        resourceType: 'ADMIN_SESSION',
        resourceId: sessionId,
        outcome: 'SUCCESS',
        requestId: input.requestId,
        sourceIp: input.sourceIp,
      })
      await client.query('COMMIT')
      transactionOpen = false
      return {
        token,
        session: {
          adminSessionId: sessionId,
          adminUserId: admin.admin_user_id,
          username: admin.username,
          role: admin.role,
          mustChangePassword: admin.must_change_password,
          csrfToken,
          expiresAt: expiresAt.toISOString(),
        },
      }
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async authenticate(token: string): Promise<(AdminIdentity & {
    adminSessionId: string
    csrfTokenHash: string
  }) | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<SessionRow>(
        `SELECT s.admin_session_id, s.admin_user_id, s.csrf_token_hash, s.expires_at,
                a.username, a.role, a.must_change_password
           FROM changfu_admin.admin_sessions s
           JOIN changfu_admin.admin_users a ON a.admin_user_id = s.admin_user_id
          WHERE s.session_token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
            AND s.idle_expires_at > now()
            AND a.enabled = true
          FOR UPDATE OF s`,
        [hashOpaqueToken(token)],
      )
      const row = result.rows[0]
      if (!row) {
        await client.query('COMMIT')
        return null
      }
      await client.query(
        `UPDATE changfu_admin.admin_sessions
            SET last_activity_at = now(),
                idle_expires_at = LEAST(expires_at, now() + interval '30 minutes')
          WHERE admin_session_id = $1::uuid`,
        [row.admin_session_id],
      )
      await client.query('COMMIT')
      return {
        adminSessionId: row.admin_session_id,
        adminUserId: row.admin_user_id,
        username: row.username,
        role: row.role,
        mustChangePassword: row.must_change_password,
        csrfTokenHash: row.csrf_token_hash,
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async changePassword(input: {
    identity: AdminIdentity
    currentPassword: string
    nextPassword: string
    requestId: string
    sourceIp: string | null
  }): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<Pick<AdminRow, 'password_hash'>>(
        `SELECT password_hash
           FROM changfu_admin.admin_users
          WHERE admin_user_id = $1::uuid AND enabled = true
          FOR UPDATE`,
        [input.identity.adminUserId],
      )
      const row = result.rows[0]
      if (!row || !(await verifyAdminPassword(input.currentPassword, row.password_hash))) {
        throw new AdminAuthenticationError('ADMIN_CURRENT_PASSWORD_INVALID')
      }
      const passwordHash = await hashAdminPassword(input.nextPassword)
      await client.query(
        `UPDATE changfu_admin.admin_users
            SET password_hash = $2, must_change_password = false, updated_at = now()
          WHERE admin_user_id = $1::uuid`,
        [input.identity.adminUserId, passwordHash],
      )
      await client.query(
        `UPDATE changfu_admin.admin_sessions
            SET revoked_at = now()
          WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
        [input.identity.adminUserId],
      )
      await this.writeAudit(client, {
        actorAdminUserId: input.identity.adminUserId,
        action: 'ADMIN_PASSWORD_CHANGED',
        resourceType: 'ADMIN_USER',
        resourceId: input.identity.adminUserId,
        outcome: 'SUCCESS',
        requestId: input.requestId,
        sourceIp: input.sourceIp,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async logout(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE changfu_admin.admin_sessions
          SET revoked_at = now()
        WHERE admin_session_id = $1::uuid AND revoked_at IS NULL`,
      [sessionId],
    )
  }

  async claimMutation(input: {
    adminUserId: string
    operation: string
    idempotencyKey: string
    requestId: string
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO changfu_admin.mutation_idempotency_keys (
         admin_user_id, operation, idempotency_key, request_id
       ) VALUES ($1::uuid, $2, $3, $4::uuid)
       ON CONFLICT (admin_user_id, operation, idempotency_key) DO NOTHING`,
      [input.adminUserId, input.operation, input.idempotencyKey, input.requestId],
    )
    return result.rowCount === 1
  }

  async writeAudit(client: PoolClient, input: {
    actorAdminUserId: string | null
    action: string
    resourceType: string
    resourceId?: string
    outcome: 'SUCCESS' | 'FAILURE'
    requestId: string
    sourceIp: string | null
    beforeSummary?: unknown
    afterSummary?: unknown
  }): Promise<void> {
    await client.query(
      `INSERT INTO changfu_admin.audit_events (
         audit_event_id, actor_admin_user_id, action, resource_type,
         resource_id, outcome, request_id, source_ip, before_summary, after_summary
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::inet, $9::jsonb, $10::jsonb
       )`,
      [
        randomUUID(),
        input.actorAdminUserId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.outcome,
        input.requestId,
        input.sourceIp,
        input.beforeSummary === undefined ? null : JSON.stringify(input.beforeSummary),
        input.afterSummary === undefined ? null : JSON.stringify(input.afterSummary),
      ],
    )
  }
}
