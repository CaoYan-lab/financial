import { Router } from 'express'
import { loadLongbridgeLiveTradingConfig, loadLongbridgeSourceStatus, loadLongbridgeWorkbenchDashboard, updateLongbridgeLlmConfig, updateLongbridgeTradeStrategyConfig } from '../longbridge/longbridgeAdapter.js'
import { longbridgeLiveTradingEngine } from '../longbridge/longbridgeLiveTradingEngine.js'
import { ensureLongbridgeRealtimeSubscriptions, getLongbridgeRealtimeSubscriptionStatus, loadLongbridgeRealtimeStrategyMarketData } from '../longbridge/longbridgeRealtimeDataAdapter.js'
import { ensureLongbridgeEstimatedFees } from '../longbridge/longbridgeFeeService.js'
import { longbridgeOrderQueueService } from '../longbridge/longbridgeOrderQueueService.js'
import { longbridgePersistence } from '../longbridge/longbridgePersistence.js'
import { getLongbridgeLiveSettings, updateLongbridgeLiveSettings } from '../longbridge/longbridgeLiveSettings.js'
import { repairUnavailableTrendSignals } from '../longbridge/longbridgeTrendRepairService.js'
import { listManagedOrderEvents, listManagedOrders } from '../cloud/state/managedOrderStore.js'
import { requestManagedOrderCancel } from '../live/managedOrderSupervisor.js'
import { loadLongbridgeBrokerOrders, loadLongbridgeCombinedOrderDetail } from '../longbridge/longbridgeLiveOrderService.js'
import type { LongbridgeBrokerOrderSideFilter, LongbridgeBrokerOrderStatusFilter } from '../../shared/longbridgeTypes.js'
import type { LivePendingOrderSideFilter, LivePendingOrderStatusFilter, LiveSignalDirectionFilter, LiveSignalLifecycleFilter } from '../../shared/types.js'

const router = Router()

router.get('/source/status', async (_req, res, next) => {
  try {
    res.json(await loadLongbridgeSourceStatus())
  } catch (error) {
    next(error)
  }
})

router.get('/workbench/dashboard', async (_req, res, next) => {
  try {
    res.json(await loadLongbridgeWorkbenchDashboard())
  } catch (error) {
    next(error)
  }
})

router.get('/live-trading/config', (_req, res) => {
  res.json(loadLongbridgeLiveTradingConfig())
})

router.get('/realtime/status/subscription', (_req, res) => {
  res.json(getLongbridgeRealtimeSubscriptionStatus())
})

router.post('/realtime/subscribe', async (req, res, next) => {
  try {
    const symbols = Array.isArray(req.body?.symbols)
      ? req.body.symbols.filter((symbol: unknown): symbol is string => typeof symbol === 'string')
      : typeof req.body?.symbol === 'string'
        ? [req.body.symbol]
        : ['AAPL.US']
    await ensureLongbridgeRealtimeSubscriptions(symbols, { waitForSeed: req.body?.waitForSeed !== false })
    res.json(getLongbridgeRealtimeSubscriptionStatus())
  } catch (error) {
    next(error)
  }
})

router.get('/realtime/:symbol', async (req, res, next) => {
  try {
    res.json(await loadLongbridgeRealtimeStrategyMarketData(req.params.symbol))
  } catch (error) {
    next(error)
  }
})

router.get('/live-trading/dashboard', async (_req, res, next) => {
  try {
    res.json(await longbridgeLiveTradingEngine.dashboard())
  } catch (error) {
    next(error)
  }
})

router.get('/live-trading/settings', (_req, res) => {
  res.json(getLongbridgeLiveSettings())
})

router.put('/live-trading/settings', async (req, res, next) => {
  try {
    res.json(await updateLongbridgeLiveSettings(executionSettingsPatch(req.body)))
  } catch (error) {
    next(error)
  }
})

router.post('/live-trading/start', async (_req, res, next) => {
  try {
    res.json(await longbridgeLiveTradingEngine.start())
  } catch (error) {
    next(error)
  }
})

router.post('/live-trading/stop', async (_req, res, next) => {
  try {
    res.json(await longbridgeLiveTradingEngine.stop())
  } catch (error) {
    next(error)
  }
})

router.get('/live-trading/history/signals', async (req, res, next) => {
  try {
  const direction = typeof req.query.direction === 'string' ? (req.query.direction.toUpperCase() as LiveSignalDirectionFilter) : 'ALL'
  const lifecycleStatus = typeof req.query.lifecycleStatus === 'string' ? (req.query.lifecycleStatus.toUpperCase() as LiveSignalLifecycleFilter) : 'ALL'
    const page = longbridgePersistence.paginateSignalLifecycle(
      Number(req.query.page),
      Number(req.query.pageSize),
      direction,
      lifecycleStatus,
      typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : 'ALL',
    )
    res.json(await repairUnavailableTrendSignals(page))
  } catch (error) {
    next(error)
  }
})

