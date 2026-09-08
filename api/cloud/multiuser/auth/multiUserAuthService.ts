import { query, queryOne } from '../../db/pgClient.js'
import { signToken } from '../../auth/jwt.js'
import { verifyPassword } from './passwordService.js'
import { ensureOwnerProfile, getProfile } from './profileStore.js'
import { writeSecurityAudit } from '../audit/securityAuditStore.js'
import type { UserProfile } from '../types.js'

type LoginRow = {
  id: string
  username: string
  password_hash: string
}

export function multiUserEnabled(): boolean {
  return process.env.MULTIUSER_ENABLED === 'true'
}

export async function authenticateMultiUser(
  username: string,
  password: string,
  ip?: string,
  userAgent?: string,
): Promise<{ ok: true; token: string; profile: UserProfile } | { ok: false; error: string }> {
  await ensureOwnerProfile()
  const user = await queryOne<LoginRow>(
    'SELECT id, username, password_hash FROM public.cloud_users WHERE username = $1',
    [username],
  )
  if (!user || !verifyPassword(password, user.password_hash)) {
    await writeSecurityAudit({ eventType: 'login_failed', success: false, ip, userAgent })
    return { ok: false, error: '用户名或密码错误' }
  }
  const profile = await getProfile(String(user.id))
  if (!profile || !profile.active) {
    await writeSecurityAudit({
      actorUserId: String(user.id),
      eventType: 'login_blocked',
      success: false,
      ip,
      userAgent,
    })
    return { ok: false, error: '账号未启用' }
  }
  await query(
    'UPDATE public.cloud_users SET last_login_at = now() WHERE id = $1',
    [user.id],
  )
  await writeSecurityAudit({
    actorUserId: String(user.id),
    eventType: 'login_success',
    success: true,
    ip,
    userAgent,
  })
  return {
    ok: true,
    token: signToken({ sub: String(user.id), username: user.username }),
    profile,
  }
}
