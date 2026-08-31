import type {
  LlmRuntimeConfig,
  LlmDataWindowRecommendation,
  LlmTradingDecision,
  Position,
  SimulatedOrderIntent,
  SimulatedOrderResult,
  MarketSessionStatus,
  SimulationAccountDashboardResponse,
  SimulationDashboardResponse,
  TradeStrategyConfig,
  TrendContextSummary,
} from '../../shared/types.js'
import { realtimeStore } from '../realtime/realtimeStore.js'
import { realtimeSubscriptionService } from '../realtime/realtimeSubscriptionService.js'
import { createTraceId, durationMs, errorMessage, logger, withLogContext } from '../utils/logger.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'
import { estimateRoundTripFee, feeModelDescription } from './feeContextService.js'
import { adviseDataWindow, type DataWindowAvailability } from './llmDataWindowAdvisor.js'
import { requestTradingDecision } from './llmTradingDecisionService.js'
import { getActiveDecisionConcurrency, getLlmRuntimeConfig } from './llmRuntimeConfigService.js'
import { attachMarketSessions, latestMarketSessions, loadMarketSessions } from './marketSessionService.js'
import { loadStrategyMarketData } from './realtimeDataAdapter.js'
import { loadSimulationAccountDashboard } from './simulationAccountService.js'
import { simulationStore } from './simulationStore.js'
import { LLM_SIMULATION_UNIVERSE, isInLlmSimulationUniverse, llmSimulationTickers, llmUniverseItem } from './simulationUniverse.js'
import { loadTrendContext } from './trendContextService.js'
import { buildRiskModelDescription, getActiveTradeStrategy } from '../trade_strategy/tradeStrategyConfigService.js'

const DEFAULT_RUN_INTERVAL_MS = 60_000
const WARMUP_TIMEOUT_MS = 20_000
const STRATEGY = 'LLM_AUTONOMOUS_STOCK_TRADER' as const
const MARKETABLE_LIMIT_SLIPPAGE_BPS = Number(process.env.SIM_MARKETABLE_LIMIT_SLIPPAGE_BPS || 15)

class SimulationTradingEngine {
  private timer?: NodeJS.Timeout
  private runInFlight = false
  private account?: SimulationAccountDashboardResponse

  async dashboard(): Promise<SimulationDashboardResponse> {
    const account = this.account ?? (await loadSimulationAccountDashboard())
    const marketSessions = await loadMarketSessions(llmSimulationTickers())
    return {
      account,
      engine: simulationStore.getEngine(),
      universe: attachMarketSessions(LLM_SIMULATION_UNIVERSE, marketSessions),
      llmRuntimeConfig: getLlmRuntimeConfig().config,
      modelOptions: getLlmRuntimeConfig().modelOptions,
      latestSignals: simulationStore.latestSignals(),
      latestOrders: simulationStore.latestOrders(),
      skippedTickers: simulationStore.skippedTickers(),
      warnings: account.warnings,
    }
  }

  async start(): Promise<SimulationDashboardResponse> {
    return withLogContext(createTraceId('simulation-start'), async () => {
      const startedAt = performance.now()
      logger.info({ event: 'simulation.start.requested', universeCount: llmSimulationTickers().length }, 'Simulation start requested')
      try {
        if (this.timer) return this.dashboard()

        const account = await loadSimulationAccountDashboard()
        this.account = account
        if (!account.ok || account.selectedAccountId === 'unavailable') {
          simulationStore.setError(account.warnings[0] ?? '模拟账户不可用，无法启动模拟交易引擎。')
          logger.warn({ event: 'simulation.start.failed', accountId: account.selectedAccountId, error: account.warnings[0], durationMs: durationMs(startedAt) }, 'Simulation start failed')
          return this.dashboard()
        }

        const tickers = llmSimulationTickers()
        realtimeSubscriptionService.start(tickers)
        simulationStore.clearSkipped()
        simulationStore.setRunning(account.selectedAccountId, tickers, DEFAULT_RUN_INTERVAL_MS)
        await waitForRealtimeWarmup(tickers)

        const dataAvailability = realtimeDataWindowAvailability(tickers)
        logger.info({ event: 'simulation.data_window.availability', ...dataAvailability }, 'Simulation data window availability measured')
        const dataWindow = await adviseDataWindow(LLM_SIMULATION_UNIVERSE, account, dataAvailability)
        simulationStore.setDataWindow(dataWindow)
        await this.runOnce()

        this.timer = setInterval(() => {
          this.runOnce().catch((error) => {
            simulationStore.setError(error instanceof Error ? error.message : '模拟交易引擎运行失败。')
            logger.error({ event: 'simulation.run_once.failed', error: errorMessage(error) }, 'Simulation run failed')
          })
        }, dataWindow.pollIntervalSeconds * 1000)

        logger.info(
          {
            event: 'simulation.start.succeeded',
            accountId: account.selectedAccountId,
            runIntervalMs: dataWindow.pollIntervalSeconds * 1000,
            dataWindow,
            durationMs: durationMs(startedAt),
          },
          'Simulation start succeeded',
        )
        return this.dashboard()
      } catch (error) {
        logger.error({ event: 'simulation.start.failed', error: errorMessage(error), durationMs: durationMs(startedAt) }, 'Simulation start failed')
        throw error
      }
    })
  }

