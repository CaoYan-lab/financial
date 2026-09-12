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
import { getPool } from '../db/pgClient.js'
import { logger } from '../../utils/logger.js'

// 固定锁 key（任意大整数，'fin cloud worker leader' 派生常量）
export const LEADER_LOCK_KEY = 7129036401
const LEADER_RECOVERY_LOCK_KEY = LEADER_LOCK_KEY + 1
const LEADER_STALE_MS = Math.max(
  30_000,
  Number(process.env.WORKER_LEADER_STALE_MS || 90_000) || 90_000,
)

/**
 * 尝试获取 leader 锁。
 * 成功：返回被持有、不可释放回池的连接（锁随其生命周期持有）；
 * 失败：连接已释放回池，返回 null（表示已有 leader）。
 */
export async function tryAcquireLeader(): Promise<PoolClient | null> {
  const client = await getPool().connect()
  try {
    const res = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS got',
      [LEADER_LOCK_KEY],
    )
    if (res.rows[0]?.got) {
      return client
    }
    if (await recoverStaleLeader(client)) {
      return client
    }
    client.release()
    return null
  } catch (error) {
    client.release()
    throw error
  }
}

async function recoverStaleLeader(client: PoolClient): Promise<boolean> {
  const recovery = await client.query<{ got: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS got',
    [LEADER_RECOVERY_LOCK_KEY],
  )
  if (!recovery.rows[0]?.got) return false

  try {
    const status = await client.query<{ stale: boolean }>(
      `SELECT COALESCE(
         (
           SELECT heartbeat_at < now() - make_interval(secs => $1)
           FROM cloud_worker_status
           WHERE platform = 'leader'
         ),
         FALSE
       ) AS stale`,
      [Math.ceil(LEADER_STALE_MS / 1_000)],
    )
    if (!status.rows[0]?.stale) return false

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
        backendPids: terminatedPids,
      },
      '已回收过期 Leader 连接并原子接管 Leader 锁',
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
export async function leaderKeepAlive(client: PoolClient): Promise<boolean> {
  try {
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
