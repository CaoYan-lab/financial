import { liveTradingEngine } from '../../live/liveTradingEngine.js'
import { simulationTradingEngine } from '../../simulation/simulationTradingEngine.js'
import { longbridgeLiveTradingEngine } from '../../longbridge/longbridgeLiveTradingEngine.js'
import { aShareLiveTradingEngine } from '../../ashare/aShareLiveTradingEngine.js'
import { FutuOpenDProvider } from '../../providers/futuOpenDProvider.js'
import { collectRawData } from '../../services/marketDataService.js'
import { logger } from '../../utils/logger.js'
import { loadLiveAccountDashboard } from '../../live/liveAccountService.js'
import {
  loadFutuLiveOrderDetail,
  loadFutuLiveOrders,
} from '../../live/futuLiveOrderService.js'
import { liveOrderQueueService } from '../../live/liveOrderQueueService.js'
import { updateFutuLiveSettings } from '../../live/liveSettings.js'
import {
  loadLongbridgeLiveAccountDashboard,
  loadLongbridgeWorkbenchDashboard,
} from '../../longbridge/longbridgeAdapter.js'
import { getLongbridgeRealtimeSubscriptionStatus } from '../../longbridge/longbridgeRealtimeDataAdapter.js'
import {
  updateLongbridgeLiveSettings,
} from '../../longbridge/longbridgeLiveSettings.js'
import { longbridgeOrderQueueService } from '../../longbridge/longbridgeOrderQueueService.js'
import {
  loadLongbridgeBrokerOrders,
  loadLongbridgeCombinedOrderDetail,
} from '../../longbridge/longbridgeLiveOrderService.js'
import type { LongbridgeBrokerOrderSideFilter, LongbridgeBrokerOrderStatusFilter } from '../../../shared/longbridgeTypes.js'
import { requestManagedOrderCancel } from '../../live/managedOrderSupervisor.js'

export type JobResult = { ok: boolean; summary?: Record<string, unknown>; error?: string }

type EngineHandle = {
  platform: string
  start: () => Promise<unknown> | unknown
  stop: () => unknown
  runOnce?: () => Promise<unknown> | unknown
  status: () => unknown | Promise<unknown>
}

/**
 * 引擎注册表：全部 import 现有引擎单例，调用其既有公开方法，零业务改动。
 * platform 命名与路由前缀、PG 表保持一致。
 */
function engines(): Record<string, EngineHandle> {
  return {
    futu_live: {
      platform: 'futu_live',
      start: () => liveTradingEngine.start(),
      stop: () => liveTradingEngine.stop(),
      runOnce: () => liveTradingEngine.runOnce(),
      status: () => liveTradingEngine.dashboard(),
    },
    simulation: {
      platform: 'simulation',
      start: () => simulationTradingEngine.start(),
      stop: () => simulationTradingEngine.stop(),
      runOnce: () => simulationTradingEngine.runOnce(),
      status: () => simulationTradingEngine.dashboard(),
    },
    longbridge_live: {
      platform: 'longbridge_live',
      start: () => longbridgeLiveTradingEngine.start(),
      stop: () => longbridgeLiveTradingEngine.stop(),
      runOnce: () => longbridgeLiveTradingEngine.runPoolOnceDryRun(),
      status: () => collectLongbridgeCloudSnapshot(),
    },
    ashare_live: {
      platform: 'ashare_live',
      // A 股 start 为同步方法，refreshSubscriptions 引导订阅
      start: () => {
        aShareLiveTradingEngine.start()
        return aShareLiveTradingEngine.refreshSubscriptions()
      },
      stop: () => aShareLiveTradingEngine.stop(),
      runOnce: () => aShareLiveTradingEngine.runOnce(),
      status: () => aShareLiveTradingEngine.dashboard(),
    },
  }
}

async function collectLongbridgeCloudSnapshot(): Promise<Record<string, unknown>> {
  const dashboard = await longbridgeLiveTradingEngine.dashboard()
  const [workbench, account] = await Promise.all([
    loadLongbridgeWorkbenchDashboard(),
    loadLongbridgeLiveAccountDashboard(),
  ])
  return {
    ...dashboard,
    sourceStatus: workbench.sourceStatus,
    account,
    workbench,
    realtime: getLongbridgeRealtimeSubscriptionStatus(),
  }
}

/**
 * 任务类型 → 处理函数。
 * 指令约定：`<platform>.<action>`，如 `futu_live.start`、`simulation.run_once`、`futu_live.stop`。
 */