  stop(): SimulationDashboardResponse {
    return withLogContext(createTraceId('simulation-stop'), () => {
      const startedAt = performance.now()
      logger.info({ event: 'simulation.stop.requested' }, 'Simulation stop requested')
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    simulationStore.setStopped()
    const account = this.account ?? emptyAccount()
    const dashboard = {
      account,
      engine: simulationStore.getEngine(),
      universe: attachMarketSessions(LLM_SIMULATION_UNIVERSE, latestMarketSessions()),
      llmRuntimeConfig: getLlmRuntimeConfig().config,
      modelOptions: getLlmRuntimeConfig().modelOptions,
      latestSignals: simulationStore.latestSignals(),
      latestOrders: simulationStore.latestOrders(),
      skippedTickers: simulationStore.skippedTickers(),
      warnings: account.warnings,
    }
      logger.info({ event: 'simulation.stop.succeeded', durationMs: durationMs(startedAt) }, 'Simulation stop succeeded')
      return dashboard
    })
  }

  async runOnce(): Promise<SimulationDashboardResponse> {
    return withLogContext(createTraceId('simulation-run'), async () => {
      if (this.runInFlight) {
        logger.warn({ event: 'simulation.run_once.skipped', reason: 'previous run still in flight' }, 'Simulation run skipped because previous run is still in flight')
        return this.dashboard()
      }
      this.runInFlight = true
      try {
        return await this.runOnceInternal()
      } finally {
        this.runInFlight = false
      }
    })
  }

