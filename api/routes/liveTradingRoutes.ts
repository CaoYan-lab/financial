import { Router } from 'express'
import { liveTradingEngine } from '../live/liveTradingEngine.js'
import { liveCandidatePoolService } from '../live/liveCandidatePoolService.js'
import { livePersistence } from '../live/livePersistence.js'
import { liveOrderQueueService } from '../live/liveOrderQueueService.js'
import { loadLiveAccountDashboard } from '../live/liveAccountService.js'
import { loadFutuLiveOrders } from '../live/futuLiveOrderService.js'
import { requestManagedOrderCancel } from '../live/managedOrderSupervisor.js'
import { getFutuLiveSettings, updateFutuLiveSettings } from '../live/liveSettings.js'
import { listManagedOrderEvents, listManagedOrders } from '../cloud/state/managedOrderStore.js'
import { getLlmRuntimeConfig, updateLlmRuntimeConfig } from '../simulation/llmRuntimeConfigService.js'
import { getTradeStrategyRuntimeConfig, updateTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import { logger } from '../utils/logger.js'

const router = Router()

router.get('/accounts', async (_req, res, next) => {
  try {
    res.json(await loadLiveAccountDashboard())
  } catch (error) {
    next(error)
  }
})

router.get('/dashboard', async (_req, res, next) => {
  try {
    res.json(await liveTradingEngine.dashboard())
  } catch (error) {
    next(error)
  }
})

router.get('/settings', (_req, res) => {
  res.json(getFutuLiveSettings())
})

router.put('/settings', async (req, res, next) => {
  try {
    res.json(await updateFutuLiveSettings(executionSettingsPatch(req.body)))
  } catch (error) {
    next(error)
  }
})

router.post('/start', async (_req, res, next) => {
  try {
    logger.info({ event: 'live.api.start' }, 'Live trading start API requested')
    res.json(await liveTradingEngine.start())
  } catch (error) {
    next(error)
  }
})

router.post('/stop', (_req, res) => {
  logger.info({ event: 'live.api.stop' }, 'Live trading stop API requested')
  res.json(liveTradingEngine.stop())
})

router.post('/run-once', async (_req, res, next) => {
  try {
    logger.info({ event: 'live.api.run_once' }, 'Live trading run-once API requested')
    res.json(await liveTradingEngine.runOnce())
  } catch (error) {
    next(error)
  }
})

router.get('/history/signals', (req, res) => {
  const lifecycleStatus = typeof req.query.lifecycleStatus === 'string' ? req.query.lifecycleStatus.toUpperCase() : 'ALL'
  const page = livePersistence.paginateSignalLifecycle(
    Number(req.query.page),
    Number(req.query.pageSize),
    typeof req.query.direction === 'string' ? req.query.direction.toUpperCase() : 'ALL',
    lifecycleStatus === 'CANDIDATE_POOL' ? 'ALL' : lifecycleStatus,
    typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : 'ALL',
  )
  const items = page.items
    .map((signal) => {
      if (signal.side === 'HOLD') return signal
      const candidate = liveCandidatePoolService.findBySignalId(signal.id)
      if (!candidate || candidate.status === 'DISABLED_BY_MODE_SWITCH' || candidate.status === 'EXPIRED') return signal
      return {
        ...signal,
        lifecycleStatus: 'CANDIDATE_POOL' as const,
        lifecycleReason:
          candidate.status === 'PROMOTED'
            ? `已进入候选池并被组合裁决推进：${candidate.portfolioDecisionReason ?? candidate.candidateId}`
            : `已进入组合策略候选池：${candidate.candidateId}，当前状态 ${candidate.status}。`,
      }
    })
    .filter((signal) => lifecycleStatus !== 'CANDIDATE_POOL' || signal.lifecycleStatus === 'CANDIDATE_POOL')
  res.json({
    ...page,
    items,
  })
})

router.get('/history/pending-orders', (req, res) => {
  res.json(
    livePersistence.paginatePendingOrderLifecycle(
      Number(req.query.page),
      Number(req.query.pageSize),
      typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL',
      typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : 'ALL',
      typeof req.query.side === 'string' ? req.query.side.toUpperCase() : 'ALL',
    ),
  )
})

router.get('/history/candidate-pool', (req, res) => {
  const statusGroup = req.query.statusGroup === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
  res.json(livePersistence.paginateCandidatePoolHistory(Number(req.query.page), Number(req.query.pageSize), statusGroup))
})

router.get('/history/submitted-orders', (req, res) => {
  res.json(livePersistence.paginate('submitted_orders', Number(req.query.page), Number(req.query.pageSize)))
})

router.get('/history/rejected-orders', (req, res) => {
  res.json(livePersistence.paginate('rejected_orders', Number(req.query.page), Number(req.query.pageSize)))
})

router.get('/history/skipped', (req, res) => {
  res.json(livePersistence.paginate('skipped', Number(req.query.page), Number(req.query.pageSize)))
})

router.post('/pending-orders/:id/reject', (req, res) => {
  const rejected = liveOrderQueueService.rejectPendingOrder(req.params.id)
  if (!rejected) {
    res.status(404).json({ ok: false, error: '未找到待确认实盘订单。' })
    return
  }
  res.json({ ok: true, order: rejected })
})

router.post('/pending-orders/batch-expire', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : undefined
  const expired = liveOrderQueueService.expirePendingOrders({
    ids,
    ticker: typeof req.body?.ticker === 'string' ? req.body.ticker : undefined,
    side: typeof req.body?.side === 'string' ? req.body.side : undefined,
  })
  logger.info(
    {
      event: 'live.api.pending_orders.batch_expire',
      expiredCount: expired.length,
      ticker: typeof req.body?.ticker === 'string' ? req.body.ticker : undefined,
      side: typeof req.body?.side === 'string' ? req.body.side : undefined,
      idsCount: ids?.length,
    },
    'Live pending orders batch expired',
  )
  res.json({ ok: true, expiredCount: expired.length, orders: expired })
})

