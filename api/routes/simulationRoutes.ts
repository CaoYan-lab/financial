import { Router } from 'express'
import { requestTradingDecision } from '../simulation/llmTradingDecisionService.js'
import { loadSimulationAccountDashboard } from '../simulation/simulationAccountService.js'
import { simulationPersistence } from '../simulation/simulationPersistence.js'
import { simulationTradingEngine } from '../simulation/simulationTradingEngine.js'
import { LLM_SIMULATION_UNIVERSE } from '../simulation/simulationUniverse.js'
import { loadFutuSimulationOrders } from '../simulation/futuSimulationOrderService.js'
import { getLlmRuntimeConfig, updateLlmRuntimeConfig } from '../simulation/llmRuntimeConfigService.js'
import { getTradeStrategyRuntimeConfig, updateTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import { logger } from '../utils/logger.js'
import type { FutuSimulationOrder, SimulatedOrderResult, SimulationLinkedOrderDetailResponse } from '../../shared/types.js'

const router = Router()

router.get('/accounts', async (_req, res, next) => {
  try {
    res.json(await loadSimulationAccountDashboard())
  } catch (error) {
    next(error)
  }
})

router.get('/dashboard', async (_req, res, next) => {
  try {
    res.json(await simulationTradingEngine.dashboard())
  } catch (error) {
    next(error)
  }
})

router.post('/start', async (_req, res, next) => {
  try {
    logger.info({ event: 'simulation.api.start' }, 'Simulation start API requested')
    res.json(await simulationTradingEngine.start())
  } catch (error) {
    next(error)
  }
})

router.post('/stop', (_req, res) => {
  logger.info({ event: 'simulation.api.stop' }, 'Simulation stop API requested')
  res.json(simulationTradingEngine.stop())
})

router.post('/run-once', async (_req, res, next) => {
  try {
    logger.info({ event: 'simulation.api.run_once' }, 'Simulation run-once API requested')
    res.json(await simulationTradingEngine.runOnce())
  } catch (error) {
    next(error)
  }
})

router.get('/signals', async (_req, res, next) => {
  try {
    const dashboard = await simulationTradingEngine.dashboard()
    res.json(dashboard.latestSignals)
  } catch (error) {
    next(error)
  }
})

router.get('/orders', async (_req, res, next) => {
  try {
    const dashboard = await simulationTradingEngine.dashboard()
    res.json(dashboard.latestOrders)
  } catch (error) {
    next(error)
  }
})

router.get('/history/signals', (req, res) => {
  res.json(simulationPersistence.paginate('signals', Number(req.query.page), Number(req.query.pageSize)))
})

router.get('/history/orders', (req, res) => {
  res.json(simulationPersistence.paginate('orders', Number(req.query.page), Number(req.query.pageSize)))
})

router.get('/history/orders/:historyId/detail', async (req, res, next) => {
  try {
    const historyOrder = simulationPersistence.getOrderByHistoryId(Number(req.params.historyId))
    if (!historyOrder) {
      res.status(404).json({ ok: false, source: 'history-order', warnings: ['未找到该历史模拟订单。'] } satisfies SimulationLinkedOrderDetailResponse)
      return
    }

    const warnings: string[] = []
    const signal = findSignalForOrder(historyOrder, warnings)
    const futuOrder = await findFutuOrderForHistoryOrder(historyOrder, warnings)
    res.json({ ok: true, source: 'history-order', historyOrder, signal, futuOrder, warnings } satisfies SimulationLinkedOrderDetailResponse)
  } catch (error) {
    next(error)
  }
})

router.get('/history/skipped', (req, res) => {
  res.json(simulationPersistence.paginate('skipped', Number(req.query.page), Number(req.query.pageSize)))
})

router.get('/futu-orders', async (req, res, next) => {
  try {
    res.json(
      await loadFutuSimulationOrders({
        page: Number(req.query.page),
        pageSize: Number(req.query.pageSize),
        startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
        endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
        ticker: typeof req.query.ticker === 'string' ? req.query.ticker : undefined,
      }),
    )
  } catch (error) {
    next(error)
  }
})

router.get('/futu-orders/:orderId/detail', async (req, res, next) => {
  try {
    const warnings: string[] = []
    const orderId = req.params.orderId
    const ticker = typeof req.query.ticker === 'string' ? req.query.ticker : undefined
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined
    const futuOrder = await findFutuOrderByOrderId(orderId, { ticker, startDate, endDate }, warnings)
    const historyOrder = simulationPersistence.findOrderByOrderId(orderId)

    let signal = undefined
    if (historyOrder) {
      signal = findSignalForOrder(historyOrder, warnings)
    } else {
      warnings.push('未找到关联历史模拟订单，可能是手动订单、旧数据缺失或非本系统提交订单。')
    }

    if (!futuOrder) warnings.push('未从 Futu 订单状态中找到该订单。')
    res.json({ ok: Boolean(futuOrder || historyOrder), source: 'futu-order', historyOrder, signal, futuOrder, warnings } satisfies SimulationLinkedOrderDetailResponse)
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
      event: 'simulation.api.llm_config_update',
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      disableUsOvernightLlm: typeof req.body?.disableUsOvernightLlm === 'boolean' ? req.body.disableUsOvernightLlm : undefined,
    },
    'LLM config update requested',
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
  res.json(getTradeStrategyRuntimeConfig('simulation'))
})

router.put('/trade-strategy-config', (req, res, next) => {
  try {
    res.json(
      updateTradeStrategyRuntimeConfig('simulation', {
        strategyId: typeof req.body?.strategyId === 'string' ? req.body.strategyId : undefined,
        promptPackId: typeof req.body?.promptPackId === 'string' ? req.body.promptPackId : undefined,
      }),
    )
  } catch (error) {
    next(error)
  }
})

router.post('/llm-test', async (_req, res, next) => {
  try {
    const account = await loadSimulationAccountDashboard()
    const ticker = 'GOOG'
    const position = account.positions.find((item) => (item.underlyingTicker || item.ticker).toUpperCase() === ticker)
    const decision = await requestTradingDecision({
      ticker,
      universe: LLM_SIMULATION_UNIVERSE,
      account,
      allPositions: account.positions,
      position,
      marketData: {
        ok: true,
        ticker,
        lastPrice: 100,
        bars: Array.from({ length: 30 }, (_, index) => ({
          time: `2026-06-16 10:${String(index).padStart(2, '0')}:00`,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
        })),
        tickerPoints: [],
        asks: [{ price: '$100.01', size: '100', depth: 1 }],
        bids: [{ price: '$99.99', size: '100', depth: 1 }],
        bestAsk: 100.01,
        bestBid: 99.99,
        updatedAt: new Date().toISOString(),
      },
      dataWindow: {
        kline1mBars: 30,
        tickerPoints: 60,
        orderBookDepth: 1,
        pollIntervalSeconds: 60,
        reason: 'LLM connectivity test.',
        source: 'fallback',
      },
      feeModel: 'Connectivity test fee model.',
      riskModel: 'Connectivity test risk model.',
    })
    res.json(decision)
  } catch (error) {
    next(error)
  }
})

export default router

function findSignalForOrder(order: SimulatedOrderResult, warnings: string[]) {
  const exactSignal = simulationPersistence.findSignalById(order.signalId)
  if (exactSignal) return exactSignal

  const nearestSignal = simulationPersistence.findNearestSignalForOrder(order)
  if (nearestSignal) {
    warnings.push('未按 signalId 精确匹配到历史策略信号，已使用同标的、同方向、时间接近的旧数据 fallback。')
    return nearestSignal
  }

  warnings.push('未找到关联历史策略信号。')
  return undefined
}

async function findFutuOrderForHistoryOrder(order: SimulatedOrderResult, warnings: string[]): Promise<FutuSimulationOrder | undefined> {
  if (!order.ok || order.orderId === 'blocked-by-risk' || order.orderId === 'unavailable') {
    warnings.push('该历史模拟订单未产生可查询的 Futu 真实订单。')
    return undefined
  }
  const range = dateRangeAround(order.submittedAt)
  return findFutuOrderByOrderId(order.orderId, { ticker: order.ticker, startDate: range.startDate, endDate: range.endDate }, warnings)
}

async function findFutuOrderByOrderId(
  orderId: string,
  input: { ticker?: string; startDate?: string; endDate?: string },
  warnings: string[],
): Promise<FutuSimulationOrder | undefined> {
  if (!orderId || orderId === 'blocked-by-risk' || orderId === 'unavailable') return undefined
  const response = await loadFutuSimulationOrders({
    page: 1,
    pageSize: 100,
    ticker: input.ticker,
    startDate: input.startDate,
    endDate: input.endDate,
  })
  if (!response.ok) {
    warnings.push(...response.warnings)
    return undefined
  }
  return response.orders.find((order) => order.orderId === orderId)
}

function dateRangeAround(value: string): { startDate: string; endDate: string } {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    const today = new Date()
    return { startDate: isoDate(addDays(today, -1)), endDate: isoDate(addDays(today, 1)) }
  }
  return { startDate: isoDate(addDays(date, -1)), endDate: isoDate(addDays(date, 1)) }
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}
