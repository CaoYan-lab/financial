import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { hashAdminPassword, validateAdminPassword } from '../../admin/src/password.js'
import type { PostgresAdminRepository } from './postgresAdminRepository.js'

type UserRow = {
  id: string
  username: string
  display_name: string
  active: boolean
  must_change_password: boolean
  created_at: Date
  last_login_at: Date | null
}

function publicUser(row: UserRow) {
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    active: row.active,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  }
}

export class AdminUserError extends Error {
  constructor(readonly code: string) {
    super('用户管理操作失败')
    this.name = 'AdminUserError'
  }
}

export class PostgresAdminUserRepository {
  constructor(
    private readonly pool: Pool,
    private readonly adminRepository: PostgresAdminRepository,
  ) {}

  async list(input: {
    query: string
    status: 'all' | 'active' | 'disabled'
    page: number
    pageSize: number
  }): Promise<{ items: ReturnType<typeof publicUser>[]; total: number }> {
    const pattern = `%${input.query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const active = input.status === 'all' ? null : input.status === 'active'
    const offset = (input.page - 1) * input.pageSize
    const result = await this.pool.query<UserRow & { total_count: string }>(
      `SELECT u.id, u.username, p.display_name, p.active, p.must_change_password,
              u.created_at, u.last_login_at, count(*) OVER()::text AS total_count
         FROM public.cloud_users u
         JOIN multiuser.user_profiles p ON p.user_id = u.id
        WHERE p.role = 'member'
          AND ($1 = '' OR u.username ILIKE $2 ESCAPE '\\'
            OR p.display_name ILIKE $2 ESCAPE '\\')
          AND ($3::boolean IS NULL OR p.active = $3)
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT $4 OFFSET $5`,
      [input.query, pattern, active, input.pageSize, offset],
    )
    return {
      items: result.rows.map(publicUser),
      total: Number(result.rows[0]?.total_count ?? 0),
    }
  }

  async detail(userId: string): Promise<Record<string, unknown> | null> {
    const user = await this.pool.query<UserRow>(
      `SELECT u.id, u.username, p.display_name, p.active, p.must_change_password,
              u.created_at, u.last_login_at
         FROM public.cloud_users u
         JOIN multiuser.user_profiles p ON p.user_id = u.id
        WHERE u.id = $1::bigint AND p.role = 'member'`,
      [userId],
    )
    const row = user.rows[0]
    if (!row) return null
    const [devices, connections, subscription] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM changfu.devices
          WHERE user_id = $1::bigint AND status = 'ACTIVE'`,
        [userId],
      ),
      this.pool.query<{
        provider: string
        status: string
        connection_id: string
      }>(
        `SELECT broker AS provider, status, broker_connection_id::text AS connection_id
           FROM changfu.broker_connections
          WHERE user_id = $1::bigint AND status <> 'DELETED'
          ORDER BY broker, created_at`,
        [userId],
      ),
      this.pool.query<{
        subscription_id: string
        status: string
        version: string
        starts_at: Date
        expires_at: Date
        plan_code: string
        plan_version: number
        display_name: string
        broker_slot_limit: number
        slots: unknown
      }>(
        `SELECT s.subscription_id, s.status, s.version, s.starts_at, s.expires_at,
                p.plan_code, p.version AS plan_version, p.display_name,
                p.broker_slot_limit,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'slotId', bs.slot_id,
                    'ordinal', bs.slot_ordinal,
                    'providerId', bs.provider_id,
                    'status', bs.status,
                    'boundAt', bs.bound_at,
                    'nextRebindAt', bs.next_rebind_at,
                    'version', bs.version
                  ) ORDER BY bs.slot_ordinal)
                  FROM changfu.subscription_broker_slots bs
                  WHERE bs.subscription_id = s.subscription_id
                ), '[]'::jsonb) AS slots
           FROM changfu.user_subscriptions s
           JOIN changfu.subscription_plan_versions p
             ON p.plan_version_id = s.plan_version_id
          WHERE s.user_id = $1::bigint
            AND s.status IN ('ACTIVE', 'FROZEN')
          LIMIT 1`,
        [userId],
      ),
    ])
    const current = subscription.rows[0]
    const slots = current && Array.isArray(current.slots) ? current.slots : []
    return {
      ...publicUser(row),
      activeDeviceCount: Number(devices.rows[0]?.count ?? 0),
      brokerConnections: connections.rows.map(item => ({
        connectionId: item.connection_id,
        provider: item.provider,
        status: item.status,
      })),
      subscription: current ? {
        subscriptionId: current.subscription_id,
        status: current.status,
        version: Number(current.version),
        startsAt: current.starts_at.toISOString(),
        expiresAt: current.expires_at.toISOString(),
        planCode: current.plan_code,
        planVersion: current.plan_version,
        planDisplayName: current.display_name,
        usedSlots: slots.filter(slot => (
          typeof slot === 'object'
          && slot !== null
          && (slot as { status?: string }).status === 'ACTIVE'
          && Number((slot as { ordinal?: number }).ordinal) <= current.broker_slot_limit
        )).length,
        totalSlots: current.broker_slot_limit,
        slots,
      } : null,
    }
  }

  async create(input: {
    username: string
    displayName: string
    temporaryPassword: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<ReturnType<typeof publicUser>> {
    if (!validateAdminPassword(input.temporaryPassword)) {
      throw new AdminUserError('USER_PASSWORD_INVALID')
    }
    return this.transaction(async client => {
      try {
        const passwordHash = await hashAdminPassword(input.temporaryPassword)
        const user = await client.query<{ id: string; username: string; created_at: Date }>(
          `INSERT INTO public.cloud_users (username, password_hash)
           VALUES ($1, $2)
           RETURNING id, username, created_at`,
          [input.username, passwordHash],
        )
        const created = user.rows[0]!
        const profile = await client.query<{
          display_name: string
          active: boolean
          must_change_password: boolean
        }>(
          `INSERT INTO multiuser.user_profiles (
             user_id, display_name, role, active, must_change_password, created_by
           ) VALUES ($1::bigint, $2, 'member', true, true, NULL)
           RETURNING display_name, active, must_change_password`,
          [created.id, input.displayName],
        )
        await this.adminRepository.writeAudit(client, {
          actorAdminUserId: input.actorAdminUserId,
          action: 'USER_CREATED',
          resourceType: 'USER',
          resourceId: created.id,
          outcome: 'SUCCESS',
          requestId: input.requestId,
          sourceIp: input.sourceIp,
          afterSummary: {
            username: created.username,
            displayName: profile.rows[0]!.display_name,
            active: true,
          },
        })
        return publicUser({
          id: created.id,
          username: created.username,
          display_name: profile.rows[0]!.display_name,
          active: profile.rows[0]!.active,
          must_change_password: profile.rows[0]!.must_change_password,
          created_at: created.created_at,
          last_login_at: null,
        })
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new AdminUserError('USERNAME_ALREADY_EXISTS')
        }
        throw error
      }
    })
  }

  async update(input: {
    userId: string
    username?: string
    displayName?: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<Record<string, unknown>> {
    return this.transaction(async client => {
      const before = await this.lockUser(client, input.userId)
      if (!before) throw new AdminUserError('USER_NOT_FOUND')
      try {
        if (input.username !== undefined) {
          await client.query(
            'UPDATE public.cloud_users SET username = $2 WHERE id = $1::bigint',
            [input.userId, input.username],
          )
        }
        if (input.displayName !== undefined) {
          await client.query(
            `UPDATE multiuser.user_profiles
                SET display_name = $2, updated_at = now()
              WHERE user_id = $1::bigint`,
            [input.userId, input.displayName],
          )
        }
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new AdminUserError('USERNAME_ALREADY_EXISTS')
        }
        throw error
      }
      if (input.username !== undefined && input.username !== before.username) {
        await this.revokeUserSessions(client, input.userId)
      }
      await this.adminRepository.writeAudit(client, {
        actorAdminUserId: input.actorAdminUserId,
        action: 'USER_UPDATED',
        resourceType: 'USER',
        resourceId: input.userId,
        outcome: 'SUCCESS',
        requestId: input.requestId,
        sourceIp: input.sourceIp,
        beforeSummary: { username: before.username, displayName: before.display_name },
        afterSummary: {
          username: input.username ?? before.username,
          displayName: input.displayName ?? before.display_name,
        },
      })
      return {
        userId: input.userId,
        username: input.username ?? before.username,
        displayName: input.displayName ?? before.display_name,
      }
    })
  }

  async resetPassword(input: {
    userId: string
    temporaryPassword: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<void> {
    if (!validateAdminPassword(input.temporaryPassword)) {
      throw new AdminUserError('USER_PASSWORD_INVALID')
    }
    await this.transaction(async client => {
      const user = await this.lockUser(client, input.userId)
      if (!user) throw new AdminUserError('USER_NOT_FOUND')
      const passwordHash = await hashAdminPassword(input.temporaryPassword)
      await client.query(
        'UPDATE public.cloud_users SET password_hash = $2 WHERE id = $1::bigint',
        [input.userId, passwordHash],
      )
      await client.query(
        `UPDATE multiuser.user_profiles
            SET must_change_password = true, sessions_valid_after = now(), updated_at = now()
          WHERE user_id = $1::bigint`,
        [input.userId],
      )
      await this.revokeUserSessions(client, input.userId)
      await this.adminRepository.writeAudit(client, {
        actorAdminUserId: input.actorAdminUserId,
        action: 'USER_PASSWORD_RESET',
        resourceType: 'USER',
        resourceId: input.userId,
        outcome: 'SUCCESS',
        requestId: input.requestId,
        sourceIp: input.sourceIp,
      })
    })
  }

  async setActive(input: {
    userId: string
    active: boolean
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<void> {
    await this.transaction(async client => {
      const user = await this.lockUser(client, input.userId)
      if (!user) throw new AdminUserError('USER_NOT_FOUND')
      await client.query(
        `UPDATE multiuser.user_profiles
            SET active = $2, sessions_valid_after = now(), updated_at = now()
          WHERE user_id = $1::bigint`,
        [input.userId, input.active],
      )
      if (!input.active) await this.revokeUserSessions(client, input.userId)
      await this.adminRepository.writeAudit(client, {
        actorAdminUserId: input.actorAdminUserId,
        action: input.active ? 'USER_ENABLED' : 'USER_DISABLED',
        resourceType: 'USER',
        resourceId: input.userId,
        outcome: 'SUCCESS',
        requestId: input.requestId,
        sourceIp: input.sourceIp,
        beforeSummary: { active: user.active },
        afterSummary: { active: input.active },
      })
    })
  }

  private async lockUser(client: PoolClient, userId: string): Promise<UserRow | null> {
    const result = await client.query<UserRow>(
      `SELECT u.id, u.username, p.display_name, p.active, p.must_change_password,
              u.created_at, u.last_login_at
         FROM public.cloud_users u
         JOIN multiuser.user_profiles p ON p.user_id = u.id
        WHERE u.id = $1::bigint AND p.role = 'member'
        FOR UPDATE OF u, p`,
      [userId],
    )
    return result.rows[0] ?? null
  }

  private async revokeUserSessions(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE changfu.device_sessions
          SET revoked_at = now()
        WHERE user_id = $1::bigint AND revoked_at IS NULL`,
      [userId],
    )
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
