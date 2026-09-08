import { query, queryOne } from '../../db/pgClient.js'

export type TenantJob = {
  id: string
  userId: string
  bindingId: string
  jobType: string
  payload: Record<string, unknown>
}

export async function enqueueTenantJob(input: {
  userId: string
  bindingId: string
  jobType: string
  payload?: Record<string, unknown>
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO multiuser.longbridge_jobs
       (user_id, binding_id, job_type, payload)
     SELECT $1, $2, $3, $4::jsonb
     WHERE EXISTS (
       SELECT 1 FROM multiuser.broker_connections
       WHERE id = $2 AND user_id = $1
         AND (
           status = 'verified'
           OR (status = 'pending' AND $3 = 'multiuser.longbridge.verify_connection')
         )
     )
     RETURNING id`,
    [input.userId, input.bindingId, input.jobType, JSON.stringify(input.payload ?? {})],
  )
  if (!row) throw new Error('长桥绑定无效或不属于当前用户')
  return String(row.id)
}

export async function getTenantJob(userId: string, id: string): Promise<{
  status: string
  result?: Record<string, unknown>
  error?: string
} | null> {
  const row = await queryOne<{
    status: string
    result: Record<string, unknown> | null
    last_error: string | null
  }>(
    `SELECT status, result, last_error
     FROM multiuser.longbridge_jobs
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return row
    ? { status: row.status, result: row.result ?? undefined, error: row.last_error ?? undefined }
    : null
}

export async function claimTenantJob(workerId: string): Promise<TenantJob | null> {
  const row = await queryOne<{
    id: string
    user_id: string
    binding_id: string
    job_type: string
    payload: Record<string, unknown>
  }>(
    `UPDATE multiuser.longbridge_jobs j
     SET status = 'running', claimed_by = $1, attempts = attempts + 1, updated_at = now()
     WHERE j.id = (
       SELECT q.id
       FROM multiuser.longbridge_jobs q
       JOIN multiuser.user_profiles p ON p.user_id = q.user_id
       JOIN multiuser.broker_connections c
         ON c.id = q.binding_id AND c.user_id = q.user_id
       WHERE q.status = 'queued' AND q.run_after <= now()
         AND p.active = TRUE
         AND (
           c.status = 'verified'
           OR (
             c.status = 'pending'
             AND q.job_type = 'multiuser.longbridge.verify_connection'
           )
         )
       ORDER BY q.id
       FOR UPDATE OF q SKIP LOCKED
       LIMIT 1
     )
     RETURNING j.id, j.user_id, j.binding_id, j.job_type, j.payload`,
    [workerId],
  )
  return row
    ? {
        id: String(row.id),
        userId: String(row.user_id),
        bindingId: row.binding_id,
        jobType: row.job_type,
        payload: row.payload ?? {},
      }
    : null
}

export async function completeTenantJob(id: string, result: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE multiuser.longbridge_jobs
     SET status = 'succeeded', result = $2::jsonb, last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(result)],
  )
}

export async function failTenantJob(
  id: string,
  error: string,
  retryable = true,
): Promise<void> {
  await query(
    `UPDATE multiuser.longbridge_jobs
     SET status = CASE WHEN NOT $3 OR attempts >= 3 THEN 'failed' ELSE 'queued' END,
         claimed_by = NULL,
         last_error = $2,
         run_after = CASE
           WHEN NOT $3 OR attempts >= 3 THEN run_after
           ELSE now() + interval '30 seconds'
         END,
         updated_at = now()
     WHERE id = $1`,
    [id, error, retryable],
  )
}
