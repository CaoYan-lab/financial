import { createHash } from 'node:crypto'
import { query } from '../../db/pgClient.js'

function digest(value?: string): string | null {
  if (!value) return null
  return createHash('sha256').update(value).digest('hex')
}

export async function writeSecurityAudit(input: {
  actorUserId?: string
  targetUserId?: string
  eventType: string
  resourceType?: string
  resourceId?: string
  success: boolean
  ip?: string
  userAgent?: string
  detail?: Record<string, unknown>
}): Promise<void> {
  await query(
    `INSERT INTO multiuser.security_audit
       (actor_user_id, target_user_id, event_type, resource_type, resource_id,
        success, ip_hash, user_agent_hash, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      input.actorUserId ?? null,
      input.targetUserId ?? null,
      input.eventType,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.success,
      digest(input.ip),
      digest(input.userAgent),
      input.detail ? JSON.stringify(input.detail) : null,
    ],
  ).catch(() => undefined)
}