  private async runOnceInternal(): Promise<SimulationDashboardResponse> {
    const runStartedAt = performance.now()
    const engine = simulationStore.getEngine()
    const account = await loadSimulationAccountDashboard(engine.accountId)
    this.account = account
    if (!account.ok || account.selectedAccountId === 'unavailable') {
      const message = account.warnings[0] ?? '模拟账户不可用，跳过本轮大模型交易评估。'
      simulationStore.setError(message)
      return this.dashboard()
    }

    const dataWindow = engine.dataWindow ?? fallbackDataWindow()
    const universe = engine.universe.length ? engine.universe : llmSimulationTickers()
    const marketSessions = await loadMarketSessions(universe)
    const positions = stockPositionsByTicker(account.positions)
    const decisionConcurrency = getActiveDecisionConcurrency(universe.length)
    const runtimeConfig = getLlmRuntimeConfig().config
    const tradeStrategy = getActiveTradeStrategy('simulation')
    const etfTickers = universe.filter((ticker) => llmUniverseItem(ticker)?.assetType === 'ETF')
    logger.info(
      {
        event: 'simulation.run_once.started',
        accountId: account.selectedAccountId,
        universeCount: universe.length,
        etfCount: etfTickers.length,
        etfTickers,
        concurrency: decisionConcurrency,
        maxConcurrency: runtimeConfig.maxConcurrency,
        model: runtimeConfig.model,
        modelLabel: runtimeConfig.modelLabel,
        dataWindow,
      },
      'Simulation run started',
    )
    simulationStore.markRun(dataWindow.pollIntervalSeconds * 1000)

    const batchStartedAt = performance.now()
    logger.info({ event: 'simulation.llm_batch.started', universeCount: universe.length, etfCount: etfTickers.length, concurrency: decisionConcurrency, maxConcurrency: runtimeConfig.maxConcurrency, model: runtimeConfig.model }, 'Simulation LLM batch started')
    const evaluations = await mapLimit(universe, decisionConcurrency, async (ticker) => {
      const logMeta = decisionLogMeta(ticker)
      logger.info({ event: 'simulation.ticker.evaluation_started', ...logMeta, concurrency: decisionConcurrency }, 'Simulation ticker evaluation started')
      if (!isInLlmSimulationUniverse(ticker)) {
        return { ticker, skipped: '标的不在用户指定的大模型模拟盘票池中。' }
      }

      const marketData = loadStrategyMarketData(ticker, dataWindow)
      if (marketData.ok === false) {
        logger.warn({ event: 'simulation.market_data.unavailable', ...logMeta, reason: marketData.reason }, 'Simulation market data unavailable')
        return { ticker, skipped: marketData.reason }
      }

      const position = positions.get(ticker)
      logger.info(
        {
          event: 'simulation.market_data.ready',
          ...logMeta,
          lastPrice: marketData.lastPrice,
          bestBid: marketData.bestBid,
          bestAsk: marketData.bestAsk,
          klineBars: marketData.bars.length,
          tickerPoints: marketData.tickerPoints.length,
          orderBookDepth: Math.max(marketData.bids.length, marketData.asks.length),
          positionQuantity: positionQuantity(position),
        },
        'Simulation market data ready',
      )
      const trendContext = await loadTrendContext(ticker, {
        lookbackTradingDays: dataWindow.trendLookbackTradingDays ?? 7,
        barInterval: dataWindow.trendBarInterval ?? '30m',
        currentPrice: marketData.lastPrice,
      })
      logger.info(
        {
          event: 'simulation.trend_context.loaded',
          ...logMeta,
          available: trendContext.window.available,
          reason: trendContext.window.reason,
          trendDirection: trendContext.trendDirection,
          trendStrength: trendContext.trendStrength,
        },
        'Simulation trend context loaded',
      )
      if (!trendContext.window.available && !position) {
        return { ticker, skipped: `趋势上下文不可用，禁止无持仓新开仓：${trendContext.window.reason ?? trendContext.summary}` }
      }

      const decision = await requestTradingDecision({
        ticker,
        universe: LLM_SIMULATION_UNIVERSE,
        account,
        marketData,
        allPositions: account.positions,
        position,
        dataWindow,
        trendContext,
        feeModel: feeModelDescription(),
        riskModel: buildRiskModelDescription('simulation'),
      })
      logger.info(
        {
          event: 'simulation.llm_decision.received',
          ...logMeta,
          approved: decision.approved,
          action: decision.action,
          orderQuantity: decision.orderQuantity,
          limitPrice: decision.limitPrice,
          confidence: decision.confidence,
          trendAlignment: decision.trendAlignment,
          tradeHorizon: decision.tradeHorizon,
          ok: decision.ok,
          reasonPreview: decision.reason.slice(0, 160),
          riskPreview: decision.riskAssessment.slice(0, 160),
        },
        'Simulation LLM decision received',
      )
      return { ticker, marketData, position, decision, trendContext }
    })
    logger.info(
      {
        event: 'simulation.llm_batch.completed',
        durationMs: durationMs(batchStartedAt),
        evaluatedCount: evaluations.filter((evaluation) => !evaluation.skipped).length,
        skippedCount: evaluations.filter((evaluation) => evaluation.skipped).length,
      },
      'Simulation LLM batch completed',
    )

    let submittedOrderCount = 0
    let blockedOrderCount = 0
    let approvedCount = 0
    let skippedCount = 0
    for (const evaluation of evaluations) {
      if (evaluation.skipped) {
        simulationStore.recordSkipped(evaluation.ticker, evaluation.skipped)
        skippedCount += 1
        logger.warn({ event: 'simulation.ticker.skipped', ...decisionLogMeta(evaluation.ticker), reason: evaluation.skipped }, 'Simulation ticker skipped')
        continue
      }
      const { ticker, marketData, position, decision, trendContext } = evaluation
      const signal = signalFromDecision(decision, marketData.updatedAt, runtimeConfig, trendContext)
      simulationStore.addSignal(signal)
      logger.info({ event: 'simulation.signal.recorded', ...decisionLogMeta(ticker), signalId: signal.id, action: decision.action, approved: decision.approved, orderQuantity: decision.orderQuantity, confidence: decision.confidence }, 'Simulation signal recorded')

      if (!decision.approved || decision.action === 'HOLD') {
        logger.info({ event: 'simulation.order.not_created', ...decisionLogMeta(ticker), signalId: signal.id, action: decision.action, approved: decision.approved, reason: !decision.approved ? 'LLM decision not approved' : 'HOLD decision' }, 'Simulation order not created')
        continue
      }
      approvedCount += 1
      const trendBlockReason = trendDecisionBlockReason(decision, position, trendContext, tradeStrategy)
      if (trendBlockReason) {
        simulationStore.recordSkipped(ticker, trendBlockReason)
        simulationStore.addOrder(blockedOrder(decision, trendBlockReason, signal.id))
        blockedOrderCount += 1
        logger.warn({ event: 'simulation.order.trend_blocked', ...decisionLogMeta(ticker), signalId: signal.id, side: decision.action, reason: trendBlockReason, trendAlignment: decision.trendAlignment, tradeHorizon: decision.tradeHorizon }, 'Simulation order blocked by trend filter')
        continue
      }

      if (!simulationStore.canSubmit(ticker, decision.action, STRATEGY)) {
        const reason = '同一标的同向大模型订单仍处于 15 分钟去重窗口。'
        simulationStore.recordSkipped(ticker, reason)
        skippedCount += 1
        logger.warn({ event: 'simulation.order.dedup_blocked', ...decisionLogMeta(ticker), signalId: signal.id, side: decision.action, reason }, 'Simulation order blocked by dedup window')
        continue
      }

      const marketSession = marketSessions[ticker.toUpperCase()]
      const orderSession = orderSessionForMarket(marketSession)
      if (!orderSession) {
        const reason = marketSession
          ? `当前市场状态为 ${marketSession.labelZh}（${marketSession.state}），Futu SIMULATE 仅支持盘中 RTH 与盘前/盘后 ETH，下单已跳过。`
          : '当前市场状态不可用，无法确认是否支持 Futu SIMULATE 下单，已跳过。'
        simulationStore.recordSkipped(ticker, reason)
        simulationStore.addOrder(blockedOrder(decision, reason, signal.id))
        blockedOrderCount += 1
        logger.warn({ event: 'simulation.order.session_blocked', ...decisionLogMeta(ticker), signalId: signal.id, side: decision.action, reason, marketState: marketSession?.state, labelZh: marketSession?.labelZh }, 'Simulation order blocked by market session')
        continue
      }

      const intentResult = buildOrderIntent(decision, account, position, marketData, orderSession, signal.id, tradeStrategy)
      if (!intentResult.intent) {
        const reason = intentResult.blockedReason ?? '大模型订单未通过后端硬风控，已阻断。'
        simulationStore.recordSkipped(ticker, reason)
        simulationStore.addOrder(blockedOrder(decision, reason, signal.id))
        blockedOrderCount += 1
        logger.warn({ event: 'simulation.order.risk_blocked', ...decisionLogMeta(ticker), signalId: signal.id, side: decision.action, quantity: decision.orderQuantity, limitPrice: decision.limitPrice, positionQuantity: positionQuantity(position), reason }, 'Simulation order blocked by risk control')
        continue
      }

      const intent = intentResult.intent
      const order = await submitSimulatedOrder(account.selectedAccountId, intent, decision)
      simulationStore.addOrder(order)
      if (order.ok) {
        submittedOrderCount += 1
        logger.info(
          {
            event: 'simulation.order.submitted',
            ...decisionLogMeta(ticker),
            side: intent.side,
            quantity: intent.quantity,
            orderType: intent.orderType,
            orderSession: intent.orderSession,
            limitPrice: intent.limitPrice,
            orderId: order.orderId,
          },
          'Simulation order submitted',
        )
      } else if (order.error) {
        simulationStore.recordSkipped(ticker, order.error)
        logger.error({ event: 'simulation.order.failed', ticker, side: intent.side, error: order.error }, 'Simulation order failed')
      }
    }

    logger.info(
      {
        event: 'simulation.run_once.completed',
        durationMs: durationMs(runStartedAt),
        signalCount: evaluations.filter((evaluation) => !evaluation.skipped).length,
        approvedCount,
        submittedOrderCount,
        blockedOrderCount,
        skippedCount,
      },
      'Simulation run completed',
    )
    return this.dashboard()
  }
}

