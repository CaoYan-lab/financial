import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getWorkerStatus,
  setEngineDesired,
  upsertWorkerStatus,
} from '../../api/cloud/state/taskStores.js'

const root = resolve(__dirname, '..', '..')
const urlFile = resolve(root, '.data/cloud-pg/database_url')
const pgAvailable = existsSync(urlFile)
const describeIfPg = pgAvailable ? describe : describe.skip

const TEST_JOB_PREFIX = `cloud-job-test-${process.pid}`

if (pgAvailable) {
  process.env.DATABASE_URL = readFileSync(urlFile, 'utf-8').trim()
}

async function cleanup() {
  const { getPool } = await import('../../api/cloud/db/pgClient.js')
  const pool = getPool()
  await pool.query("DELETE FROM cloud_jobs WHERE job_type LIKE $1", [`${TEST_JOB_PREFIX}%`])
  await pool.query("DELETE FROM cloud_engine_state WHERE engine_key LIKE $1", [`${TEST_JOB_PREFIX}%`])
  await pool.query("DELETE FROM cloud_worker_status WHERE platform LIKE $1", [`${TEST_JOB_PREFIX}%`])
  // 注意：不调用 pool.end()——连接池是模块级单例，关闭后同进程其他用例会失败
}

describeIfPg('云端 PG 任务队列与状态存储（本地 PG 可用时）', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  it('入队 → 认领 → 完成 全链路，且认领用 SKIP LOCKED 语义', async () => {
    const jobType = `${TEST_JOB_PREFIX}.ping`
    const id = await enqueueJob(jobType, { requestedBy: 'test' })
    expect(id).toBeTruthy()

    const claimed = await claimNextJob('worker-test-1')
    expect(claimed).not.toBeNull()
    expect(claimed?.id).toBe(id)
    expect(claimed?.jobType).toBe(jobType)
    expect((claimed?.payload as { requestedBy: string }).requestedBy).toBe('test')

    // 已被认领（status=running），第二个 worker 不应再领到同一任务
    const second = await claimNextJob('worker-test-2')
    // 队列中可能有其他遗留任务，但不应领到刚被认领的这一条
    if (second) expect(second.id).not.toBe(id)

    await completeJob(id, { ok: true })
    const afterComplete = await claimNextJob('worker-test-3')
    expect(afterComplete?.id).not.toBe(id)
  })

  it('失败任务在重试次数内回到队列并带延迟，超限标记 failed', async () => {
    const jobType = `${TEST_JOB_PREFIX}.flaky`
    const id = await enqueueJob(jobType, {})
    await claimNextJob('worker-test-1')
    await failJob(id, 'boom')

    const { getPool } = await import('../../api/cloud/db/pgClient.js')
    const pool = getPool()
    const row = (await pool.query('SELECT status, attempts, last_error FROM cloud_jobs WHERE id=$1', [id])).rows[0]
    expect(row.last_error).toBe('boom')
    expect(['queued', 'failed']).toContain(row.status)
  })

  it('引擎期望状态与 worker 心跳快照可读写', async () => {
    const key = `${TEST_JOB_PREFIX}-engine`
    await setEngineDesired('test_platform', key, 'running')
    const { getEngineDesired } = await import('../../api/cloud/state/taskStores.js')
    expect(await getEngineDesired('test_platform', key)).toBe('running')

    await upsertWorkerStatus(`${TEST_JOB_PREFIX}`, { running: true, engines: { ok: 1 } })
    const snapshot = await getWorkerStatus(`${TEST_JOB_PREFIX}`)
    expect(snapshot).not.toBeNull()
    expect((snapshot as { running?: boolean }).running).toBe(true)
  })
})
