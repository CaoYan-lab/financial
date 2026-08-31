import { Router } from 'express'
import { aShareLiveTradingEngine } from '../ashare/aShareLiveTradingEngine.js'
import { lookupAshareInstrument } from '../ashare/aShareInstrumentLookupService.js'
import { aSharePersistence } from '../ashare/aSharePersistence.js'
import { getAshareLiveTradingConfig, updateAshareLlmRuntimeConfig, updateAshareTradeStrategyConfig, updateAshareTradingAgentLlmConfig } from '../ashare/aShareRuntimeConfigService.js'
import { aShareOrderQueueService } from '../ashare/aShareOrderQueueService.js'
import { runAshareTradingAgentMockRun } from '../ashare/aShareTradingAgentMockRunService.js'
import { addAshareUniverseItem, getAshareUniverse, removeAshareUniverseItem } from '../ashare/aShareUniverseService.js'
import type { AShareInstrumentLookupCandidate } from '../ashare/types.js'
import { logger } from '../utils/logger.js'

const router = Router()

router.get('/dashboard', async (_req, res, next) => {
  try {
    res.json(await aShareLiveTradingEngine.dashboardWithAccount())
  } catch (error) {
    next(error)
  }
})

router.get('/config', (_req, res) => {
  res.json(getAshareLiveTradingConfig())
})

router.put('/llm-config', (req, res) => {
  const concurrency = Number(req.body?.concurrency)
  res.json(
    updateAshareLlmRuntimeConfig({
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      disableUsOvernightLlm: typeof req.body?.disableUsOvernightLlm === 'boolean' ? req.body.disableUsOvernightLlm : undefined,
    }),
  )
})

router.put('/trade-strategy-config', (req, res, next) => {
  try {
    res.json(
      updateAshareTradeStrategyConfig({
        strategyId: typeof req.body?.strategyId === 'string' ? req.body.strategyId : undefined,
        promptPackId: typeof req.body?.promptPackId === 'string' ? req.body.promptPackId : undefined,
        executionMode: req.body?.executionMode === 'candidate_pool' || req.body?.executionMode === 'legacy_direct' || req.body?.executionMode === 'trading_agent' ? req.body.executionMode : undefined,
        portfolioTimingPresetId: typeof req.body?.portfolioTimingPresetId === 'string' ? req.body.portfolioTimingPresetId : undefined,
      }),
    )
  } catch (error) {
    next(error)
  }
})

router.put('/trading-agent-llm-config', (req, res, next) => {
  try {
    const maxDebateRounds = Number(req.body?.maxDebateRounds)
    const maxRiskRounds = Number(req.body?.maxRiskRounds)
    res.json(
      updateAshareTradingAgentLlmConfig({
        presetId: typeof req.body?.presetId === 'string' ? req.body.presetId : undefined,
        maxDebateRounds: Number.isFinite(maxDebateRounds) ? maxDebateRounds : undefined,
        maxRiskRounds: Number.isFinite(maxRiskRounds) ? maxRiskRounds : undefined,
        outputLanguage: typeof req.body?.outputLanguage === 'string' ? req.body.outputLanguage : undefined,
      }),
    )
  } catch (error) {
    next(error)
  }
})

router.post('/instruments/lookup', async (req, res, next) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query : ''
    const result = await lookupAshareInstrument(query)
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/universe', (_req, res) => {
  res.json(getAshareUniverse())
})

router.post('/universe', (req, res) => {
  const candidate = req.body as Partial<AShareInstrumentLookupCandidate>
  if (!isAshareCandidate(candidate)) {
    res.status(400).json({ ok: false, universe: getAshareUniverse().universe, error: '无效的 A 股订阅标的。', updatedAt: new Date().toISOString() })
    return
  }
  const result = addAshareUniverseItem(candidate)
  aShareLiveTradingEngine.refreshSubscriptions()
  logger.info({ event: 'ashare.universe.add', ticker: candidate.ticker }, 'A-share universe item added')
  res.json(result)
})

router.delete('/universe/:ticker', (req, res) => {
  const result = removeAshareUniverseItem(req.params.ticker)
  aShareLiveTradingEngine.refreshSubscriptions()
  res.json(result)
})