export const simulationTradingEngine = new SimulationTradingEngine()

async function waitForRealtimeWarmup(universe: string[]) {
  const deadline = Date.now() + WARMUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const readyCount = universe.filter((ticker) => loadStrategyMarketData(ticker, 30).ok).length
    if (readyCount > 0) return
    simulationStore.setError(`等待用户票池实时 K 线预热：${readyCount}/${universe.length} 已满足 30 根。`)
    await sleep(1000)
  }
  simulationStore.setError('用户票池实时 K 线预热超时，后续单轮评估会逐个跳过数据不足标的。')
}

function realtimeDataWindowAvailability(universe: string[]): DataWindowAvailability {
  const snapshots = universe.map((ticker) => realtimeStore.snapshot(ticker))
  return {
    minKline1mBars: minCount(snapshots.map((snapshot) => snapshot.klineBars.length)),
    minTickerPoints: minCount(snapshots.map((snapshot) => snapshot.tickerPoints.length)),
    minOrderBookDepth: minCount(snapshots.map((snapshot) => Math.min(snapshot.asks.length, snapshot.bids.length))),
  }
}

function minCount(values: number[]): number {
  return values.length ? Math.min(...values) : 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function stockPositionsByTicker(positions: Position[]): Map<string, Position> {
  const result = new Map<string, Position>()
  for (const position of positions) {
    if (position.assetType !== 'STOCK' && position.assetType !== 'ETF') continue
    const ticker = (position.underlyingTicker || position.ticker).toUpperCase()
    if (!isInLlmSimulationUniverse(ticker)) continue
    result.set(ticker, position)
  }
  return result
}

function signalFromDecision(decision: LlmTradingDecision, updatedAt: string, runtimeConfig: LlmRuntimeConfig, trendContext?: TrendContextSummary) {
  return {
    id: `${decision.ticker}-${STRATEGY}-${Date.now()}`,
    ticker: decision.ticker,
    strategy: STRATEGY,
    model: runtimeConfig.model,
    modelLabel: runtimeConfig.modelLabel,
    side: decision.action,
    confidence: decision.confidence,
    reason: decision.reason,
    price: formatMoney(decision.limitPrice),
    quantity: String(decision.orderQuantity),
    limitPrice: formatMoney(decision.limitPrice),
    riskAssessment: decision.riskAssessment,
    generatedAt: new Date().toISOString(),
    dataWindow: dataWindowDescription(decision, updatedAt, trendContext),
    trendContext: trendContext
      ? {
          available: trendContext.window.available,
          lookbackTradingDays: trendContext.window.lookbackTradingDays,
          barInterval: trendContext.window.barInterval,
          trendDirection: trendContext.trendDirection,
          trendStrength: trendContext.trendStrength,
          pricePositionInRange: trendContext.pricePositionInRange,
          summary: trendContext.summary,
        }
      : undefined,
    trendAlignment: decision.trendAlignment,
    tradeHorizon: decision.tradeHorizon,
    whyNotNoise: decision.whyNotNoise,
    source: 'futu-callback' as const,
    rawModelOutput: decision.rawText,
  }
}

function dataWindowDescription(decision: LlmTradingDecision, updatedAt: string, trendContext?: TrendContextSummary): string {
  const execution = `执行: ${decision.dataWindowUsed.kline1mBars} x 1m K线 / ${decision.dataWindowUsed.tickerPoints} 分时点 / ${decision.dataWindowUsed.orderBookDepth} 档摆盘 @ ${updatedAt}`
  if (!trendContext) return execution
  const trend = trendContext.window.available
    ? `趋势: ${trendContext.window.lookbackTradingDays}日 ${trendContext.window.barInterval} K线 / ${trendContext.trendDirection} / ${trendContext.trendStrength}`
    : `趋势: 不可用 / ${trendContext.window.reason ?? trendContext.summary}`
  return `${execution}\n${trend}`
}

function trendDecisionBlockReason(decision: LlmTradingDecision, position: Position | undefined, trendContext: TrendContextSummary | undefined, tradeStrategy: TradeStrategyConfig): string | undefined {
  const filters = tradeStrategy.trendFilters ?? {}
  if (!isOpeningDecision(decision, position)) return undefined
  if (filters.requireTrendForOpening !== false && !trendContext?.window.available) return '趋势上下文不可用，当前策略禁止无持仓新开仓。'
  if (filters.blockAgainstTrendOpening !== false && decision.trendAlignment === 'AGAINST_TREND') return '模型返回 AGAINST_TREND，当前策略禁止无持仓逆 7 日趋势新开仓。'
  if (filters.blockScalpOpeningWhenFlat !== false && decision.tradeHorizon === 'SCALP') return '当前策略禁止使用 SCALP 作为无持仓新开仓理由。'
  const minWhyNotNoiseLength = filters.minWhyNotNoiseLength ?? 12
  if (!decision.whyNotNoise || decision.whyNotNoise.trim().length < minWhyNotNoiseLength || decision.whyNotNoise.includes('未说明短周期噪声过滤依据')) {
    return '模型未充分说明 whyNotNoise，禁止仅凭短周期噪声新开仓。'
  }
  return undefined
}

function isOpeningDecision(decision: LlmTradingDecision, position: Position | undefined): boolean {
  const quantity = positionQuantity(position)
  if (decision.action === 'SELL_SHORT') return true
  if (decision.action === 'BUY') return quantity >= 0
  return false
}

function buildOrderIntent(
  decision: LlmTradingDecision,
  account: SimulationAccountDashboardResponse,
  position: Position | undefined,
  marketData: Extract<ReturnType<typeof loadStrategyMarketData>, { ok: true }>,
  orderSession: SimulatedOrderIntent['orderSession'],
  signalId: string,
  tradeStrategy: TradeStrategyConfig,
): { intent?: SimulatedOrderIntent; blockedReason?: string } {
  if (decision.action !== 'BUY' && decision.action !== 'SELL_SHORT' && decision.action !== 'SELL_TO_CLOSE') return { blockedReason: `动作 ${decision.action} 不支持生成模拟盘订单。` }
  const limitPrice = marketableLimitPrice(decision, marketData)
  if (decision.orderQuantity <= 0) return { blockedReason: `下单数量无效：${decision.orderQuantity}，必须为正整数。` }
  if (limitPrice <= 0) return { blockedReason: `订单价格无效：${formatMoney(limitPrice)}。` }
  const orderType = selectOrderTypeForDecision(decision, position, orderSession)
  if (decision.action === 'SELL_TO_CLOSE') {
    const availableQuantity = positionQuantity(position)
    if (availableQuantity <= 0) return { blockedReason: 'SELL_TO_CLOSE 被拦截：当前没有可平的正股/ETF多头持仓。' }
    if (decision.orderQuantity > availableQuantity) return { blockedReason: `SELL_TO_CLOSE 被拦截：建议数量 ${decision.orderQuantity} 超过可平数量 ${availableQuantity}。` }
  }
  if (decision.action === 'BUY' && positionQuantity(position) < 0) {
    const shortQuantity = Math.abs(positionQuantity(position))
    if (decision.orderQuantity > shortQuantity) return { blockedReason: `空头回补 BUY 被拦截：建议数量 ${decision.orderQuantity} 超过空头数量 ${shortQuantity}。` }
  } else if (decision.action === 'BUY' || decision.action === 'SELL_SHORT') {
    const blockedReason = openingRiskRejectionReason(account, decision, limitPrice, tradeStrategy)
    if (blockedReason) return { blockedReason }
  }

  return {
    intent: {
      ticker: decision.ticker,
      side: decision.action,
      quantity: decision.orderQuantity,
      orderType,
      orderSession,
      limitPrice,
      strategy: STRATEGY,
      signalId,
      reason: decision.reason,
      sizingReason: decision.riskAssessment,
      estimatedNotional: formatMoney(decision.orderQuantity * limitPrice),
      estimatedRoundTripFee: formatMoney(estimateRoundTripFee(decision.orderQuantity, limitPrice)),
    },
  }
}

export function selectOrderTypeForDecision(
  decision: Pick<LlmTradingDecision, 'action'>,
  position: Pick<Position, 'quantity'> | undefined,
  orderSession: SimulatedOrderIntent['orderSession'],
): SimulatedOrderIntent['orderType'] {
  if (decision.action === 'BUY' && positionQuantity(position as Position | undefined) < 0 && orderSession === 'RTH') return 'MARKET'
  return 'MARKETABLE_LIMIT'
}

function orderSessionForMarket(marketSession?: MarketSessionStatus): SimulatedOrderIntent['orderSession'] | undefined {
  if (!marketSession) return undefined
  if (marketSession.state === 'MORNING' || marketSession.state === 'AFTERNOON' || marketSession.state === 'AUCTION' || marketSession.state === 'TRADE_AT_LAST') return 'RTH'
  if (marketSession.state === 'PRE_MARKET_BEGIN' || marketSession.state === 'PRE_MARKET_END' || marketSession.state === 'AFTER_HOURS_BEGIN' || marketSession.state === 'AFTER_HOURS_END') return 'ETH'
  return undefined
}

function decisionLogMeta(ticker: string) {
  const item = llmUniverseItem(ticker)
  return {
    ticker: ticker.toUpperCase(),
    assetType: item?.assetType ?? 'UNKNOWN',
    underlyingTicker: item?.underlyingTicker,
    leverageFactor: item?.leverageFactor,
    isEtf: item?.assetType === 'ETF',
  }
}

function marketableLimitPrice(decision: LlmTradingDecision, marketData: Extract<ReturnType<typeof loadStrategyMarketData>, { ok: true }>): number {
  const slippage = MARKETABLE_LIMIT_SLIPPAGE_BPS / 10_000
  if (decision.action === 'BUY') {
    const reference = marketData.bestAsk > 0 ? marketData.bestAsk : decision.limitPrice
    return roundPrice(Math.max(decision.limitPrice, reference * (1 + slippage)))
  }
  const reference = marketData.bestBid > 0 ? marketData.bestBid : decision.limitPrice
  return roundPrice(Math.min(decision.limitPrice, reference * (1 - slippage)))
}

function openingRiskRejectionReason(account: SimulationAccountDashboardResponse, decision: LlmTradingDecision, limitPrice: number, tradeStrategy: TradeStrategyConfig): string | undefined {
  const equity = parseMoney(account.summary.totalAssets) ?? parseMoney(account.summary.buyingPower)
  const buyingPower = parseMoney(account.summary.buyingPower) ?? equity
  const notional = decision.orderQuantity * limitPrice
  const controls = tradeStrategy.riskControls
  const singleNameHardBlock = decision.action === 'SELL_SHORT' ? controls.shortExposure?.mode === 'hard_block' : controls.singleNameExposure?.mode === 'hard_block'
  const maxSingleNamePct = decision.action === 'SELL_SHORT' ? controls.shortExposure?.maxSingleNamePctEquity : controls.singleNameExposure?.maxPctEquity
  const buyingPowerPct = controls.buyingPowerProtection?.maxPctBuyingPower ?? 0.95
  const maxFeeRatio = controls.feeDrag?.maxRoundTripFeePctNotional
  const estimatedFee = estimateRoundTripFee(decision.orderQuantity, limitPrice)
  const feeRatio = estimatedFee / notional
  const context = {
    event: 'simulation.risk.opening_evaluated',
    ...decisionLogMeta(decision.ticker),
    side: decision.action,
    quantity: decision.orderQuantity,
    limitPrice,
    notional,
    notionalText: formatMoney(notional),
    equity,
    buyingPower,
    minNotionalMode: controls.minNotional?.mode,
    minNotionalAmount: controls.minNotional?.amount,
    singleNameMode: decision.action === 'SELL_SHORT' ? controls.shortExposure?.mode : controls.singleNameExposure?.mode,
    singleNameHardBlock,
    maxSingleNamePct,
    singleNameLimit: equity && maxSingleNamePct !== undefined ? equity * maxSingleNamePct : undefined,
    buyingPowerMode: controls.buyingPowerProtection?.mode,
    buyingPowerPct,
    buyingPowerLimit: buyingPower ? buyingPower * buyingPowerPct : undefined,
    feeMode: controls.feeDrag?.mode,
    estimatedFee,
    feeRatio,
    maxFeeRatio,
    strategyId: tradeStrategy.id,
  }
  if (!equity || !buyingPower) {
    const reason = '开仓风控被拦截：模拟账户权益或购买力不可用。'
    logger.warn({ ...context, passed: false, blockedRule: 'account_funds_unavailable', reason }, 'Simulation opening risk blocked')
    return reason
  }
  if (controls.minNotional?.mode === 'hard_block' && notional < controls.minNotional.amount) {
    const reason = `开仓风控被拦截：名义金额 ${formatMoney(notional)} 低于最低开仓金额 ${formatMoney(controls.minNotional.amount)}。`
    logger.warn({ ...context, passed: false, blockedRule: 'min_notional', reason }, 'Simulation opening risk blocked')
    return reason
  }
  if (singleNameHardBlock && maxSingleNamePct !== undefined && notional > equity * maxSingleNamePct) {
    const reason = `开仓风控被拦截：名义金额 ${formatMoney(notional)} 超过当前策略单票权益硬上限 ${formatMoney(equity * maxSingleNamePct)}（${(maxSingleNamePct * 100).toFixed(2)}%）。`
    logger.warn({ ...context, passed: false, blockedRule: 'single_name_hard_limit', reason }, 'Simulation opening risk blocked')
    return reason
  }
  if (controls.buyingPowerProtection?.mode !== 'off' && notional > buyingPower * buyingPowerPct) {
    const reason = `开仓风控被拦截：名义金额 ${formatMoney(notional)} 超过模拟账户可用购买力保护线 ${formatMoney(buyingPower * buyingPowerPct)}。`
    logger.warn({ ...context, passed: false, blockedRule: 'buying_power_protection', reason }, 'Simulation opening risk blocked')
    return reason
  }
  if (maxFeeRatio !== undefined && controls.feeDrag?.mode !== 'off' && feeRatio > maxFeeRatio) {
    const reason = `开仓风控被拦截：估算往返费用 ${formatMoney(estimatedFee)} 占名义金额 ${(feeRatio * 100).toFixed(2)}%，超过当前策略上限 ${(maxFeeRatio * 100).toFixed(2)}%。`
    logger.warn({ ...context, passed: false, blockedRule: 'fee_drag', reason }, 'Simulation opening risk blocked')
    return reason
  }
  logger.info({ ...context, passed: true }, 'Simulation opening risk passed')
  return undefined
}

async function submitSimulatedOrder(accountId: string, intent: SimulatedOrderIntent, decision: LlmTradingDecision): Promise<SimulatedOrderResult> {
  const bridge = await runPythonBridge<SimulatedOrderResult>('futu_sim_order.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    accountId,
    ...intent,
  })
  if (bridge.ok && bridge.data) return { ...bridge.data, llmDecision: decision }

  return {
    ok: false,
    orderId: 'unavailable',
    ticker: intent.ticker,
    side: intent.side,
    quantity: String(intent.quantity),
    orderType: intent.orderType,
    orderSession: intent.orderSession,
    limitPrice: formatMoney(intent.limitPrice),
    submittedAt: new Date().toISOString(),
    strategy: intent.strategy,
    signalId: intent.signalId,
    llmDecision: decision,
    error: `Simulated order bridge failed: ${bridge.error ?? 'unknown error'}`,
  }
}