export async function handleJob(jobType: string, payload: Record<string, unknown>): Promise<JobResult> {
  if (jobType === 'futu_live.cancel_order' || jobType === 'longbridge_live.cancel_order') {
    try {
      const response = await requestManagedOrderCancel({
        platform: jobType.startsWith('futu') ? 'futu' : 'longbridge',
        orderId: typeof payload.orderId === 'string' ? payload.orderId : '',
        requestId: typeof payload.cancelRequestId === 'string' ? payload.cancelRequestId : undefined,
        source: 'manual',
        reason: typeof payload.reason === 'string' ? payload.reason : '用户手工撤单',
      })
      return { ok: true, summary: { response } }
    } catch (error) {
      return {
        ok: true,
        summary: {
          response: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      }
    }
  }

  if (jobType === 'futu_live.order_detail') {
    const requestedAccountId =
      typeof payload.accountId === 'string' && payload.accountId !== 'unavailable'
        ? payload.accountId
        : undefined
    const accountId = requestedAccountId ?? (await loadLiveAccountDashboard()).selectedAccountId
    const result = await loadFutuLiveOrderDetail({
      accountId,
      orderId: typeof payload.orderId === 'string' ? payload.orderId : '',
      ticker: typeof payload.ticker === 'string' ? payload.ticker : undefined,
      submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : undefined,
    })
    return { ok: true, summary: { response: result } }
  }

  if (jobType === 'futu_live.confirm') {
    const result = await liveOrderQueueService.confirmPendingOrder(
      typeof payload.id === 'string' ? payload.id : '',
      {
        confirmationId: typeof payload.confirmationId === 'string' ? payload.confirmationId : undefined,
        confirmedBy: 'user',
      },
    )
    return { ok: true, summary: { response: result } }
  }

  if (jobType === 'futu_live.reject') {
    const order = liveOrderQueueService.rejectPendingOrder(
      typeof payload.id === 'string' ? payload.id : '',
    )
    return {
      ok: true,
      summary: {
        response: order
          ? { ok: true, order, blockedByGate: false }
          : { ok: false, error: '未找到待确认实盘订单。', blockedByGate: false },
      },
    }
  }

  if (jobType === 'futu_live.batch_expire') {
    const ids = Array.isArray(payload.ids)
      ? payload.ids.filter((id): id is string => typeof id === 'string')
      : undefined
    const orders = liveOrderQueueService.expirePendingOrders({
      ids,
      ticker: typeof payload.ticker === 'string' ? payload.ticker : undefined,
      side: typeof payload.side === 'string' ? payload.side : undefined,
    })
    return {
      ok: true,
      summary: {
        response: { ok: true, expiredCount: orders.length, orders },
      },
    }
  }

  if (jobType === 'futu_live.settings') {
    const requestedAutoSubmit = payload.autoSubmitEnabled === true
    if (
      (requestedAutoSubmit || payload.autoCancelEnabled === true)
      && (
        process.env.LIVE_TRADING_ENABLED !== 'true'
        || process.env.FUTU_LIVE_TRD_ENV !== 'REAL'
      )
    ) {
      return {
        ok: true,
        summary: {
          response: {
            ok: false,
            error: 'Futu 自动下单门禁未就绪：需要实盘门禁和 REAL 交易环境。',
            blockedByGate: true,
          },
        },
      }
    }
    const settings = await updateFutuLiveSettings(executionSettingsPatch(payload))
    return { ok: true, summary: { response: { ok: true, ...settings } } }
  }

  if (jobType === 'longbridge_live.order_detail') {
    const result = await loadLongbridgeCombinedOrderDetail({
      orderId: typeof payload.orderId === 'string' ? payload.orderId : '',
      pendingOrderId: typeof payload.pendingOrderId === 'string' ? payload.pendingOrderId : undefined,
      submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : undefined,
    })
    return { ok: true, summary: { response: result } }
  }

  if (jobType === 'longbridge_live.orders') {
    const result = await loadLongbridgeBrokerOrders({
      page: Number(payload.page),
      pageSize: Number(payload.pageSize),
      startDate: typeof payload.startDate === 'string' ? payload.startDate : undefined,
      endDate: typeof payload.endDate === 'string' ? payload.endDate : undefined,
      ticker: typeof payload.ticker === 'string' ? payload.ticker : undefined,
      status: typeof payload.status === 'string' ? payload.status as LongbridgeBrokerOrderStatusFilter : undefined,
      side: typeof payload.side === 'string' ? payload.side as LongbridgeBrokerOrderSideFilter : undefined,
    })
    return { ok: true, summary: { response: result } }
  }

  if (jobType === 'longbridge_live.confirm') {
    const id = typeof payload.id === 'string' ? payload.id : ''
    const result = await longbridgeOrderQueueService.confirmPendingOrder(id, {
      confirmationId: typeof payload.confirmationId === 'string' ? payload.confirmationId : undefined,
      confirmedBy: 'user',
    })
    return { ok: true, summary: { response: result } }
  }

  if (jobType === 'longbridge_live.reject') {
    const id = typeof payload.id === 'string' ? payload.id : ''
    const result = longbridgeOrderQueueService.rejectPendingOrder(id)
    return { ok: true, summary: { response: { ...result, blockedByGate: false } } }
  }

  if (jobType === 'longbridge_live.batch_expire') {
    const ids = Array.isArray(payload.ids)
      ? payload.ids.filter((id): id is string => typeof id === 'string')
      : undefined
    const orders = longbridgeOrderQueueService.expirePendingOrders({
      ids,
      ticker: typeof payload.ticker === 'string' ? payload.ticker : undefined,
      side: typeof payload.side === 'string' ? payload.side : undefined,
    })
    return {
      ok: true,
      summary: {
        response: { ok: true, expiredCount: orders.length, orders },
      },
    }
  }

  if (jobType === 'longbridge_live.settings') {
    const requestedAutoSubmit = payload.autoSubmitEnabled === true
    if (
      (requestedAutoSubmit || payload.autoCancelEnabled === true)
      && (
        process.env.LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true'
        || !process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim()
      )
    ) {
      return {
        ok: false,
        error: '长桥自动下单门禁未就绪：需要实盘门禁和订单专用代理。',
      }
    }
    const settings = await updateLongbridgeLiveSettings(executionSettingsPatch(payload))
    logger.info(
      { event: 'cloud.worker.longbridge_settings.updated', autoSubmitEnabled: settings.autoSubmitEnabled },
      '长桥实盘设置已更新',
    )
    return { ok: true, summary: { response: { ok: true, ...settings } } }
  }

  if (jobType === 'futu_live.orders') {
    try {
      const requestedAccountId =
        typeof payload.accountId === 'string' && payload.accountId !== 'unavailable'
          ? payload.accountId
          : undefined
      const accountId = requestedAccountId ?? (await loadLiveAccountDashboard()).selectedAccountId
      const orders = await loadFutuLiveOrders({
        accountId,
        page: Number(payload.page),
        pageSize: Number(payload.pageSize),
        startDate: typeof payload.startDate === 'string' ? payload.startDate : undefined,
        endDate: typeof payload.endDate === 'string' ? payload.endDate : undefined,
        ticker: typeof payload.ticker === 'string' ? payload.ticker : undefined,
        status: typeof payload.status === 'string' ? payload.status : undefined,
        side: typeof payload.side === 'string' ? payload.side : undefined,
      })
      logger.info({ event: 'cloud.worker.futu_orders.succeeded', accountId }, 'Futu 实盘订单查询完成')
      return { ok: true, summary: { orders } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ event: 'cloud.worker.futu_orders.failed', error: message }, 'Futu 实盘订单查询失败')
      return { ok: false, error: message }
    }
  }

  if (jobType === 'report.collect') {
    try {
      const batchId = typeof payload.batchId === 'string' ? payload.batchId : `batch-${Date.now()}`
      const provider = new FutuOpenDProvider()
      const collected = await collectRawData(
        provider,
        batchId,
        typeof payload.asOfDate === 'string' ? payload.asOfDate : undefined,
      )
      logger.info({ event: 'cloud.worker.report_data.succeeded', batchId, rowCount: collected.rawData.length }, '报告数据采集任务完成')
      return { ok: true, summary: { collected } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ event: 'cloud.worker.report_data.failed', error: message }, '报告数据采集任务失败')
      return { ok: false, error: message }
    }
  }

  const [platform, action] = jobType.split('.')
  const registry = engines()
  const engine = registry[platform]
  if (!engine) {
    return { ok: false, error: `未知平台: ${platform}` }
  }

  try {
    switch (action) {
      case 'start': {
        const dashboard = await engine.start()
        logger.info({ event: 'cloud.worker.job.start_done', platform }, '引擎启动指令完成')
        return { ok: true, summary: { platform, dashboard: sanitizeWorkerSnapshot(dashboard) } }
      }
      case 'stop': {
        const dashboard = engine.stop()
        logger.info({ event: 'cloud.worker.job.stop_done', platform }, '引擎停止指令完成')
        return { ok: true, summary: { platform, dashboard: sanitizeWorkerSnapshot(dashboard) } }
      }
      case 'run_once': {
        if (!engine.runOnce) return { ok: false, error: `${platform} 不支持 run_once` }
        const dashboard = await engine.runOnce()
        logger.info({ event: 'cloud.worker.job.run_once_done', platform }, '引擎单轮评估完成')
        return { ok: true, summary: { platform, dashboard: sanitizeWorkerSnapshot(dashboard) } }
      }
      default:
        return { ok: false, error: `未知动作: ${action}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ event: 'cloud.worker.job.failed', platform, action, error: message }, '任务执行失败')
    return { ok: false, error: message }
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function executionSettingsPatch(payload: Record<string, unknown>) {
  return {
    ...(typeof payload.autoSubmitEnabled === 'boolean'
      ? { autoSubmitEnabled: payload.autoSubmitEnabled }
      : {}),
    ...(typeof payload.autoCancelEnabled === 'boolean'
      ? { autoCancelEnabled: payload.autoCancelEnabled }
      : {}),
    ...(numberOrUndefined(payload.marketableLimitTimeoutSeconds) !== undefined
      ? { marketableLimitTimeoutSeconds: numberOrUndefined(payload.marketableLimitTimeoutSeconds) }
      : {}),
    ...(numberOrUndefined(payload.limitTimeoutSeconds) !== undefined
      ? { limitTimeoutSeconds: numberOrUndefined(payload.limitTimeoutSeconds) }
      : {}),
    ...(numberOrUndefined(payload.brokerSyncIntervalSeconds) !== undefined
      ? { brokerSyncIntervalSeconds: numberOrUndefined(payload.brokerSyncIntervalSeconds) }
      : {}),
    ...(numberOrUndefined(payload.modelReviewIntervalSeconds) !== undefined
      ? { modelReviewIntervalSeconds: numberOrUndefined(payload.modelReviewIntervalSeconds) }
      : {}),
  }
}

/** 收集各引擎当前看板快照（worker 心跳用，大字段裁剪）。各引擎 dashboard() 多为 async，需 await。 */
export async function collectEngineSnapshots(): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {}
  const registry = engines()
  for (const [key, engine] of Object.entries(registry)) {
    try {
      snapshot[key] = sanitizeWorkerSnapshot(await engine.status())
    } catch (error) {
      snapshot[key] = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return snapshot
}

/** 单引擎快照序列化大小上限（字符）。超过则递归裁剪大数组/长文本，而非丢弃整份快照。 */
const SNAPSHOT_MAX_CHARS = 200_000

/** 快照可能含循环引用或超大字段：先 JSON 安全化，超限时递归裁剪（保留账户/连接等标量字段）。 */
export function sanitizeWorkerSnapshot(value: unknown): unknown {
  let safe: unknown
  try {
    safe = JSON.parse(JSON.stringify(value))
  } catch {
    return { serializable: false }
  }
  try {
    if (JSON.stringify(safe).length <= SNAPSHOT_MAX_CHARS) return safe
    // 第一轮：裁剪大数组（保留前若干项）+ 截断超长字符串
    let trimmed = trimDeep(safe, 40, 800)
    if (JSON.stringify(trimmed).length <= SNAPSHOT_MAX_CHARS) return trimmed
    // 第二轮：更激进裁剪
    trimmed = trimDeep(safe, 8, 200)
    if (JSON.stringify(trimmed).length <= SNAPSHOT_MAX_CHARS) return trimmed
    // 极端兜底：仅保留顶层标量字段（账户/连接/开关等）
    const minimal: Record<string, unknown> = { _partial: true }
    for (const [k, v] of Object.entries(trimmed as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') minimal[k] = v
    }
    if (Object.keys(minimal).length > 1) return minimal
    return { truncated: true, size: JSON.stringify(safe).length }
  } catch {
    return { serializable: false }
  }
}

/** 递归裁剪：标量数组完整保留，对象数组只截断不混入异构标记，对象逐键递归。 */
function trimDeep(
  value: unknown,
  arrayKeep: number,
  stringMax: number,
  path: string[] = [],
): unknown {
  if (Array.isArray(value)) {
    const scalarOnly = value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))
    const preserveMarketStates = path.at(-2) === 'evaluationStatus' && path.at(-1) === 'items'
    const items = scalarOnly || preserveMarketStates ? value : value.slice(0, arrayKeep)
    return items.map((item) => trimDeep(item, arrayKeep, stringMax, path))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out[k] = v.length > stringMax ? `${v.slice(0, stringMax)}…(${v.length}字符)` : v
      } else {
        out[k] = trimDeep(v, arrayKeep, stringMax, [...path, k])
      }
    }
    return out
  }
  return value
}
