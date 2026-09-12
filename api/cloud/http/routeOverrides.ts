import { Router, type NextFunction, type Request, type Response } from 'express'
import { generateReport, type ReportCollectedData } from '../../routes/reportRoutes.js'
import { enqueueJob, getJob, getWorkerStatus, listWorkerStatus, setEngineDesired } from '../state/taskStores.js'
import { listManagedOrderEvents, listManagedOrders } from '../state/managedOrderStore.js'
import { loadBrokerExecutionSettings } from '../state/brokerExecutionSettingsStore.js'
import { logger } from '../../utils/logger.js'
import type { BrokerExecutionSettings, ManagedBroker } from '../../../shared/managedOrderTypes.js'

// 引擎看板只读取常驻 worker 的 leader 心跳行（仅持有咨询锁的唯一 leader 会写该行），
// 旧版本/非 leader 实例写的 'primary' 行会被忽略，避免被空闲/历史实例的空快照覆盖。
const LEADER_STATUS_KEY = 'leader'
const REPORT_JOB_TIMEOUT_MS = 330_000
const REPORT_JOB_POLL_MS = 1_000
const FUTU_ORDERS_JOB_TIMEOUT_MS = 25_000
const FUTU_ORDERS_JOB_POLL_MS = 250
const CONTROL_JOB_TIMEOUT_MS = 15_000
const ORDER_JOB_TIMEOUT_MS = 45_000
const ORDER_READ_JOB_TIMEOUT_MS = 35_000
const CONTROL_JOB_POLL_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Web 函数对「引擎控制指令」的拦截：
 * 不在 Web 进程内直接驱动长驻引擎，而是写入 cloud_jobs，由常驻 worker 消费执行。
 * 历史读/报告读等不拦截，继续经现有路由 → bridge → PG。
 *
 * 指令映射：POST /api/<platform-prefix>/<start|stop|run-once> → job `<engine>.<action>`
 */

// 路由前缀（router 挂载在 '/api' 下，内部 req.path 为去掉 /api 的相对路径；
// 兼容调用方传入完整 /api 路径）→ worker 任务平台名
const PLATFORM_MAP: Array<{ prefix: string; engine: string }> = [
  { prefix: '/live-trading', engine: 'futu_live' },
  { prefix: '/simulation', engine: 'simulation' },
  { prefix: '/longbridge/live-trading', engine: 'longbridge_live' },
  { prefix: '/a-share/live-trading', engine: 'ashare_live' },
]

const ACTION_MAP: Record<string, string> = {
  start: 'start',
  stop: 'stop',
  'run-once': 'run_once',
}

function matchPlatform(rawPath: string): { engine: string; action: string } | null {
  // 挂载在 /api 下时 req.path 不含 /api；若调用方给出完整路径则剥掉前缀
  const path = rawPath.startsWith('/api/') ? rawPath.slice(4) : rawPath
  for (const { prefix, engine } of PLATFORM_MAP) {
    for (const [suffix, action] of Object.entries(ACTION_MAP)) {
      if (path === `${prefix}/${suffix}`) return { engine, action }
    }
  }
  return null
}

type SnapshotRecord = Record<string, unknown>
type SnapshotProjector = (snapshot: SnapshotRecord) => unknown

function asRecord(value: unknown): SnapshotRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SnapshotRecord
    : undefined
}

function futuSourceStatus(snapshot: SnapshotRecord): SnapshotRecord | undefined {
  const account = asRecord(snapshot.account)
  if (!account) return undefined
  const summary = asRecord(account.summary)
  const source = asRecord(summary?.source)
  const available = account.ok === true
  const missingCapabilities = Array.isArray(account.missingCapabilities)
    ? account.missingCapabilities
    : []

  return {
    futuOpenDAvailable: available,
    futuPythonSdkAvailable: available,
    futuOpenDLoggedIn: available,
    optionsDataAvailable: available,
    technicalDataAvailable: available,
    universePrimaryAvailable: true,
    universeFallbackAvailable: true,
    lastCheckedAt: source?.timestamp ?? source?.accessedAt ?? new Date().toISOString(),
    missingCapabilities,
  }
}