router.get('/live-trading/history/pending-orders', (req, res) => {
  const status = typeof req.query.status === 'string' ? (req.query.status.toUpperCase() as LivePendingOrderStatusFilter) : 'ALL'
  const side = typeof req.query.side === 'string' ? (req.query.side.toUpperCase() as LivePendingOrderSideFilter) : 'ALL'
  const page = longbridgePersistence.paginatePendingOrderLifecycle(
    Number(req.query.page),
    Number(req.query.pageSize),
    status,
    typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : 'ALL',
    side,
  )
  res.json({ ...page, items: ensureLongbridgeEstimatedFees(page.items) })
})

router.get('/live-trading/history/candidate-pool', (req, res) => {
  const statusGroup = req.query.statusGroup === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
  res.json(longbridgePersistence.paginateCandidatePoolHistory(Number(req.query.page), Number(req.query.pageSize), statusGroup))
})

router.post('/live-trading/run-once', async (req, res, next) => {
  try {
    const symbol = typeof req.body?.symbol === 'string' ? req.body.symbol : typeof req.query.symbol === 'string' ? req.query.symbol : 'AAPL.US'
    res.json(await longbridgeLiveTradingEngine.runOnceDryRun(symbol))
  } catch (error) {
    next(error)
  }
})

router.post('/live-trading/pending-orders/:id/confirm', async (req, res, next) => {
  try {
    const result = await longbridgeOrderQueueService.confirmPendingOrder(req.params.id, {
      confirmationId: typeof req.body?.confirmationId === 'string' ? req.body.confirmationId : undefined,
      confirmedBy: 'user',
    })
    res.status(result.ok ? 200 : result.blockedByGate ? 403 : 400).json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/live-trading/pending-orders/:id/reject', (req, res) => {
  const result = longbridgeOrderQueueService.rejectPendingOrder(req.params.id)
  res.status(result.ok ? 200 : 400).json(result)
})

router.post('/live-trading/pending-orders/batch-expire', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : undefined
  const expired = longbridgeOrderQueueService.expirePendingOrders({
    ids,
    ticker: typeof req.body?.ticker === 'string' ? req.body.ticker : undefined,
    side: typeof req.body?.side === 'string' ? req.body.side : undefined,
  })
  res.json({ ok: true, expiredCount: expired.length, orders: expired })
})

router.get('/live-trading/managed-orders', async (_req, res, next) => {
  try {
    const [orders, events] = await Promise.all([
      listManagedOrders('longbridge'),
      listManagedOrderEvents('longbridge', undefined, 100),
    ])
    res.json({ ok: true, orders, events })
  } catch (error) {
    next(error)
  }
})

router.get('/live-trading/orders', async (req, res, next) => {
  try {
    res.json(await loadLongbridgeBrokerOrders({
      page: Number(req.query.page),
      pageSize: Number(req.query.pageSize),
      startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
      endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
      ticker: typeof req.query.ticker === 'string' ? req.query.ticker : undefined,
      status: typeof req.query.status === 'string' ? req.query.status as LongbridgeBrokerOrderStatusFilter : undefined,
      side: typeof req.query.side === 'string' ? req.query.side as LongbridgeBrokerOrderSideFilter : undefined,
    }))
  } catch (error) {
    next(error)
  }
})

router.get('/live-trading/orders/:orderId/detail', async (req, res, next) => {
  try {
    const result = await loadLongbridgeCombinedOrderDetail({
      orderId: req.params.orderId,
      pendingOrderId: typeof req.query.pendingOrderId === 'string' ? req.query.pendingOrderId : undefined,
      submittedAt: typeof req.query.submittedAt === 'string' ? req.query.submittedAt : undefined,
    })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/live-trading/orders/:orderId/cancel', async (req, res, next) => {
  try {
    const result = await requestManagedOrderCancel({
      platform: 'longbridge',
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

router.put('/live-trading/llm-config', (req, res) => {
  const concurrency = Number(req.body?.concurrency)
  res.json(
    updateLongbridgeLlmConfig({
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      disableUsOvernightLlm: typeof req.body?.disableUsOvernightLlm === 'boolean' ? req.body.disableUsOvernightLlm : undefined,
    }),
  )
})

router.put('/live-trading/trade-strategy-config', (req, res, next) => {
  try {
    res.json(
      updateLongbridgeTradeStrategyConfig({
        strategyId: typeof req.body?.strategyId === 'string' ? req.body.strategyId : undefined,
        promptPackId: typeof req.body?.promptPackId === 'string' ? req.body.promptPackId : undefined,
        executionMode: req.body?.executionMode === 'candidate_pool' || req.body?.executionMode === 'legacy_direct' ? req.body.executionMode : undefined,
        portfolioTimingPresetId: typeof req.body?.portfolioTimingPresetId === 'string' ? req.body.portfolioTimingPresetId : undefined,
      }),
    )
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
