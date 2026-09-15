/**
 * Worker 单 leader 选举：基于 PostgreSQL 会话级咨询锁（advisory lock）。
 *
 * veFaaS 常驻函数在多次发布/弹性伸缩后可能并存多个实例（旧版本残留、平台热实例），
 * 它们若同时驱动引擎单例会互相覆盖心跳、重复消费。用一把固定 key 的咨询锁保证：
 *  - 抢到锁的实例成为唯一 leader，负责引擎恢复、任务消费、'primary' 心跳快照；
 *  - 未抢到的实例为 standby，不跑业务逻辑，仅周期性重试，待 leader 失联（连接断开
 *    导致锁自动释放）后接管。
 *
 * 锁绑定在被持有的那条数据库连接上；连接关闭（进程退出/网络断开）即自动释放，
 * 因此不会出现 leader 死后无人接管的死锁。
 */
import type { PoolClient } from 'pg'
import { connectPgClient } from '../db/pgClient.js'
import { logger } from '../../utils/logger.js'

// 固定锁 key（任意大整数，'fin cloud worker leader' 派生常量）
export const LEADER_LOCK_KEY = 7129036401
const LEADER_RECOVERY_LOCK_KEY = LEADER_LOCK_KEY + 1
const LEADER_TARGET_GENERATION_KEY = 'cloud.worker.target_generation'
const LEADER_STALE_MS = Math.max(
  30_000,
  Number(process.env.WORKER_LEADER_STALE_MS || 90_000) || 90_000,
)

export function workerDeploymentGeneration(): number {
  const value = Number(process.env.WORKER_DEPLOYMENT_GENERATION || 0)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * 每个 Worker 进程启动时原子领取代际。平台可能在正式发布前用新配置重启旧
 * Revision，因此不能只依赖函数环境变量或镜像标签区分新旧实例。
 */
export async function reserveWorkerDeploymentGeneration(
  configuredGeneration = workerDeploymentGeneration(),
): Promise<number> {
  const client = await connectPgClient('reserve_worker_generation')
  try {
    const result = await client.query<{ generation: string }>(
      `INSERT INTO app_config(key, value, updated_at)
       VALUES (
         $1,
         jsonb_build_object(
           'generation',
           GREATEST($2::bigint, 1::bigint)
         ),
         now()
       )
       ON CONFLICT(key) DO UPDATE
         SET value = jsonb_build_object(
               'generation',
               GREATEST(
                 CASE
                   WHEN app_config.value->>'generation' ~ '^[0-9]+$'
                     THEN (app_config.value->>'generation')::bigint + 1
                   ELSE 1
                 END,
                 $2::bigint
               )
             ),
             updated_at = now()
       RETURNING value->>'generation' AS generation`,
      [LEADER_TARGET_GENERATION_KEY, configuredGeneration],
    )
    return Number(result.rows[0]?.generation ?? configuredGeneration)
  } finally {
    client.release()
  }
}

/**
 * 尝试获取 leader 锁。
 * 成功：返回被持有、不可释放回池的连接（锁随其生命周期持有）；
 * 失败：连接已释放回池，返回 null（表示已有 leader）。
 */
export async function tryAcquireLeader(
  candidateGeneration = workerDeploymentGeneration(),
): Promise<PoolClient | null> {
  const client = await connectPgClient('acquire_worker_leader')
  try {
    if (candidateGeneration > 0) {
      await announceDeploymentGeneration(client, candidateGeneration)
    }
    const res = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS got',
      [LEADER_LOCK_KEY],
    )
    if (res.rows[0]?.got) {
      return client
    }
    if (await recoverStaleLeader(client, candidateGeneration)) {
      return client
    }
    client.release()
    return null
  } catch (error) {
    client.release()
    throw error
  }
}

async function announceDeploymentGeneration(
  client: PoolClient,
  generation: number,
): Promise<void> {
  await client.query(
    `INSERT INTO app_config(key, value, updated_at)
     VALUES ($1, jsonb_build_object('generation', $2::bigint), now())
     ON CONFLICT(key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now()
       WHERE CASE
         WHEN app_config.value->>'generation' ~ '^[0-9]+$'
           THEN (app_config.value->>'generation')::bigint
         ELSE 0
       END < $2::bigint`,
    [LEADER_TARGET_GENERATION_KEY, generation],
  )
}