router.post('/start', async (_req, res, next) => {
  try {
    logger.info({ event: 'ashare.api.start' }, 'A-share engine start requested')
    aShareLiveTradingEngine.start()
    res.json(await aShareLiveTradingEngine.dashboardWithAccount())
  } catch (error) {
    next(error)
  }
})

router.post('/stop', async (_req, res, next) => {
  try {
    logger.info({ event: 'ashare.api.stop' }, 'A-share engine stop requested')
    aShareLiveTradingEngine.stop()
    res.json(await aShareLiveTradingEngine.dashboardWithAccount())
  } catch (error) {
    next(error)
  }
})

router.post('/run-once', async (_req, res, next) => {
  try {
    logger.info({ event: 'ashare.api.run_once' }, 'A-share engine run-once requested')
    res.json(await aShareLiveTradingEngine.runOnce())
  } catch (error) {
    next(error)
  }
})

router.post('/trading-agent/mock-run', async (req, res, next) => {
  try {
    logger.info({ event: 'ashare.api.trading_agent_mock_run', ticker: req.body?.ticker }, 'A-share Trading Agent mock run requested')
    res.json(await runAshareTradingAgentMockRun({
      ticker: typeof req.body?.ticker === 'string' ? req.body.ticker : undefined,
      futuCode: typeof req.body?.futuCode === 'string' ? req.body.futuCode : undefined,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      price: Number.isFinite(Number(req.body?.price)) ? Number(req.body.price) : undefined,
    }))
  } catch (error) {
    next(error)
  }
})

router.get('/history/signals', (req, res) => {
  res.json(
    aSharePersistence.paginateSignals(
      Number(req.query.page),
      Number(req.query.pageSize),
      typeof req.query.direction === 'string' ? req.query.direction.toUpperCase() : 'ALL',
      typeof req.query.lifecycleStatus === 'string' ? req.query.lifecycleStatus.toUpperCase() : 'ALL',
      typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : 'ALL',
    ),
  )
})

router.get('/history/pending-orders', (req, res) => {
  res.json(
    aSharePersistence.paginatePendingOrders(
      Number(req.query.page),
      Number(req.query.pageSize),
      typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL',
      typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : 'ALL',
      typeof req.query.side === 'string' ? req.query.side.toUpperCase() : 'ALL',
    ),
  )
})

router.post('/pending-orders/:id/reject', (req, res) => {
  const rejected = aShareOrderQueueService.rejectPendingOrder(req.params.id)
  if (!rejected) {
    res.status(404).json({ ok: false, error: '未找到可拒绝的 A 股待确认订单。' })
    return
  }
  res.json({ ok: true, order: rejected })
})

router.post('/pending-orders/:id/confirm', async (req, res, next) => {
  try {
    const result = await aShareOrderQueueService.confirmPendingOrder(req.params.id, {
      confirmationId: typeof req.body?.confirmationId === 'string' && req.body.confirmationId ? req.body.confirmationId : `ASHARE-CONF-${Date.now()}`,
      confirmedBy: 'user',
    })
    res.status(result.ok ? 200 : result.blockedByGate ? 403 : result.order ? 400 : 404).json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/history/candidate-pool', (req, res) => {
  res.json(aSharePersistence.paginateCandidatePool(Number(req.query.page), Number(req.query.pageSize), typeof req.query.statusGroup === 'string' ? req.query.statusGroup.toUpperCase() : 'ACTIVE'))
})

router.get('/history/agent-runs', (req, res) => {
  res.json(aSharePersistence.paginateAgentRuns(Number(req.query.page), Number(req.query.pageSize)))
})

export default router

function isAshareCandidate(input: Partial<AShareInstrumentLookupCandidate>): input is AShareInstrumentLookupCandidate {
  return (
    typeof input.ticker === 'string' &&
    typeof input.futuCode === 'string' &&
    typeof input.name === 'string' &&
    input.market === 'CN' &&
    (input.exchange === 'SH' || input.exchange === 'SZ') &&
    input.tradingCurrency === 'CNY' &&
    (input.assetType === 'STOCK' || input.assetType === 'ETF') &&
    /^(SH|SZ)\.\d{6}$/.test(input.ticker.toUpperCase()) &&
    /^(SH|SZ)\.\d{6}$/.test(input.futuCode.toUpperCase())
  )
}