router.post('/pending-orders/:id/confirm', async (req, res, next) => {
  try {
    const result = await liveOrderQueueService.confirmPendingOrder(req.params.id, {
      confirmationId: typeof req.body?.confirmationId === 'string' && req.body.confirmationId ? req.body.confirmationId : `CONF-${Date.now()}`,
      confirmedBy: 'user',
    })
    res.status(result.ok ? 200 : result.blockedByGate ? 403 : result.order ? 400 : 404).json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/futu-orders', async (req, res, next) => {
  try {
    const account = await loadLiveAccountDashboard()
    res.json(
      await loadFutuLiveOrders({
        accountId: account.selectedAccountId,
        page: Number(req.query.page),
        pageSize: Number(req.query.pageSize),
        startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
        endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
        ticker: typeof req.query.ticker === 'string' ? req.query.ticker : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        side: typeof req.query.side === 'string' ? req.query.side : undefined,
      }),
    )
  } catch (error) {
    next(error)
  }
})

router.get('/managed-orders', async (_req, res, next) => {
  try {
    const [orders, events] = await Promise.all([
      listManagedOrders('futu'),
      listManagedOrderEvents('futu', undefined, 100),
    ])
    res.json({ ok: true, orders, events })
  } catch (error) {
    next(error)
  }
})

router.post('/futu-orders/:orderId/cancel', async (req, res, next) => {
  try {
    const result = await requestManagedOrderCancel({
      platform: 'futu',
      orderId: req.params.orderId,
      requestId:
        typeof req.body?.cancelRequestId === 'string'
          ? req.body.cancelRequestId
          : undefined,
      source: 'manual',
      reason:
        typeof req.body?.reason === 'string'
          ? req.body.reason
          : '用户手工撤单',
    })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/llm-config', (_req, res) => {
  res.json(getLlmRuntimeConfig())
})

router.put('/llm-config', (req, res) => {
  const concurrency = Number(req.body?.concurrency)
  logger.info(
    {
      event: 'live.api.llm_config_update',
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      disableUsOvernightLlm: typeof req.body?.disableUsOvernightLlm === 'boolean' ? req.body.disableUsOvernightLlm : undefined,
    },
    'Live LLM config update requested',
  )
  res.json(
    updateLlmRuntimeConfig({
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      disableUsOvernightLlm: typeof req.body?.disableUsOvernightLlm === 'boolean' ? req.body.disableUsOvernightLlm : undefined,
    }),
  )
})

router.get('/trade-strategy-config', (_req, res) => {
  res.json(getTradeStrategyRuntimeConfig('live'))
})

router.put('/trade-strategy-config', (req, res, next) => {
  try {
    const next = updateTradeStrategyRuntimeConfig('live', {
      strategyId: typeof req.body?.strategyId === 'string' ? req.body.strategyId : undefined,
      promptPackId: typeof req.body?.promptPackId === 'string' ? req.body.promptPackId : undefined,
      executionMode: req.body?.executionMode === 'candidate_pool' || req.body?.executionMode === 'legacy_direct' ? req.body.executionMode : undefined,
      portfolioTimingPresetId: typeof req.body?.portfolioTimingPresetId === 'string' ? req.body.portfolioTimingPresetId : undefined,
    })
    if (next.selection.executionMode === 'legacy_direct') liveCandidatePoolService.disableForModeSwitch()
    res.json(next)
  } catch (error) {
    next(error)
  }
})

export default router

function executionSettingsPatch(body: Record<string, unknown> | undefined) {
  return {
    ...(typeof body?.autoSubmitEnabled === 'boolean'
      ? { autoSubmitEnabled: body.autoSubmitEnabled }
      : {}),
    ...(typeof body?.autoCancelEnabled === 'boolean'
      ? { autoCancelEnabled: body.autoCancelEnabled }
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
