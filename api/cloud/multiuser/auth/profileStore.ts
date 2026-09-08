import { query, queryOne } from '../../db/pgClient.js'
import { hashPassword } from './passwordService.js'
import type { MultiUserRole, UserProfile } from '../types.js'

type ProfileRow = {
  user_id: string
  username: string
  display_name: string
  role: MultiUserRole
  active: boolean
  must_change_password: boolean
  sessions_valid_after: Date
}

function normalize(row: ProfileRow): UserProfile {
  return {
    userId: String(row.user_id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    mustChangePassword: row.must_change_password,
    sessionsValidAfter: row.sessions_valid_after.toISOString(),
  }
}

export async function ensureOwnerProfile(): Promise<void> {
  const username = process.env.MULTIUSER_OWNER_USERNAME?.trim()
    || process.env.ADMIN_USERNAME?.trim()
  if (!username) throw new Error('MULTIUSER_OWNER_USERNAME 未配置')
  const user = await queryOne<{ id: string }>(
    'SELECT id FROM public.cloud_users WHERE username = $1',
    [username],
  )
  if (!user) throw new Error(`owner 用户不存在：${username}`)
  const conflict = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM multiuser.user_profiles
     WHERE role = 'owner' AND user_id <> $1`,
    [user.id],
  )
  if (conflict) throw new Error('已存在其他 owner，拒绝自动迁移')
  await queryOne(
    `INSERT INTO multiuser.user_profiles
       (user_id, display_name, role, active, must_change_password, created_by)
     VALUES ($1, 'caoshaokun', 'owner', TRUE, FALSE, $1)
     ON CONFLICT (user_id) DO UPDATE
       SET display_name = 'caoshaokun', role = 'owner', active = TRUE, updated_at = now()
     RETURNING user_id`,
    [user.id],
  )
  await queryOne(
    `INSERT INTO multiuser.broker_connections
       (id, user_id, platform, credential_source, status, account_fingerprint, last_verified_at)
     VALUES ('legacy-longbridge-owner', $1, 'longbridge', 'legacy_env', 'verified', 'owner-legacy', now())
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [user.id],
  )
}

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const row = await queryOne<ProfileRow>(
    `SELECT p.user_id, u.username, p.display_name, p.role, p.active, p.must_change_password,
            p.sessions_valid_after
     FROM multiuser.user_profiles p
     JOIN public.cloud_users u ON u.id = p.user_id
     WHERE p.user_id = $1`,
    [userId],
  )
  return row ? normalize(row) : null
}

export async function listProfiles(): Promise<UserProfile[]> {
  const rows = await query<ProfileRow>(
    `SELECT p.user_id, u.username, p.display_name, p.role, p.active, p.must_change_password,
            p.sessions_valid_after
     FROM multiuser.user_profiles p
     JOIN public.cloud_users u ON u.id = p.user_id
     ORDER BY CASE WHEN p.role = 'owner' THEN 0 ELSE 1 END, u.username`,
  )
  return rows.map(normalize)
}

export async function createMember(input: {
  username: string
  displayName: string
  temporaryPassword: string
  createdBy: string
}): Promise<UserProfile> {
  const row = await queryOne<ProfileRow>(
    `WITH new_user AS (
       INSERT INTO public.cloud_users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username
     ), new_profile AS (
       INSERT INTO multiuser.user_profiles
         (user_id, display_name, role, active, must_change_password, created_by)
       SELECT id, $3, 'member', TRUE, TRUE, $4 FROM new_user
       RETURNING user_id, display_name, role, active, must_change_password, sessions_valid_after
     )
     SELECT p.user_id, u.username, p.display_name, p.role, p.active, p.must_change_password,
            p.sessions_valid_after
     FROM new_profile p JOIN new_user u ON u.id = p.user_id`,
    [input.username, hashPassword(input.temporaryPassword), input.displayName, input.createdBy],
  )
  if (!row) throw new Error('创建用户失败')
  return normalize(row)
}

export async function setProfileActive(userId: string, active: boolean): Promise<void> {
  await query(
    `UPDATE multiuser.user_profiles
     SET active = $2, sessions_valid_after = now(), updated_at = now()
     WHERE user_id = $1 AND role <> 'owner'`,
    [userId, active],
  )
}

export async function resetMemberPassword(userId: string, temporaryPassword: string): Promise<void> {
  await query(
    `UPDATE public.cloud_users u
     SET password_hash = $2
     FROM multiuser.user_profiles p
     WHERE u.id = $1 AND p.user_id = u.id AND p.role = 'member'`,
    [userId, hashPassword(temporaryPassword)],
  )
  await query(
    `UPDATE multiuser.user_profiles
     SET must_change_password = TRUE, sessions_valid_after = now(), updated_at = now()
     WHERE user_id = $1 AND role = 'member'`,
    [userId],
  )
}

export async function changePassword(userId: string, password: string): Promise<void> {
  await query(
    'UPDATE public.cloud_users SET password_hash = $2 WHERE id = $1',
    [userId, hashPassword(password)],
  )
  await query(
    `UPDATE multiuser.user_profiles
     SET must_change_password = FALSE, sessions_valid_after = now(), updated_at = now()
     WHERE user_id = $1`,
    [userId],
  )
}

export async function getPasswordHash(userId: string): Promise<string | null> {
  const row = await queryOne<{ password_hash: string }>(
    'SELECT password_hash FROM public.cloud_users WHERE id = $1',
    [userId],
  )
  return row?.password_hash ?? null
}