function executionSettingsPayload(body: Record<string, unknown> | undefined) {
  return {
    ...(typeof body?.autoSubmitEnabled === 'boolean'
      ? { autoSubmitEnabled: body.autoSubmitEnabled }
      : {}),
    ...(typeof body?.autoCancelEnabled === 'boolean'
      ? { autoCancelEnabled: body.autoCancelEnabled }
      : {}),
    ...(typeof body?.blockOpeningWhenCashNegative === 'boolean'
      ? { blockOpeningWhenCashNegative: body.blockOpeningWhenCashNegative }
      : {}),
    ...(typeof body?.marketableLimitTimeoutSeconds === 'number'
      ? { marketableLimitTimeoutSeconds: body.marketableLimitTimeoutSeconds }
      : {}),
    ...(typeof body?.limitTimeoutSeconds === 'number'
      ? { limitTimeoutSeconds: body.limitTimeoutSeconds }
      : {}),
    ...(typeof body?.brokerSyncIntervalSeconds === 'number'
      ? { brokerSyncIntervalSeconds: body.brokerSyncIntervalSeconds }
      : {}),
    ...(typeof body?.modelReviewIntervalSeconds === 'number'
      ? { modelReviewIntervalSeconds: body.modelReviewIntervalSeconds }
      : {}),
  }
}

// 从常驻 worker 心跳快照读取指定引擎看板。云端 web 不允许回退为本进程直连 OpenD，
// 否则会一直等待到 bridge 超时，并把已有的 worker 快照误显示为离线。
async function serveEngineSnapshot(
  res: Response,
  engine: string,
  project: SnapshotProjector = (snapshot) => snapshot,
): Promise<void> {
  try {
    const status = await getWorkerStatus(LEADER_STATUS_KEY)
    const engines = (status?.engines ?? {}) as Record<string, unknown>
    const snapshot = asRecord(engines[engine])
    if (snapshot && Object.keys(snapshot).length > 0) {
      const payload = project(snapshot)
      if (payload !== undefined && payload !== null) {
        res.json(payload)
        return
      }
    }
    res.status(503).json({
      success: false,
      error: '常驻 worker 快照暂不可用',
    })
  } catch (error) {
    logger.error({ event: 'cloud.web.snapshot.failed', engine, error: error instanceof Error ? error.message : String(error) }, '读取 worker 快照失败')
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        error: '常驻 worker 快照暂不可用',
      })
      return
    }
  }
}

export function overlayBrokerExecutionSettings(
  snapshot: SnapshotRecord,
  settings: BrokerExecutionSettings,
): SnapshotRecord {
  return {
    ...snapshot,
    ...settings,
    updatedAt: new Date().toISOString(),
  }
}

async function serveBrokerEngineSnapshot(
  res: Response,
  engine: string,
  platform: ManagedBroker,
  project: SnapshotProjector = (snapshot) => snapshot,
): Promise<void> {
  try {
    const [status, settings] = await Promise.all([
      getWorkerStatus(LEADER_STATUS_KEY),
      loadBrokerExecutionSettings(platform),
    ])
    const engines = (status?.engines ?? {}) as Record<string, unknown>
    const snapshot = asRecord(engines[engine])
    if (snapshot && Object.keys(snapshot).length > 0) {
      const payload = project(overlayBrokerExecutionSettings(snapshot, settings))
      if (payload !== undefined && payload !== null) {
        res.json(payload)
        return
      }
    }
    res.status(503).json({
      success: false,
      error: '常驻 worker 快照暂不可用',
    })
  } catch (error) {
    logger.error(
      {
        event: 'cloud.web.broker_snapshot.failed',
        engine,
        platform,
        error: error instanceof Error ? error.message : String(error),
      },
      '读取券商快照和持久化设置失败',
    )
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        error: '券商状态暂不可用',
      })
    }
  }
}

async function forwardBrokerControlJob(
  res: Response,
  jobType: string,
  payload: Record<string, unknown>,
  timeoutMs = CONTROL_JOB_TIMEOUT_MS,
): Promise<void> {
  try {
    const jobId = await enqueueJob(jobType, payload)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const job = await getJob(jobId)
      if (job?.status === 'succeeded') {
        const response = asRecord(job.result?.response)
        if (!response) {
          res.status(500).json({ success: false, error: '券商控制任务完成但未返回结果', jobId })
          return
        }
        const status = response.ok === true ? 200 : response.blockedByGate === true ? 403 : 400
        res.status(status).json(response)
        return
      }
      if (job?.status === 'failed') {
        res.status(502).json({
          success: false,
          error: job.last_error ?? '券商控制任务执行失败',
          jobId,
        })
        return
      }
      await sleep(CONTROL_JOB_POLL_MS)
    }
    res.status(504).json({
      success: false,
      error: '券商控制任务等待超时',
      jobId,
    })
  } catch (error) {
    logger.error(
      { event: 'cloud.web.broker_control.failed', jobType, error: error instanceof Error ? error.message : String(error) },
      '券商控制任务失败',
    )
    res.status(500).json({ success: false, error: '券商控制任务失败' })
  }
}