async function recoverStaleLeader(
  client: PoolClient,
  candidateGeneration: number,
): Promise<boolean> {
  const recovery = await client.query<{ got: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS got',
    [LEADER_RECOVERY_LOCK_KEY],
  )
  if (!recovery.rows[0]?.got) return false

  try {
    const status = await client.query<{ stale: boolean; leader_generation: string }>(
      `SELECT
         COALESCE(
           (
             SELECT heartbeat_at < now() - make_interval(secs => $1)
             FROM cloud_worker_status
             WHERE platform = 'leader'
           ),
           FALSE
         ) AS stale,
         COALESCE(
           (
             SELECT CASE
               WHEN snapshot->>'deploymentGeneration' ~ '^[0-9]+$'
                 THEN snapshot->>'deploymentGeneration'
               ELSE '0'
             END
             FROM cloud_worker_status
             WHERE platform = 'leader'
           ),
           '0'
         ) AS leader_generation`,
      [Math.ceil(LEADER_STALE_MS / 1_000)],
    )
    const leaderGeneration = Number(status.rows[0]?.leader_generation ?? 0)
    const superseded = candidateGeneration > 0 && candidateGeneration > leaderGeneration
    if (!status.rows[0]?.stale && !superseded) return false

    const lockClassId = Math.floor(LEADER_LOCK_KEY / 0x1_0000_0000)
    const lockObjectId = LEADER_LOCK_KEY >>> 0
    const terminated = await client.query<{ pid: number; terminated: boolean }>(
      `SELECT l.pid, pg_terminate_backend(l.pid) AS terminated
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory'
         AND l.classid = $1::oid
         AND l.objid = $2::oid
         AND l.objsubid = 1
         AND l.granted
         AND l.pid <> pg_backend_pid()
         AND a.usename = current_user
         AND a.application_name = 'financial-workbench-cloud'`,
      [lockClassId, lockObjectId],
    )
    const terminatedPids = terminated.rows.filter((row) => row.terminated).map((row) => row.pid)
    if (terminatedPids.length === 0) return false

    const acquired = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS got',
      [LEADER_LOCK_KEY],
    )
    if (!acquired.rows[0]?.got) return false
    logger.warn(
      {
        event: 'cloud.worker.leader.stale_connection_recovered',
        staleAfterMs: LEADER_STALE_MS,
        candidateGeneration,
        leaderGeneration,
        reason: superseded ? 'newer_deployment' : 'stale_heartbeat',
        backendPids: terminatedPids,
      },
      superseded
        ? '新发布代际已回收旧 Leader 连接并原子接管'
        : '已回收过期 Leader 连接并原子接管 Leader 锁',
    )
    return true
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LEADER_RECOVERY_LOCK_KEY])
  }
}

/** 释放 leader 锁并归还连接（进程优雅退出时调用，便于 standby 立刻接管）。 */
export async function releaseLeader(client: PoolClient | null): Promise<void> {
  if (!client) return
  try {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LEADER_LOCK_KEY])
  } catch {
    // 连接已断时锁本就随连接释放，忽略
  }
  try {
    client.release()
  } catch {
    // 已归还则忽略
  }
}

/** leader 连接保活探活：返回 false 表示连接已断（锁已丢失），应退出重选。 */
export async function leaderKeepAlive(
  client: PoolClient,
  generation = workerDeploymentGeneration(),
): Promise<boolean> {
  try {
    if (generation > 0) {
      const target = await client.query<{ generation: string }>(
        `SELECT COALESCE(
           (
             SELECT CASE
               WHEN value->>'generation' ~ '^[0-9]+$'
                 THEN value->>'generation'
               ELSE '0'
             END
             FROM app_config
             WHERE key = $1
           ),
           '0'
         ) AS generation`,
        [LEADER_TARGET_GENERATION_KEY],
      )
      const targetGeneration = Number(target.rows[0]?.generation ?? 0)
      if (targetGeneration > generation) {
        logger.warn(
          {
            event: 'cloud.worker.leader.handoff_requested',
            deploymentGeneration: generation,
            targetGeneration,
          },
          '检测到更高发布代际，主动释放 Leader',
        )
        return false
      }
    }
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
