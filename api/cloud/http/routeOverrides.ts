import { Router, type NextFunction, type Request, type Response } from 'express'
import { enqueueJob, getWorkerStatus, listWorkerStatus } from '../state/taskStores.js'
import { logger } from '../../utils/logger.js'

/**
 * Web 函数对「引擎控制指令」的拦截：
 * 不在 Web 进程内直接驱动长驻引擎，而是写入 cloud_jobs，由常驻 worker 消费执行。
 * 历史读/报告读等不拦截，继续经现有路由 → bridge → PG。
 *
 * 指令映射：POST /api/<platform-prefix>/<start|stop|run-once> → job `<engine>.<action>`
 */

// 路由前缀 → worker 任务平台名
const PLATFORM_MAP: Array<{ prefix: string; engine: string }> = [
  { prefix: '/api/live-trading', engine: 'futu_live' },
  { prefix: '/api/simulation', engine: 'simulation' },
  { prefix: '/api/longbridge/live-trading', engine: 'longbridge_live' },
  { prefix: '/api/a-share/live-trading', engine: 'ashare_live' },
]

const ACTION_MAP: Record<string, string> = {
  start: 'start',
  stop: 'stop',
  'run-once': 'run_once',
}

function matchPlatform(path: string): { engine: string; action: string } | null {
  for (const { prefix, engine } of PLATFORM_MAP) {
    for (const [suffix, action] of Object.entries(ACTION_MAP)) {
      if (path === `${prefix}/${suffix}`) return { engine, action }
    }
  }
  return null
}

export function createRouteOverrideRouter(): Router {
  const router = Router()

  // worker 心跳快照：Web 侧只读展示
  router.get('/cloud/worker-status', async (_req: Request, res: Response) => {
    try {
      const workers = await listWorkerStatus()
      res.json({ success: true, workers })
    } catch (error) {
      res.status(503).json({ success: false, error: 'worker 状态暂不可用', workers: [] })
    }
  })

  router.get('/cloud/worker-status/:platform', async (req: Request, res: Response) => {
    try {
      const snapshot = await getWorkerStatus(req.params.platform)
      res.json({ success: true, platform: req.params.platform, snapshot })
    } catch {
      res.status(503).json({ success: false, error: 'worker 状态暂不可用' })
    }
  })

  // 引擎控制指令入队（start/stop/run-once）；非拦截路径 next() 交给兜底 app
  router.post('*', async (req: Request, res: Response, next: NextFunction) => {
    const match = matchPlatform(req.path)
    if (!match) {
      next()
      return
    }
    const jobType = `${match.engine}.${match.action}`
    try {
      const jobId = await enqueueJob(jobType, { requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null })
      logger.info({ event: 'cloud.web.job.enqueued', jobType, jobId }, '引擎指令已入队')
      res.status(202).json({
        success: true,
        enqueued: true,
        jobId,
        jobType,
        message: '指令已提交，由常驻 worker 异步执行',
      })
    } catch (error) {
      logger.error({ event: 'cloud.web.job.enqueue_failed', jobType, error: error instanceof Error ? error.message : String(error) }, '指令入队失败')
      res.status(500).json({ success: false, error: '指令入队失败' })
    }
  })

  return router
}
