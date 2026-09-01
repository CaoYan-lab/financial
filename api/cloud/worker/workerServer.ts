/**
 * 云端常驻 Worker 入口（veFaaS 常驻函数 / Linux 降级宿主）。
 *
 * 职责：
 * - 起一个最小 HTTP Server（监听 0.0.0.0:$PORT，默认 8000）提供健康/状态端点，
 *   满足 veFaaS Webserver 模式端口要求；
 * - 后台轮询 cloud_jobs（FOR UPDATE SKIP LOCKED），把引擎指令交给现有引擎单例执行；
 * - 周期性把引擎看板快照 + 心跳写入 cloud_worker_status，供 Web 函数只读；
 * - 依据 cloud_engine_state 的 desired 状态做引擎自愈（重启后恢复运行中引擎）。
 *
 * 不直接对外承接业务请求；业务读写仍由 Web 函数负责。全部引擎逻辑复用现有单例，零改动。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { closePool } from '../db/pgClient.js'
import { logger } from '../../utils/logger.js'
import { claimNextJob, completeJob, failJob, getEngineDesired, upsertWorkerStatus } from '../state/taskStores.js'
import { collectEngineSnapshots, handleJob } from '../jobs/jobHandlers.js'

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}-${randomUUID().slice(0, 8)}`
const PORT = Number(process.env.PORT || 8000)
const JOB_POLL_INTERVAL_MS = Number(process.env.WORKER_JOB_POLL_MS || 5_000)
const HEARTBEAT_INTERVAL_MS = Number(process.env.WORKER_HEARTBEAT_MS || 15_000)

let startedAt = new Date().toISOString()
let lastJobAt: string | null = null
let running = true
let processing = false

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function buildStatus() {
  return {
    role: 'worker',
    workerId: WORKER_ID,
    startedAt,
    lastJobAt,
    processing,
    now: new Date().toISOString(),
  }
}

async function processOneJob(): Promise<boolean> {
  if (processing) return false
  const job = await claimNextJob(WORKER_ID)
  if (!job) return false
  processing = true
  lastJobAt = new Date().toISOString()
  logger.info({ event: 'cloud.worker.job.claimed', jobId: job.id, jobType: job.jobType, workerId: WORKER_ID }, '认领任务')
  try {
    const result = await handleJob(job.jobType, job.payload)
    if (result.ok) {
      await completeJob(job.id, { ok: true, ...(result.summary ?? {}) })
      logger.info({ event: 'cloud.worker.job.succeeded', jobId: job.id, jobType: job.jobType }, '任务成功')
    } else {
      await failJob(job.id, result.error || '任务失败')
      logger.error({ event: 'cloud.worker.job.failed', jobId: job.id, jobType: job.jobType, error: result.error }, '任务失败')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failJob(job.id, message)
    logger.error({ event: 'cloud.worker.job.error', jobId: job.id, error: message }, '任务异常')
  } finally {
    processing = false
  }
  return true
}

async function heartbeat(): Promise<void> {
  try {
    const engines = collectEngineSnapshots()
    await upsertWorkerStatus('primary', { ...buildStatus(), engines })
  } catch (error) {
    logger.error({ event: 'cloud.worker.heartbeat.failed', error: error instanceof Error ? error.message : String(error) }, '心跳写入失败')
  }
}

/**
 * 自愈：按 cloud_engine_state 中 desired=running 的引擎，确保其处于运行态。
 * 仅在 worker 启动时执行一次（引擎内部自有定时循环），避免重复 start。
 */
async function reconcileDesiredState(): Promise<void> {
  const platforms = ['futu_live', 'simulation', 'longbridge_live', 'ashare_live']
  for (const platform of platforms) {
    try {
      const desired = await getEngineDesired(platform, 'primary')
      if (desired === 'running') {
        logger.info({ event: 'cloud.worker.reconcile', platform }, '按期望状态恢复引擎')
        await handleJob(`${platform}.start`, {})
      }
    } catch (error) {
      logger.error({ event: 'cloud.worker.reconcile.failed', platform, error: error instanceof Error ? error.message : String(error) }, '引擎自愈失败')
    }
  }
}

function startJobLoop(): void {
  const tick = async () => {
    if (!running) return
    try {
      // 一轮尽量排空队列（连续处理），但单次最多 10 个，避免独占
      let processed = 0
      while (running && processed < 10) {
        const did = await processOneJob()
        if (!did) break
        processed += 1
      }
    } catch (error) {
      logger.error({ event: 'cloud.worker.loop.error', error: error instanceof Error ? error.message : String(error) }, '任务循环异常')
    }
    setTimeout(tick, JOB_POLL_INTERVAL_MS)
  }
  setTimeout(tick, JOB_POLL_INTERVAL_MS)
}

function startHeartbeatLoop(): void {
  const beat = async () => {
    if (!running) return
    await heartbeat()
    setTimeout(beat, HEARTBEAT_INTERVAL_MS)
  }
  setTimeout(beat, 2_000)
}

export function createWorkerServer(): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    if (url.startsWith('/health') || url === '/') {
      writeJson(res, 200, { ok: true, ...buildStatus() })
      return
    }
    if (url.startsWith('/status')) {
      writeJson(res, 200, { ok: true, ...buildStatus() })
      return
    }
    writeJson(res, 404, { ok: false, error: 'not found' })
  })
  return server
}

async function bootstrap(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.error({ event: 'cloud.worker.no_database_url' }, 'DATABASE_URL 未配置，worker 无法运行')
    process.exit(1)
  }
  const server = createWorkerServer()
  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ event: 'cloud.worker.started', port: PORT, workerId: WORKER_ID }, 'Cloud worker ready')
  })

  await reconcileDesiredState().catch(() => undefined)
  startJobLoop()
  startHeartbeatLoop()

  const shutdown = (signal: string): void => {
    running = false
    logger.info({ event: 'cloud.worker.shutdown', signal }, 'Worker shutting down')
    server.close(() => {
      void closePool().finally(() => process.exit(0))
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

if (process.env.NODE_ENV !== 'test') {
  void bootstrap()
}

// 导出供测试使用
export { bootstrap, heartbeat, processOneJob, startJobLoop, WORKER_ID }
export const _internals = { resetStartedAt: () => { startedAt = new Date().toISOString() } }