function blockedOrder(decision: LlmTradingDecision, reason: string, signalId: string): SimulatedOrderResult {
  return {
    ok: false,
    orderId: 'blocked-by-risk',
    ticker: decision.ticker,
    side: decision.action,
    quantity: String(decision.orderQuantity),
    orderType: 'LIMIT',
    orderSession: undefined,
    limitPrice: formatMoney(decision.limitPrice),
    submittedAt: new Date().toISOString(),
    strategy: STRATEGY,
    signalId,
    llmDecision: decision,
    error: reason,
  }
}

function positionQuantity(position?: Position): number {
  if (!position) return 0
  const value = Number(position.quantity.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(value) ? value : 0
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker))
  return results
}

function fallbackDataWindow(): LlmDataWindowRecommendation {
  return {
    kline1mBars: 120,
    tickerPoints: 240,
    orderBookDepth: 5,
    pollIntervalSeconds: 60,
    trendLookbackTradingDays: 7,
    trendBarInterval: '30m',
    strategyHorizon: 'SWING_1_TO_7_DAYS',
    reason: '引擎尚未获得大模型窗口建议，使用默认窗口。',
    source: 'fallback',
  }
}

function parseMoney(value: string | undefined): number | undefined {
  if (!value || value === 'unavailable') return undefined
  const numeric = Number(value.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(numeric) ? numeric : undefined
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100
}

function emptyAccount(): SimulationAccountDashboardResponse {
  const timestamp = new Date().toISOString()
  return {
    ok: false,
    accounts: [],
    selectedAccountId: 'unavailable',
    summary: {
      accountId: 'unavailable',
      currency: 'USD',
      totalAssets: 'unavailable',
      cash: 'unavailable',
      availableFunds: 'unavailable',
      buyingPower: 'unavailable',
      dailyPnL: 'unavailable',
      totalPnL: 'unavailable',
      source: {
        source: 'Futu OpenD Simulated Account',
        accessedAt: timestamp,
        timestamp,
      },
    },
    positions: [],
    trading: {
      environment: 'SIMULATE',
      liveTradingEnabled: false,
      requiresConfirmation: false,
      warning: 'Simulated account data unavailable; simulated trading is disabled.',
    },
    warnings: ['模拟账户尚未加载。'],
  }
}
