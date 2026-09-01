import { liveTradingEngine } from '../../live/liveTradingEngine.js'
import { simulationTradingEngine } from '../../simulation/simulationTradingEngine.js'
import { longbridgeLiveTradingEngine } from '../../longbridge/longbridgeLiveTradingEngine.js'
import { aShareLiveTradingEngine } from '../../ashare/aShareLiveTradingEngine.js'
import { logger } from '../../utils/logger.js'

export type JobResult = { ok: boolean; summary?: Record<string, unknown>; error?: string }

type EngineHandle = {
  platform: string
  start: () => Promise<unknown> | unknown
  stop: () => unknown
  runOnce?: () => Promise<unknown> | unknown
  status: () => unknown
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
      status: () => longbridgeLiveTradingEngine.dashboard(),
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

/**
 * 任务类型 → 处理函数。
 * 指令约定：`<platform>.<action>`，如 `futu_live.start`、`simulation.run_once`、`futu_live.stop`。
 */
export async function handleJob(jobType: string, payload: Record<string, unknown>): Promise<JobResult> {
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
        return { ok: true, summary: { platform, dashboard: sanitize(dashboard) } }
      }
      case 'stop': {
        const dashboard = engine.stop()
        logger.info({ event: 'cloud.worker.job.stop_done', platform }, '引擎停止指令完成')
        return { ok: true, summary: { platform, dashboard: sanitize(dashboard) } }
      }
      case 'run_once': {
        if (!engine.runOnce) return { ok: false, error: `${platform} 不支持 run_once` }
        const dashboard = await engine.runOnce()
        logger.info({ event: 'cloud.worker.job.run_once_done', platform }, '引擎单轮评估完成')
        return { ok: true, summary: { platform, dashboard: sanitize(dashboard) } }
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

/** 收集各引擎当前看板快照（worker 心跳用，大字段裁剪）。 */
export function collectEngineSnapshots(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  const registry = engines()
  for (const [key, engine] of Object.entries(registry)) {
    try {
      snapshot[key] = sanitize(engine.status())
    } catch (error) {
      snapshot[key] = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return snapshot
}

/** 快照可能含循环引用或超大字段，统一 JSON 安全化并截断。 */
function sanitize(value: unknown): unknown {
  try {
    const json = JSON.stringify(value)
    if (json.length <= 200_000) return JSON.parse(json)
    return { truncated: true, size: json.length }
  } catch {
    return { serializable: false }
  }
}
