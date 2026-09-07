import { query, queryOne } from '../db/pgClient.js'

// ============ cloud_jobs 任务队列 ============

export type JobRow = {
  id: string
  job_type: string
  payload: Record<string, unknown>
  status: string
  claimed_by: string | null
  attempts: number
  last_error: string | null
  result: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

export async function enqueueJob(
  jobType: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO cloud_jobs (job_type, payload)
     VALUES ($1, $2::jsonb) RETURNING id`,
    [jobType, JSON.stringify(payload)],
  )
  return String(row?.id ?? '')
}

export async function getJob(id: string): Promise<JobRow | null> {
  return queryOne<JobRow>(
    `SELECT id, job_type, payload, status, claimed_by, attempts, last_error, result, created_at, updated_at
     FROM cloud_jobs
     WHERE id = $1`,
    [id],
  )
}

export type ClaimedJob = {
  id: string
  jobType: string
  payload: Record<string, unknown>
}

/**
 * 认领一个待执行任务（行级锁，多 worker 安全）。
 * 返回 null 表示无任务。
 */
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  const row = await queryOne<{
    id: string
    job_type: string
    payload: Record<string, unknown>
  }>(
    `UPDATE cloud_jobs
       SET status = 'running', claimed_by = $1, attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM cloud_jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, job_type, payload`,
    [workerId],
  )
  if (!row) return null
  return { id: String(row.id), jobType: row.job_type, payload: row.payload ?? {} }
}

export async function completeJob(id: string, result: Record<string, unknown> = {}): Promise<void> {
  await query(
    `UPDATE cloud_jobs SET status = 'succeeded', result = $2::jsonb, last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(result)],
  )
}

const MAX_ATTEMPTS = 3

export async function failJob(id: string, error: string): Promise<void> {
  await query(
    `UPDATE cloud_jobs
       SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
           claimed_by = NULL,
           last_error = $3,
           run_after = CASE WHEN attempts >= $2 THEN run_after ELSE now() + make_interval(secs => 30) END,
           updated_at = now()
     WHERE id = $1`,
    [id, MAX_ATTEMPTS, error],
  )
}

// ============ cloud_engine_state 引擎期望状态 ============

export async function setEngineDesired(platform: string, engineKey: string, desired: string): Promise<void> {
  await query(
    `INSERT INTO cloud_engine_state (platform, engine_key, desired, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (platform, engine_key) DO UPDATE SET desired = EXCLUDED.desired, updated_at = now()`,
    [platform, engineKey, desired],
  )
}

export async function getEngineDesired(platform: string, engineKey: string): Promise<string | null> {
  const row = await queryOne<{ desired: string }>(
    `SELECT desired FROM cloud_engine_state WHERE platform = $1 AND engine_key = $2`,
    [platform, engineKey],
  )
  return row?.desired ?? null
}

// ============ cloud_worker_status worker 心跳快照 ============

export async function upsertWorkerStatus(platform: string, snapshot: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO cloud_worker_status (platform, snapshot, heartbeat_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (platform) DO UPDATE SET snapshot = EXCLUDED.snapshot, heartbeat_at = now()`,
    [platform, JSON.stringify(snapshot)],
  )
}

export async function getWorkerStatus(platform: string): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ snapshot: Record<string, unknown>; heartbeat_at: Date }>(
    `SELECT snapshot, heartbeat_at FROM cloud_worker_status WHERE platform = $1`,
    [platform],
  )
  if (!row) return null
  return { ...(row.snapshot ?? {}), heartbeatAt: row.heartbeat_at?.toISOString?.() ?? null }
}

export async function listWorkerStatus(): Promise<Array<Record<string, unknown>>> {
  const rows = await query<{ platform: string; snapshot: Record<string, unknown>; heartbeat_at: Date }>(
    `SELECT platform, snapshot, heartbeat_at FROM cloud_worker_status ORDER BY platform`,
  )
  return rows.map((row) => ({
    platform: row.platform,
    heartbeatAt: row.heartbeat_at?.toISOString?.() ?? null,
    ...(row.snapshot ?? {}),
  }))
}
