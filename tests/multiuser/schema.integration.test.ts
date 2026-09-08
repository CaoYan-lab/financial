import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, getPool, query, queryOne } from '../../api/cloud/db/pgClient.js'
import { hashPassword } from '../../api/cloud/multiuser/auth/passwordService.js'
import { claimTenantJob, enqueueTenantJob } from '../../api/cloud/multiuser/longbridge/tenantJobStore.js'

const enabled = process.env.RUN_PG_INTEGRATION === '1'
const describePg = enabled ? describe : describe.skip

describePg('多用户 PostgreSQL 隔离与约束', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toContain('/financial_test')
    process.env.MULTIUSER_OWNER_USERNAME = 'owner_test'
    await query(
      `INSERT INTO cloud_users (username, password_hash)
       VALUES ('owner_test', $1), ('member_a', $2), ('member_b', $3)`,
      [hashPassword('OwnerPassword12'), hashPassword('MemberPassword12'), hashPassword('MemberPassword34')],
    )
    const users = await query<{ id: string; username: string }>('SELECT id, username FROM cloud_users')
    const byName = Object.fromEntries(users.map((user) => [user.username, String(user.id)]))
    await query(
      `INSERT INTO multiuser.user_profiles
         (user_id, display_name, role, active, must_change_password, created_by)
       VALUES ($1, '所有者', 'owner', TRUE, FALSE, $1),
              ($2, '成员甲', 'member', TRUE, FALSE, $1),
              ($3, '成员乙', 'member', TRUE, FALSE, $1)`,
      [byName.owner_test, byName.member_a, byName.member_b],
    )
    await query(
      `INSERT INTO multiuser.broker_connections
         (id, user_id, platform, credential_source, status)
       VALUES ('binding-a', $1, 'longbridge', 'encrypted_bundle', 'verified'),
              ('binding-b', $2, 'longbridge', 'encrypted_bundle', 'verified')`,
      [byName.member_a, byName.member_b],
    )
  })

  afterAll(closePool)

  it('基础与多用户 schema 可重复应用', async () => {
    const pool = getPool()
    await pool.query(readFileSync('deploy/volcano/pg/schema.sql', 'utf8'))
    await pool.query(readFileSync('deploy/volcano/pg/multiuser_schema.sql', 'utf8'))
    const row = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='multiuser'",
    )
    expect(Number(row?.count)).toBeGreaterThanOrEqual(9)
  })

  it('数据库拒绝第二个 owner', async () => {
    const member = await queryOne<{ id: string }>("SELECT id FROM cloud_users WHERE username='member_a'")
    await expect(query(
      "UPDATE multiuser.user_profiles SET role='owner' WHERE user_id=$1",
      [member!.id],
    )).rejects.toThrow()
  })

  it('每个用户最多一个 verified 绑定', async () => {
    const member = await queryOne<{ id: string }>("SELECT id FROM cloud_users WHERE username='member_a'")
    await expect(query(
      `INSERT INTO multiuser.broker_connections
         (id, user_id, platform, credential_source, status)
       VALUES ('binding-a-duplicate', $1, 'longbridge', 'encrypted_bundle', 'verified')`,
      [member!.id],
    )).rejects.toThrow()
  })

  it('任务入队和认领保留 user_id + binding_id 且不跨租户', async () => {
    const member = await queryOne<{ id: string }>("SELECT id FROM cloud_users WHERE username='member_a'")
    const id = await enqueueTenantJob({
      userId: String(member!.id),
      bindingId: 'binding-a',
      jobType: 'multiuser.longbridge.orders',
    })
    const claimed = await claimTenantJob('integration-worker')
    expect(claimed).toMatchObject({
      id,
      userId: String(member!.id),
      bindingId: 'binding-a',
    })
    await expect(enqueueTenantJob({
      userId: String(member!.id),
      bindingId: 'binding-b',
      jobType: 'multiuser.longbridge.orders',
    })).rejects.toThrow('不属于当前用户')
  })

  it('重复应用 schema 时只清理休市伪信号', async () => {
    const member = await queryOne<{ id: string }>("SELECT id FROM cloud_users WHERE username='member_a'")
    await query(
      `INSERT INTO multiuser.longbridge_events
         (user_id, binding_id, kind, status, payload)
       VALUES
         ($1, 'binding-a', 'signals', 'SKIPPED', $2::jsonb),
         ($1, 'binding-a', 'signals', 'SKIPPED', $3::jsonb)`,
      [
        member!.id,
        JSON.stringify({
          id: 'closed-pseudo-signal',
          lifecycleStatus: 'SKIPPED',
          marketState: 'CLOSED',
          lifecycleReason: '港股休市后 LLM 请求已关闭，当前市场状态 CLOSED。',
        }),
        JSON.stringify({
          id: 'market-data-failure',
          lifecycleStatus: 'SKIPPED',
          marketState: 'CLOSED',
          lifecycleReason: '行情不可用',
        }),
      ],
    )

    await getPool().query(readFileSync('deploy/volcano/pg/multiuser_schema.sql', 'utf8'))

    const rows = await query<{ id: string }>(
      `SELECT payload->>'id' AS id
       FROM multiuser.longbridge_events
       WHERE user_id = $1 AND binding_id = 'binding-a' AND kind = 'signals'`,
      [member!.id],
    )
    expect(rows.map((row) => row.id)).not.toContain('closed-pseudo-signal')
    expect(rows.map((row) => row.id)).toContain('market-data-failure')
  })
})