export function createRouteOverrideRouter(): Router {
  const router = Router()

  // worker 心跳快照：Web 侧只读展示
  router.get('/cloud/worker-status', async (_req: Request, res: Response) => {
    try {
      const workers = await listWorkerStatus()
      res.json({ success: true, workers })
    } catch {
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

  // 引擎实时看板/账户：云端不直接连 OpenD，改从常驻 worker 心跳快照只读。
  // worker 快照 engines[<platform>] 即 liveTradingEngine.dashboard() 的结果。
  router.get(['/live-trading/dashboard', '/live-trading/accounts'], async (_req: Request, res: Response) => {
    return serveBrokerEngineSnapshot(res, 'futu_live', 'futu')
  })
  router.get('/live-trading/settings', async (_req: Request, res: Response) => {
    return serveBrokerEngineSnapshot(res, 'futu_live', 'futu', (snapshot) => ({
      liveTradingEnabled: snapshot.liveTradingEnabled === true,
      autoSubmitEnabled: snapshot.autoSubmitEnabled === true,
      autoCancelEnabled: snapshot.autoCancelEnabled === true,
      marketableLimitTimeoutSeconds: snapshot.marketableLimitTimeoutSeconds,
      limitTimeoutSeconds: snapshot.limitTimeoutSeconds,
      brokerSyncIntervalSeconds: snapshot.brokerSyncIntervalSeconds,
      modelReviewIntervalSeconds: snapshot.modelReviewIntervalSeconds,
      updatedAt: new Date().toISOString(),
    }))
  })
  router.put('/live-trading/settings', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'futu_live.settings', {
      ...executionSettingsPayload(req.body),
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    })
  })
  router.get('/live-trading/managed-orders', async (_req: Request, res: Response) => {
    try {
      const [orders, events, worker] = await Promise.all([
        listManagedOrders('futu'),
        listManagedOrderEvents('futu', undefined, 100),
        getWorkerStatus(LEADER_STATUS_KEY),
      ])
      res.json({ ok: true, orders, events, supervisor: worker?.managedOrders })
    } catch (error) {
      res.status(500).json({ ok: false, orders: [], events: [], error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.post('/live-trading/futu-orders/:orderId/cancel', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'futu_live.cancel_order', {
      orderId: req.params.orderId,
      cancelRequestId: typeof req.body?.cancelRequestId === 'string' ? req.body.cancelRequestId : undefined,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : '用户手工撤单',
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }, 30_000)
  })
  router.post('/live-trading/pending-orders/batch-expire', async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string')
      : undefined
    return forwardBrokerControlJob(res, 'futu_live.batch_expire', {
      ids,
      ticker: typeof req.body?.ticker === 'string' ? req.body.ticker : undefined,
      side: typeof req.body?.side === 'string' ? req.body.side : undefined,
    })
  })
  router.post('/live-trading/pending-orders/:id/confirm', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'futu_live.confirm', {
      id: req.params.id,
      confirmationId: typeof req.body?.confirmationId === 'string' ? req.body.confirmationId : undefined,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }, ORDER_JOB_TIMEOUT_MS)
  })
  router.post('/live-trading/pending-orders/:id/reject', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'futu_live.reject', {
      id: req.params.id,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    })
  })
  router.get(['/simulation/dashboard'], async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'simulation')
  })
  router.get('/longbridge/live-trading/dashboard', async (_req: Request, res: Response) => {
    return serveBrokerEngineSnapshot(res, 'longbridge_live', 'longbridge')
  })
  router.get('/longbridge/live-trading/settings', async (_req: Request, res: Response) => {
    return serveBrokerEngineSnapshot(res, 'longbridge_live', 'longbridge', (snapshot) => ({
      liveTradingEnabled: snapshot.liveTradingEnabled === true,
      autoSubmitEnabled: snapshot.autoSubmitEnabled === true,
      autoCancelEnabled: snapshot.autoCancelEnabled === true,
      blockOpeningWhenCashNegative:
        snapshot.blockOpeningWhenCashNegative !== false,
      marketableLimitTimeoutSeconds: snapshot.marketableLimitTimeoutSeconds,
      limitTimeoutSeconds: snapshot.limitTimeoutSeconds,
      brokerSyncIntervalSeconds: snapshot.brokerSyncIntervalSeconds,
      modelReviewIntervalSeconds: snapshot.modelReviewIntervalSeconds,
      updatedAt: snapshot.updatedAt,
    }))
  })
  router.get('/longbridge/live-trading/managed-orders', async (_req: Request, res: Response) => {
    try {
      const [orders, events, worker] = await Promise.all([
        listManagedOrders('longbridge'),
        listManagedOrderEvents('longbridge', undefined, 100),
        getWorkerStatus(LEADER_STATUS_KEY),
      ])
      res.json({ ok: true, orders, events, supervisor: worker?.managedOrders })
    } catch (error) {
      res.status(500).json({ ok: false, orders: [], events: [], error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.get('/longbridge/live-trading/orders', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'longbridge_live.orders', {
      page: Number(req.query.page),
      pageSize: Number(req.query.pageSize),
      startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
      endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
      ticker: typeof req.query.ticker === 'string' ? req.query.ticker : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      side: typeof req.query.side === 'string' ? req.query.side : undefined,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }, ORDER_READ_JOB_TIMEOUT_MS)
  })
  router.get('/longbridge/live-trading/orders/:orderId/detail', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'longbridge_live.order_detail', {
      orderId: req.params.orderId,
      pendingOrderId: typeof req.query.pendingOrderId === 'string' ? req.query.pendingOrderId : undefined,
      submittedAt: typeof req.query.submittedAt === 'string' ? req.query.submittedAt : undefined,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }, ORDER_READ_JOB_TIMEOUT_MS)
  })
  router.put('/longbridge/live-trading/settings', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'longbridge_live.settings', {
      ...executionSettingsPayload(req.body),
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    })
  })
  router.post('/longbridge/live-trading/orders/:orderId/cancel', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'longbridge_live.cancel_order', {
      orderId: req.params.orderId,
      cancelRequestId: typeof req.body?.cancelRequestId === 'string' ? req.body.cancelRequestId : undefined,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : '用户手工撤单',
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }, 30_000)
  })
  router.post('/longbridge/live-trading/pending-orders/batch-expire', async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string')
      : undefined
    return forwardBrokerControlJob(res, 'longbridge_live.batch_expire', {
      ids,
      ticker: typeof req.body?.ticker === 'string' ? req.body.ticker : undefined,
      side: typeof req.body?.side === 'string' ? req.body.side : undefined,
    })
  })
  router.post('/longbridge/live-trading/pending-orders/:id/confirm', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'longbridge_live.confirm', {
      id: req.params.id,
      confirmationId: typeof req.body?.confirmationId === 'string' ? req.body.confirmationId : undefined,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }, ORDER_JOB_TIMEOUT_MS)
  })
  router.post('/longbridge/live-trading/pending-orders/:id/reject', async (req: Request, res: Response) => {
    return forwardBrokerControlJob(res, 'longbridge_live.reject', {
      id: req.params.id,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    })
  })
  router.get('/longbridge/live-trading/accounts', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'longbridge_live', (snapshot) => snapshot.account)
  })
  router.get('/longbridge/source/status', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'longbridge_live', (snapshot) => snapshot.sourceStatus)
  })
  router.get('/longbridge/workbench/dashboard', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'longbridge_live', (snapshot) => snapshot.workbench)
  })
  router.get('/longbridge/realtime/status/subscription', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'longbridge_live', (snapshot) => snapshot.realtime)
  })
  router.get(['/a-share/live-trading/dashboard', '/a-share/live-trading/accounts'], async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'ashare_live')
  })

  // Futu 首页使用的是通用账户与数据源接口；在云端同样必须读取 worker 快照。
  router.get('/account/dashboard', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'futu_live', (snapshot) => snapshot.account)
  })
  router.get('/account/summary', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'futu_live', (snapshot) => asRecord(snapshot.account)?.summary)
  })
  router.get('/account/positions', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'futu_live', (snapshot) => asRecord(snapshot.account)?.positions)
  })
  router.get('/source/status', async (_req: Request, res: Response) => {
    return serveEngineSnapshot(res, 'futu_live', futuSourceStatus)
  })

  router.get('/live-trading/futu-orders/:orderId/detail', async (req: Request, res: Response) => {
    const status = await getWorkerStatus(LEADER_STATUS_KEY)
    const engines = asRecord(status?.engines)
    const futuSnapshot = asRecord(engines?.futu_live)
    const account = asRecord(futuSnapshot?.account)
    const accountId =
      typeof account?.selectedAccountId === 'string'
        ? account.selectedAccountId
        : undefined
    return forwardBrokerControlJob(res, 'futu_live.order_detail', {
      accountId,
      orderId: req.params.orderId,
      ticker: typeof req.query.ticker === 'string' ? req.query.ticker : undefined,
      submittedAt: typeof req.query.submittedAt === 'string' ? req.query.submittedAt : undefined,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }, ORDER_READ_JOB_TIMEOUT_MS)
  })

  // Futu 实盘订单必须由 VPC 内 worker 查询 OpenD。设置有限等待时间，避免前端刷新永久挂起。
  router.get('/live-trading/futu-orders', async (req: Request, res: Response) => {
    try {
      const status = await getWorkerStatus(LEADER_STATUS_KEY)
      const engines = asRecord(status?.engines)
      const futuSnapshot = asRecord(engines?.futu_live)
      const account = asRecord(futuSnapshot?.account)
      const accountId =
        typeof account?.selectedAccountId === 'string'
          ? account.selectedAccountId
          : undefined
      const payload = {
        accountId,
        page: Number(req.query.page),
        pageSize: Number(req.query.pageSize),
        startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
        endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
        ticker: typeof req.query.ticker === 'string' ? req.query.ticker : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        side: typeof req.query.side === 'string' ? req.query.side : undefined,
      }
      const jobId = await enqueueJob('futu_live.orders', payload)
      const deadline = Date.now() + FUTU_ORDERS_JOB_TIMEOUT_MS
      while (Date.now() < deadline) {
        const job = await getJob(jobId)
        if (job?.status === 'succeeded') {
          const orders = job.result?.orders
          if (orders && typeof orders === 'object') {
            res.json(orders)
            return
          }
          res.status(500).json({ success: false, error: '实盘订单查询完成但未返回内容', jobId })
          return
        }
        if (job?.status === 'failed') {
          res.status(502).json({ success: false, error: job.last_error ?? '实盘订单查询失败', jobId })
          return
        }
        await sleep(FUTU_ORDERS_JOB_POLL_MS)
      }
      res.status(504).json({ success: false, error: '实盘订单查询超时', jobId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ event: 'cloud.web.futu_orders.failed', error: message }, 'Futu 实盘订单查询失败')
      res.status(500).json({ success: false, error: '实盘订单查询失败' })
    }
  })

  // Futu 原始数据由 VPC 内 worker 采集；市场资讯与 Ark 长请求由有公网出口的 web 执行。
  // Web 保持原同步响应契约，最终返回完整报告 JSON。
  router.post('/report/generate', async (req: Request, res: Response) => {
    const batchId = `batch-${Date.now()}`
    const reportWindowDays: 30 | 60 = req.body?.reportWindowDays === 60 ? 60 : 30
    const payload = {
      batchId,
      asOfDate: typeof req.body?.asOfDate === 'string' ? req.body.asOfDate : undefined,
      reportWindowDays,
      requestedBy: (req as Request & { user?: { username?: string } }).user?.username ?? null,
    }
    try {
      const jobId = await enqueueJob('report.collect', payload)
      logger.info({ event: 'cloud.web.report_data.enqueued', jobId, batchId }, '报告数据采集任务已入队')
      const deadline = Date.now() + REPORT_JOB_TIMEOUT_MS
      while (Date.now() < deadline) {
        const job = await getJob(jobId)
        if (job?.status === 'succeeded') {
          const collected = job.result?.collected
          if (collected && typeof collected === 'object') {
            const report = await generateReport(payload, collected as ReportCollectedData)
            res.json(report)
            return
          }
          res.status(500).json({ success: false, error: '报告数据采集完成但未返回内容', jobId })
          return
        }
        if (job?.status === 'failed') {
          res.status(500).json({ success: false, error: job.last_error ?? '报告生成失败', jobId })
          return
        }
        await sleep(REPORT_JOB_POLL_MS)
      }
      res.status(504).json({ success: false, error: '报告生成超时，任务仍在后台执行', jobId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ event: 'cloud.web.report.failed', error: message }, '报告生成任务失败')
      res.status(message.startsWith('report_generation_in_progress:') ? 409 : 500).json({
        success: false,
        error: message,
      })
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
      // 记录引擎期望状态，供常驻 leader 启动/重启后自愈（start→running，stop→stopped）
      if (match.action === 'start' || match.action === 'stop') {
        await setEngineDesired(match.engine, 'primary', match.action === 'start' ? 'running' : 'stopped')
      }
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
