import type {
  LiveAccountDashboardResponse,
  LiveEngineStatus,
  LiveOrderIntent,
  LiveOrderResult,
  LivePendingOrder,
  LiveTradingDashboardResponse,
  LlmDataWindowRecommendation,
  LlmRuntimeConfig,
  LlmTradingDecision,
  MarketSessionStatus,
  Position,
  QuantSignal,
  TradeStrategyConfig,
  TrendContextSummary,
} from '../../shared/types.js'
import { realtimeStore } from '../realtime/realtimeStore.js'
import { realtimeSubscriptionService } from '../realtime/realtimeSubscriptionService.js'
import { createTraceId, durationMs, errorMessage, logger, withLogContext } from '../utils/logger.js'
import { getActiveDecisionConcurrency, getLlmRuntimeConfig } from '../simulation/llmRuntimeConfigService.js'
import { llmRequestPacingPlan, waitForLlmRequestSlot } from '../simulation/llmRequestPacing.js'
import { attachMarketSessions, latestMarketSessions, loadMarketSessions } from '../simulation/marketSessionService.js'
import { loadStrategyMarketData } from '../simulation/realtimeDataAdapter.js'
import { loadTrendContext } from '../simulation/trendContextService.js'
import { LLM_SIMULATION_UNIVERSE, isInLlmSimulationUniverse, llmSimulationTickers, llmUniverseItem } from '../simulation/simulationUniverse.js'
import { orderSessionForMarketState } from '../simulation/usOvernightLlmGate.js'
import { liveOrderQueueService } from './liveOrderQueueService.js'
import { loadLiveAccountDashboard, parseMoney } from './liveAccountService.js'
import { requestLiveTradingDecision } from './liveTradingDecisionService.js'
import { estimatePreTradeFee } from './liveFeeService.js'
import { buildRiskModelDescription, getActiveLivePortfolioReviewPrompt, getTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import { liveCandidatePoolService } from './liveCandidatePoolService.js'
import { requestLivePortfolioReviewDecision } from './livePortfolioReviewDecisionService.js'
import { getFutuLiveSettings } from './liveSettings.js'
import { listManagedOrders } from '../cloud/state/managedOrderStore.js'
import { hasManagedOrderConflict } from './managedOrderPolicy.js'
import { buildLiveEvaluationStatus, liveEvaluationSkipReason } from '../trading/liveEvaluationStatusService.js'
import { openingLotSizeFailureReason } from '../longbridge/longbridgeLotSizeService.js'

const DEFAULT_RUN_INTERVAL_MS = 60_000
const LIVE_TIMER_PHASE_OFFSET_MS = Number(process.env.LIVE_TRADING_TIMER_OFFSET_MS || 30_000)
const WARMUP_TIMEOUT_MS = 20_000
const STRATEGY = 'LLM_AUTONOMOUS_STOCK_TRADER' as const
const MARKETABLE_LIMIT_SLIPPAGE_BPS = Number(process.env.LIVE_MARKETABLE_LIMIT_SLIPPAGE_BPS || 15)
const FUTU_REALTIME_CACHE_MAX_AGE_MS = Math.max(15_000, Number(process.env.FUTU_REALTIME_CACHE_MAX_AGE_MS || 90_000) || 90_000)
const FUTU_REALTIME_STALE_REASON_PREFIX = 'Futu 实时缓存已过期'

class LiveTradingEngine {
  private timer?: NodeJS.Timeout
  private starting = false
  private runInFlight = false
  private account?: LiveAccountDashboardResponse
  private engine: LiveEngineStatus = emptyEngineStatus()

  async dashboard(): Promise<LiveTradingDashboardResponse> {
    const account = this.account ?? (await loadLiveAccountDashboard())
    const marketSessions = await loadMarketSessions(llmSimulationTickers())
    const runtimeConfig = getLlmRuntimeConfig().config
    const executionMode = getTradeStrategyRuntimeConfig('live').selection.executionMode
    return {
      account,
      engine: this.getEngine(),
      evaluationStatus: buildLiveEvaluationStatus({
        running: this.engine.running,
        items: evaluationMarketStates(this.engine.universe.length ? this.engine.universe : llmSimulationTickers(), marketSessions),
        disableUsOvernightLlm: runtimeConfig.disableUsOvernightLlm,
        lastError: this.engine.lastError,
      }),
      universe: attachMarketSessions(LLM_SIMULATION_UNIVERSE, marketSessions),
      llmRuntimeConfig: runtimeConfig,
      modelOptions: getLlmRuntimeConfig().modelOptions,
      latestSignals: liveOrderQueueService.latestSignals(),
      pendingOrders: liveOrderQueueService.activePendingOrders(),
      submittedOrders: liveOrderQueueService.latestSubmittedOrders(),
      skippedTickers: liveOrderQueueService.skippedTickers(),
      warnings: account.warnings,
      ...getFutuLiveSettings(),
      candidatePool: liveCandidatePoolService.snapshot(executionMode),
    }
  }

  async start(): Promise<LiveTradingDashboardResponse> {
    return withLogContext(createTraceId('live-start'), async () => {
      const startedAt = performance.now()
      logger.info({ event: 'live.start.requested', universeCount: llmSimulationTickers().length }, 'Live trading start requested')
      if (this.timer || this.starting || this.engine.running) return this.dashboard()
      this.starting = true
      try {
        const account = await loadLiveAccountDashboard()
        this.account = account
        if (!account.ok || account.selectedAccountId === 'unavailable') {
          this.setError(account.warnings[0] ?? '真实账户不可用，无法启动实盘评估。')
          return this.dashboard()
        }
        const tickers = llmSimulationTickers()
        realtimeSubscriptionService.start(tickers)
        liveOrderQueueService.clearSkipped()
        this.setRunning(account.selectedAccountId, tickers, DEFAULT_RUN_INTERVAL_MS)
        await waitForRealtimeWarmup(tickers)
        this.setDataWindow(fallbackDataWindow())
        await this.runOnce()
        if (!this.timer) {
          this.scheduleNextRun(LIVE_TIMER_PHASE_OFFSET_MS)
        }
        logger.info({ event: 'live.start.succeeded', accountId: account.selectedAccountId, timerOffsetMs: LIVE_TIMER_PHASE_OFFSET_MS, durationMs: durationMs(startedAt) }, 'Live trading start succeeded')
        return this.dashboard()
      } finally {
        this.starting = false
      }
    })
  }

  stop(): LiveTradingDashboardResponse {
    return withLogContext(createTraceId('live-stop'), () => {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
      this.starting = false
      this.engine = { ...this.engine, running: false, nextRunAt: '' }
      const account = this.account ?? emptyAccount()
      const executionMode = getTradeStrategyRuntimeConfig('live').selection.executionMode
      return {
        account,
        engine: this.getEngine(),
        evaluationStatus: buildLiveEvaluationStatus({
          running: false,
          items: evaluationMarketStates(llmSimulationTickers(), latestMarketSessions()),
          disableUsOvernightLlm: getLlmRuntimeConfig().config.disableUsOvernightLlm,
          lastError: this.engine.lastError,
        }),
        universe: attachMarketSessions(LLM_SIMULATION_UNIVERSE, latestMarketSessions()),
        llmRuntimeConfig: getLlmRuntimeConfig().config,
        modelOptions: getLlmRuntimeConfig().modelOptions,
        latestSignals: liveOrderQueueService.latestSignals(),
        pendingOrders: liveOrderQueueService.activePendingOrders(),
        submittedOrders: liveOrderQueueService.latestSubmittedOrders(),
        skippedTickers: liveOrderQueueService.skippedTickers(),
        warnings: account.warnings,
        ...getFutuLiveSettings(),
        candidatePool: liveCandidatePoolService.snapshot(executionMode),
      }
    })
  }

  async runOnce(): Promise<LiveTradingDashboardResponse> {
    return withLogContext(createTraceId('live-run'), async () => {
      if (this.runInFlight) {
        logger.warn({ event: 'live.run_once.skipped', reason: 'previous run still in flight' }, 'Live run skipped because previous run is still in flight')
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

  private async runOnceInternal(): Promise<LiveTradingDashboardResponse> {
    const runStartedAt = performance.now()
    const account = await loadLiveAccountDashboard(this.engine.accountId)
    this.account = account
    if (!account.ok || account.selectedAccountId === 'unavailable') {
      this.setError(account.warnings[0] ?? '真实账户不可用，跳过本轮实盘大模型评估。')
      return this.dashboard()
    }

    const dataWindow = this.engine.dataWindow ?? fallbackDataWindow()
    const universe = this.engine.universe.length ? this.engine.universe : llmSimulationTickers()
    const marketSessions = await loadMarketSessions(universe)
    const runtimeConfig = getLlmRuntimeConfig().config
    const marketSessionSkipped = marketSessionSkipsFromRealtime(universe, runtimeConfig, marketSessions)
    const skippedByGate = new Set(marketSessionSkipped.map((item) => item.ticker))
    for (const skipped of marketSessionSkipped) {
      logger.info(
        { event: 'live.ticker.market_session_llm_skipped_preflight', ticker: skipped.ticker, marketState: skipped.marketState, reason: skipped.reason },
        'Live ticker skipped by market-session LLM preflight gate',
      )
    }
    const activeUniverse = universe.filter((ticker) => !skippedByGate.has(ticker.toUpperCase()))
    const accountByCurrency = new Map<string, LiveAccountDashboardResponse>([['USD', account]])
    if (activeUniverse.some((ticker) => llmUniverseItem(ticker)?.market === 'HK')) {
      accountByCurrency.set('HKD', await loadLiveAccountDashboard({
        accountId: this.engine.accountId,
        market: 'HK',
        tradingCurrency: 'HKD',
      }))
    }
    const managedOpenOrders = await listManagedOrders('futu', true)
    const positions = stockPositionsByTicker(account.positions)
    const decisionConcurrency = getActiveDecisionConcurrency(activeUniverse.length)
    const tradeStrategyConfig = getTradeStrategyRuntimeConfig('live')
    const tradeStrategy = tradeStrategyConfig.activeStrategy
    const executionMode = tradeStrategyConfig.selection.executionMode
    if (executionMode === 'legacy_direct') liveCandidatePoolService.disableForModeSwitch()
    this.markRun(dataWindow.pollIntervalSeconds * 1000)
    await refreshRealtimeIfActiveCacheStale(activeUniverse, dataWindow)
    const etfTickers = activeUniverse.filter((ticker) => llmUniverseItem(ticker)?.assetType === 'ETF')
    const llmPacingBatch = { batchStartedAt: performance.now(), totalRequests: activeUniverse.length }
    const llmRequestPacing = llmRequestPacingPlan(activeUniverse.length)
    logger.info(
      {
        event: 'live.run_once.started',
        accountId: account.selectedAccountId,
        universeCount: universe.length,
        activeUniverseCount: activeUniverse.length,
        marketSessionSkippedCount: marketSessionSkipped.length,
        etfCount: etfTickers.length,
        etfTickers,
        concurrency: decisionConcurrency,
        maxConcurrency: runtimeConfig.maxConcurrency,
        model: runtimeConfig.model,
        modelLabel: runtimeConfig.modelLabel,
        executionMode,
        llmRequestPacing,
        dataWindow,
      },
      'Live run started',
    )

    const evaluations = await mapLimit(activeUniverse, decisionConcurrency, async (ticker, requestIndex) => {
      const universeItem = llmUniverseItem(ticker)
      const logMeta = decisionLogMeta(ticker)
      logger.info({ event: 'live.ticker.evaluation_started', ...logMeta, concurrency: decisionConcurrency }, 'Live ticker evaluation started')
      if (!isInLlmSimulationUniverse(ticker)) return { ticker, skipped: '标的不在用户指定的大模型票池中。' }
      const tickerDataWindow = effectiveDataWindowForTicker(ticker, dataWindow)
      const marketData = loadStrategyMarketData(ticker, tickerDataWindow)
      if (marketData.ok === false) {
        logger.warn({ event: 'live.market_data.unavailable', ...logMeta, reason: marketData.reason }, 'Live market data unavailable')
        return { ticker, skipped: marketData.reason }
      }
      const position = positions.get(ticker)
      const tickerAccount = accountByCurrency.get(universeItem?.market === 'HK' ? 'HKD' : 'USD') ?? account
      logger.info(
        {
          event: 'live.market_data.ready',
          ...logMeta,
          lastPrice: marketData.lastPrice,
          bestBid: marketData.bestBid,
          bestAsk: marketData.bestAsk,
          klineBars: marketData.bars.length,
          tickerPoints: marketData.tickerPoints.length,
          orderBookDepth: Math.max(marketData.bids.length, marketData.asks.length),
          dataWindow: tickerDataWindow,
          positionQuantity: positionQuantity(position),
        },
        'Live market data ready',
      )
      const sessionSkipReason = liveEvaluationSkipReason({ ticker, marketState: marketData.marketState, disableUsOvernightLlm: runtimeConfig.disableUsOvernightLlm })
      if (sessionSkipReason) {
        logger.info({ event: 'live.ticker.market_session_llm_skipped', ...logMeta, marketState: marketData.marketState, reason: sessionSkipReason }, 'Live ticker skipped by market-session LLM gate')
        return { ticker, skipped: sessionSkipReason, skipKind: 'market-session' as const }
      }
      const trendContext = await loadTrendContext(ticker, {
        lookbackTradingDays: tickerDataWindow.trendLookbackTradingDays ?? 7,
        barInterval: tickerDataWindow.trendBarInterval ?? '30m',
        currentPrice: marketData.lastPrice,
      })
      logger.info(
        {
          event: 'live.trend_context.loaded',
          ...logMeta,
          available: trendContext.window.available,
          reason: trendContext.window.reason,
          trendDirection: trendContext.trendDirection,
          trendStrength: trendContext.trendStrength,
          trendAlignmentHint: universeItem?.assetType === 'ETF' ? 'ETF uses its own traded ticker market data; underlyingTicker is context only.' : undefined,
        },
        'Live trend context loaded',
      )
      await waitForLlmRequestSlot({ index: requestIndex, ticker, batch: llmPacingBatch })
      const decision = await requestLiveTradingDecision({
        ticker,
        universe: LLM_SIMULATION_UNIVERSE,
        account: tickerAccount,
        marketData,
        allPositions: tickerAccount.positions,
        position,
        dataWindow: tickerDataWindow,
        riskModel: buildRiskModelDescription('live'),
        trendContext,
        managedOpenOrders: managedOpenOrders.filter((order) => order.ticker.toUpperCase() === ticker.toUpperCase()),
      })
      logger.info(
        {
          event: 'live.llm_decision.received',
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
        'Live LLM decision received',
      )
      return { ticker, marketData, position, decision, trendContext, account: tickerAccount }
    })

    let pendingCount = 0
    let skippedCount = 0
    for (const evaluation of evaluations) {
      if (evaluation.skipped) {
        const marketSessionSkip = 'skipKind' in evaluation && evaluation.skipKind === 'market-session'
        if (!marketSessionSkip) {
          liveOrderQueueService.recordSkipped(evaluation.ticker, evaluation.skipped)
        }
        skippedCount += 1
        logger.warn({ event: 'live.ticker.skipped_before_llm', ticker: evaluation.ticker, reason: evaluation.skipped }, 'Live ticker skipped before LLM decision')
        continue
      }
      const { ticker, marketData, position, decision, trendContext, account: tickerAccount } = evaluation
      const signal = signalFromDecision(decision, marketData.updatedAt, runtimeConfig, trendContext)
      liveOrderQueueService.addSignal(signal)
      this.engine = { ...this.engine, signalCount: this.engine.signalCount + 1 }
      logger.info(
        {
          event: 'live.signal.recorded',
          ...decisionLogMeta(ticker),
          signalId: signal.id,
          action: decision.action,
          approved: decision.approved,
          orderQuantity: decision.orderQuantity,
        },
        'Live signal recorded',
      )
      if (!decision.approved || decision.action === 'HOLD') {
        logger.info({ event: 'live.order.not_created', ...decisionLogMeta(ticker), signalId: signal.id, action: decision.action, approved: decision.approved, reason: !decision.approved ? 'LLM decision not approved' : 'HOLD decision' }, 'Live order not created')
        continue
      }
      const managedConflict = hasManagedOrderConflict(managedOpenOrders, ticker)
      if (managedConflict) {
        liveOrderQueueService.recordSkipped(
          ticker,
          `存在未终态系统挂单 ${managedConflict.orderId}，本轮禁止生成重复或反向订单。`,
          { signalId: signal.id, side: decision.action },
        )
        skippedCount += 1
        continue
      }
      if (executionMode === 'candidate_pool') {
        const candidate = liveCandidatePoolService.upsert({ signal, decision, marketData, position, trendContext })
        logger.info(
          {
            event: 'live.candidate_pool.candidate_upserted',
            ...decisionLogMeta(ticker),
            signalId: signal.id,
            candidateId: candidate.candidateId,
            side: candidate.action,
            signalCount: candidate.signalCount,
            groupKey: candidate.groupKey,
            priceDriftPct: candidate.priceDriftPct,
          },
          'Live candidate pool candidate upserted',
        )
        continue
      }
      if (!liveOrderQueueService.canCreatePending(ticker, decision.action, STRATEGY)) {
        liveOrderQueueService.recordSkipped(ticker, '同一标的同向实盘候选订单仍处于 15 分钟去重窗口。', {
          signalId: signal.id,
          side: decision.action,
        })
        skippedCount += 1
        logger.warn({ event: 'live.order.dedup_blocked', ...decisionLogMeta(ticker), signalId: signal.id, side: decision.action }, 'Live order blocked by dedup window')
        continue
      }
      const marketSession = marketSessions[ticker.toUpperCase()]
      const orderSession = orderSessionForMarket(marketSession)
      if (!orderSession) {
        liveOrderQueueService.recordSkipped(ticker, '当前市场状态不支持实盘候选订单生成。', {
          signalId: signal.id,
          side: decision.action,
        })
        skippedCount += 1
        logger.warn({ event: 'live.order.session_blocked', ...decisionLogMeta(ticker), signalId: signal.id, side: decision.action, marketState: marketSession?.state, labelZh: marketSession?.labelZh }, 'Live order blocked by market session')
        continue
      }
      const intentResult = buildOrderIntent(decision, tickerAccount, position, marketData, orderSession, signal.id, tradeStrategy)
      if (!intentResult.intent) {
        liveOrderQueueService.recordSkipped(ticker, intentResult.blockedReason ?? '大模型实盘建议未通过后端硬风控，未进入待确认队列。', {
          signalId: signal.id,
          side: decision.action,
        })
        skippedCount += 1
        logger.warn(
          {
            event: 'live.order.risk_blocked',
            ...decisionLogMeta(ticker),
            signalId: signal.id,
            side: decision.action,
            quantity: decision.orderQuantity,
            limitPrice: decision.limitPrice,
            positionQuantity: positionQuantity(position),
            blockedReason: intentResult.blockedReason,
          },
          'Live order blocked by risk control',
        )
        continue
      }
      const pendingOrder = { ...pendingOrderFromIntent(intentResult.intent, signal, decision), decisionMode: 'legacy_direct' as const }
      await this.createOrAutoSubmitPendingOrder(pendingOrder)
      pendingCount += 1
      logger.info(
        {
          event: getFutuLiveSettings().autoSubmitEnabled && getFutuLiveSettings().liveTradingEnabled ? 'live.pending_order.created_auto_submit_requested' : 'live.pending_order.created',
          ...decisionLogMeta(ticker),
          signalId: signal.id,
          pendingOrderId: pendingOrder.id,
          side: pendingOrder.intent.side,
          quantity: pendingOrder.intent.quantity,
          orderType: pendingOrder.intent.orderType,
          orderSession: pendingOrder.intent.orderSession,
          limitPrice: pendingOrder.intent.limitPrice,
          estimatedNotional: pendingOrder.intent.estimatedNotional,
        },
        'Live pending order created',
      )
    }

    if (executionMode === 'candidate_pool') {
      const reviewCandidates = liveCandidatePoolService.reviewCandidates()
      if (reviewCandidates.length) {
        const portfolioPromptConfig = getActiveLivePortfolioReviewPrompt()
        const portfolioPreset = portfolioPromptConfig.timingPresets.find((item) => item.id === portfolioPromptConfig.defaultPresetId) ?? portfolioPromptConfig.timingPresets[0]
        const portfolioDecision = await requestLivePortfolioReviewDecision({
          candidates: reviewCandidates,
          account,
          positions: account.positions,
          pendingOrders: [
            ...liveOrderQueueService.activePendingOrders().map((order) => ({
              id: order.id,
              ticker: order.intent.ticker,
              side: order.intent.side,
              createdAt: order.createdAt,
            })),
            ...managedOpenOrders.map((order) => ({
              id: `${order.platform}:${order.orderId}`,
              ticker: order.ticker,
              side: order.side,
              createdAt: order.submittedAt,
              brokerOrderId: order.orderId,
              status: order.status,
              remainingQuantity: order.remainingQuantity,
            })),
          ],
          constraints: {
            maxPromotedOrdersPerReview: portfolioPreset.maxPromotedOrdersPerReview,
            minSignalConfirmations: portfolioPreset.minSignalConfirmations,
            leveragedEtfCooldownMinutes: portfolioPreset.leveragedEtfCooldownMinutes,
            sameGroupMutualExclusion: false,
            humanConfirmationRequired: true,
          },
        })
        const promotedCandidates = portfolioDecision.ok ? liveCandidatePoolService.applyReview(portfolioDecision) : []
        logger.info(
          {
            event: 'live.candidate_pool.review_completed',
            portfolioDecisionId: portfolioDecision.portfolioDecisionId,
            ok: portfolioDecision.ok,
            candidateCount: reviewCandidates.length,
            promotedCount: promotedCandidates.length,
            rationale: portfolioDecision.portfolioRationale,
          },
          'Live candidate pool review completed',
        )
        for (const candidate of promotedCandidates) {
          const marketSession = marketSessions[candidate.ticker.toUpperCase()]
          const marketFailureReason = closedHongKongMarketFailureReason(candidate.ticker, marketSession)
          const orderSession = orderSessionForMarket(marketSession) ?? (marketFailureReason ? 'RTH' : undefined)
          if (!orderSession) {
            liveOrderQueueService.recordSkipped(candidate.ticker, '组合策略候选被推进，但当前市场状态不支持实盘候选订单生成。', {
              signalId: candidate.signal.id,
              side: candidate.action,
            })
            skippedCount += 1
            continue
          }
          const intentResult = buildOrderIntent(candidate.decision, account, candidate.position, candidate.marketData, orderSession, candidate.signal.id, tradeStrategy)
          if (!intentResult.intent) {
            liveOrderQueueService.recordSkipped(candidate.ticker, intentResult.blockedReason ?? '组合策略候选未通过后端硬风控，未进入待确认队列。', {
              signalId: candidate.signal.id,
              side: candidate.action,
            })
            skippedCount += 1
            logger.warn(
              {
                event: 'live.candidate_pool.risk_blocked',
                ...decisionLogMeta(candidate.ticker),
                candidateId: candidate.candidateId,
                signalId: candidate.signal.id,
                side: candidate.action,
                blockedReason: intentResult.blockedReason,
              },
              'Live candidate pool promoted candidate blocked by risk control',
            )
            continue
          }
          const pendingOrder = liveCandidatePoolService.decoratePendingOrder(
            pendingOrderFromIntent(intentResult.intent, candidate.signal, candidate.decision),
            candidate,
          )
          if (marketFailureReason) {
            const failedOrder = liveOrderQueueService.recordFailedPendingOrder(
              pendingOrder,
              failedPendingOrderResult(pendingOrder, marketFailureReason),
            )
            logger.warn(
              {
                event: 'live.candidate_pool.pending_order.submit_failed_by_market',
                ...decisionLogMeta(candidate.ticker),
                candidateId: candidate.candidateId,
                portfolioDecisionId: candidate.portfolioDecisionId,
                portfolioRank: candidate.portfolioRank,
                signalId: candidate.signal.id,
                pendingOrderId: failedOrder.id,
                side: failedOrder.intent.side,
                orderSession: failedOrder.intent.orderSession,
                marketState: marketSession?.state,
                reason: marketFailureReason,
              },
              'Live candidate pool promoted candidate recorded as failed pending order by market state',
            )
            continue
          }
          await this.createOrAutoSubmitPendingOrder(pendingOrder)
          pendingCount += 1
          logger.info(
            {
              event: getFutuLiveSettings().autoSubmitEnabled && getFutuLiveSettings().liveTradingEnabled ? 'live.candidate_pool.pending_order.created_auto_submit_requested' : 'live.candidate_pool.pending_order.created',
              ...decisionLogMeta(candidate.ticker),
              candidateId: candidate.candidateId,
              portfolioDecisionId: candidate.portfolioDecisionId,
              portfolioRank: candidate.portfolioRank,
              signalId: candidate.signal.id,
              pendingOrderId: pendingOrder.id,
              side: pendingOrder.intent.side,
              quantity: pendingOrder.intent.quantity,
            },
            'Live candidate pool pending order created',
          )
        }
      } else {
        logger.info({ event: 'live.candidate_pool.review_skipped', reason: 'no active candidates' }, 'Live candidate pool review skipped')
      }
    }

    this.engine = {
      ...this.engine,
      pendingOrderCount: liveOrderQueueService.activePendingOrders().length,
    }
    logger.info({ event: 'live.run_once.completed', durationMs: durationMs(runStartedAt), pendingCount, skippedCount }, 'Live run completed')
    return this.dashboard()
  }

  private getEngine(): LiveEngineStatus {
    return {
      ...this.engine,
      universe: [...this.engine.universe],
      pendingOrderCount: liveOrderQueueService.activePendingOrders().length,
      submittedOrderCount: liveOrderQueueService.latestSubmittedOrders().filter((order) => order.ok).length,
      signalCount: liveOrderQueueService.latestSignals().length,
    }
  }

  private async createOrAutoSubmitPendingOrder(order: LivePendingOrder) {
    liveOrderQueueService.createPendingOrder(order)
    const settings = getFutuLiveSettings()
    if (!settings.autoSubmitEnabled) return order
    if (!settings.liveTradingEnabled) return order
    const result = await liveOrderQueueService.confirmPendingOrder(order.id, {
      confirmedBy: 'system',
      confirmationId: `futu-auto-${Date.now()}`,
      accountId: this.account?.selectedAccountId,
    })
    if (!result.ok) {
      logger.warn(
        {
          event: 'live.pending_order.auto_submit_failed',
          pendingOrderId: order.id,
          ticker: order.intent.ticker,
          side: order.intent.side,
          error: result.error,
          blockedByGate: result.blockedByGate,
        },
        'Live pending order auto submit failed',
      )
    }
    return result.order ?? order
  }

  private setRunning(accountId: string, universe: string[], runIntervalMs: number) {
    const now = new Date()
    this.engine = {
      ...this.engine,
      running: true,
      accountId,
      startedAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + runIntervalMs).toISOString(),
      universe,
      runIntervalMs,
      lastError: '',
    }
  }

  private setDataWindow(dataWindow: LlmDataWindowRecommendation) {
    this.engine = {
      ...this.engine,
      dataWindow,
      runIntervalMs: dataWindow.pollIntervalSeconds * 1000,
    }
  }

  private markRun(runIntervalMs: number) {
    const now = new Date()
    this.engine = {
      ...this.engine,
      lastRunAt: now.toISOString(),
      nextRunAt: this.engine.running ? new Date(now.getTime() + runIntervalMs).toISOString() : '',
    }
  }

  private setError(error: string) {
    this.engine = { ...this.engine, lastError: error }
  }

  private scheduleNextRun(delayMs: number) {
    if (!this.engine.running) return
    const scheduledAt = new Date()
    const nextRunAt = new Date(scheduledAt.getTime() + delayMs).toISOString()
    this.engine = {
      ...this.engine,
      nextRunAt,
    }
    logger.info(
      {
        event: 'live.timer.scheduled',
        delayMs,
        scheduledAt: scheduledAt.toISOString(),
        nextRunAt,
        accountId: this.engine.accountId,
        runIntervalMs: this.engine.runIntervalMs,
      },
      'Live trading next run scheduled',
    )
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.runOnce()
        .catch((error) => {
          this.setError(error instanceof Error ? error.message : '实盘评估引擎运行失败。')
          logger.error({ event: 'live.run_once.failed', error: errorMessage(error) }, 'Live run failed')
        })
        .finally(() => {
          if (this.engine.running) this.scheduleNextRun(DEFAULT_RUN_INTERVAL_MS)
        })
    }, delayMs)
  }
}

export const liveTradingEngine = new LiveTradingEngine()

export function emptyEngineStatus(): LiveEngineStatus {
  return {
    running: false,
    mode: 'REAL',
    accountId: '',
    startedAt: '',
    lastRunAt: '',
    nextRunAt: '',
    universe: [],
    strategy: STRATEGY,
    runIntervalMs: DEFAULT_RUN_INTERVAL_MS,
    pendingOrderCount: 0,
    submittedOrderCount: 0,
    signalCount: 0,
    lastError: '',
  }
}

function pendingOrderFromIntent(intent: LiveOrderIntent, signal: QuantSignal, decision: LlmTradingDecision): LivePendingOrder {
  const now = new Date().toISOString()
  return {
    id: `${signal.id}-pending`,
    status: 'PENDING_CONFIRMATION',
    createdAt: now,
    updatedAt: now,
    intent,
    signal,
    llmDecision: decision,
    riskWarnings: riskWarningsForIntent(intent),
  }
}

function signalFromDecision(decision: LlmTradingDecision, updatedAt: string, runtimeConfig: LlmRuntimeConfig, trendContext?: TrendContextSummary): QuantSignal {
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
    source: 'futu-callback',
    rawModelOutput: decision.rawText,
  }
}

function dataWindowDescription(decision: LlmTradingDecision, updatedAt: string, trendContext?: TrendContextSummary): string {
  const execution = `${decision.dataWindowUsed.kline1mBars} x 1m K线 / ${decision.dataWindowUsed.tickerPoints} 分时点 / ${decision.dataWindowUsed.orderBookDepth} 档摆盘 @ ${updatedAt}`
  if (!trendContext) return execution
  const trend = trendContext.window.available
    ? `趋势: ${trendContext.window.lookbackTradingDays}日 ${trendContext.window.barInterval} K线 / ${trendContext.trendDirection} / ${trendContext.trendStrength}`
    : `趋势: 不可用 / ${trendContext.window.reason ?? trendContext.summary}`
  return `${execution}；${trend}`
}

function buildOrderIntent(
  decision: LlmTradingDecision,
  account: LiveAccountDashboardResponse,
  position: Position | undefined,
  marketData: Extract<ReturnType<typeof loadStrategyMarketData>, { ok: true }>,
  orderSession: LiveOrderIntent['orderSession'],
  signalId: string,
  tradeStrategy: TradeStrategyConfig,
): { intent?: LiveOrderIntent; blockedReason?: string } {
  if (decision.action !== 'BUY' && decision.action !== 'SELL_SHORT' && decision.action !== 'SELL_TO_CLOSE') {
    return { blockedReason: `动作 ${decision.action} 不支持生成实盘候选订单。` }
  }
  if (orderSession !== 'RTH' && decision.action === 'BUY' && positionQuantity(position) < 0) {
    // ETH short-cover uses a marketable limit order.
  }
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
    const blockedReason = openingRiskRejectionReason(
      account,
      decision,
      limitPrice,
      tradeStrategy,
      marketData.lotSize,
    )
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
      estimatedNotional: formatCurrencyMoney(
        decision.orderQuantity * limitPrice,
        account.summary.tradingCurrency ?? 'USD',
      ),
      feeContext: estimatePreTradeFee(
        decision.orderQuantity,
        limitPrice,
        account.summary.tradingCurrency ?? 'USD',
      ),
    },
  }
}

export function selectOrderTypeForDecision(
  decision: Pick<LlmTradingDecision, 'action'>,
  position: Pick<Position, 'quantity'> | undefined,
  orderSession: LiveOrderIntent['orderSession'],
): LiveOrderIntent['orderType'] {
  if (decision.action === 'BUY' && positionQuantity(position as Position | undefined) < 0 && orderSession === 'RTH') return 'MARKET'
  return 'MARKETABLE_LIMIT'
}

export function orderSessionForMarket(marketSession?: MarketSessionStatus): LiveOrderIntent['orderSession'] | undefined {
  return orderSessionForMarketState(marketSession?.state)
}

export function closedHongKongMarketFailureReason(ticker: string, marketSession?: MarketSessionStatus): string | undefined {
  if (!isHongKongInstrument(ticker, marketSession)) return undefined
  const state = marketSession?.state?.toUpperCase()
  if (state === 'CLOSED' || state === 'REST' || state === 'WAITING_OPEN' || state === 'NONE') return '港股休市，组合裁决已推进但不能提交真实订单。'
  return undefined
}

function isHongKongInstrument(ticker: string, marketSession?: MarketSessionStatus): boolean {
  const upper = ticker.toUpperCase()
  return marketSession?.code?.toUpperCase().startsWith('HK.') === true || /^\d{5}$/.test(upper) || llmUniverseItem(upper)?.market === 'HK'
}

function failedPendingOrderResult(order: LivePendingOrder, error: string): LiveOrderResult {
  const submittedAt = new Date().toISOString()
  return {
    ok: false,
    orderId: `FAILED-${order.id}`,
    ticker: order.intent.ticker,
    side: order.intent.side,
    quantity: String(order.intent.quantity),
    orderType: order.intent.orderType,
    orderSession: order.intent.orderSession,
    limitPrice: formatMoney(order.intent.limitPrice),
    submittedAt,
    strategy: order.intent.strategy,
    signalId: order.signal.id,
    pendingOrderId: order.id,
    feeContext: order.intent.feeContext,
    llmDecision: order.llmDecision,
    error,
  }
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

function isLeveragedLongEtf(ticker: string): boolean {
  const item = llmUniverseItem(ticker)
  const market = item?.market ?? 'US'
  return market === 'US' && item?.assetType === 'ETF' && /\blong\b/i.test(item.leverageFactor ?? '') && /\d+x/i.test(item.leverageFactor ?? '')
}

function marketableLimitPrice(decision: LlmTradingDecision, marketData: Extract<ReturnType<typeof loadStrategyMarketData>, { ok: true }>): number {
  const slippage = MARKETABLE_LIMIT_SLIPPAGE_BPS / 10_000
  if (decision.action === 'BUY') {
    const reference = marketData.bestAsk && marketData.bestAsk > 0 ? marketData.bestAsk : decision.limitPrice
    return roundPrice(Math.max(decision.limitPrice, reference * (1 + slippage)))
  }
  const reference = marketData.bestBid && marketData.bestBid > 0 ? marketData.bestBid : decision.limitPrice
  return roundPrice(Math.min(decision.limitPrice, reference * (1 - slippage)))
}

export function openingRiskRejectionReason(
  account: LiveAccountDashboardResponse,
  decision: LlmTradingDecision,
  limitPrice: number,
  tradeStrategy: TradeStrategyConfig,
  lotSize?: number,
): string | undefined {
  const isHongKong = llmUniverseItem(decision.ticker)?.market === 'HK'
  if (isHongKong && (!Number.isFinite(lotSize) || Number(lotSize) <= 0)) {
    return '开仓风控被拦截：无法确认港股每手股数。'
  }
  const lotSizeFailure = openingLotSizeFailureReason({
    symbol: decision.ticker,
    action: decision.action,
    quantity: decision.orderQuantity,
    lotSize,
  })
  if (lotSizeFailure) return `开仓风控被拦截：${lotSizeFailure}`
  const equity = parseMoney(account.summary.totalAssetsInTradingCurrency) ?? parseMoney(account.summary.totalAssets) ?? parseMoney(account.summary.buyingPowerInTradingCurrency) ?? parseMoney(account.summary.buyingPower)
  const buyingPower = parseMoney(account.summary.buyingPowerInTradingCurrency) ?? parseMoney(account.summary.availableFundsInTradingCurrency) ?? parseMoney(account.summary.buyingPower) ?? equity
  const tradingCurrency = account.summary.tradingCurrency ?? 'USD'
  const notional = decision.orderQuantity * limitPrice
  const controls = tradeStrategy.riskControls
  const singleNameHardBlock = decision.action === 'SELL_SHORT' ? controls.shortExposure?.mode === 'hard_block' : controls.singleNameExposure?.mode === 'hard_block'
  const maxSingleNamePct = decision.action === 'SELL_SHORT' ? controls.shortExposure?.maxSingleNamePctEquity : controls.singleNameExposure?.maxPctEquity
  const buyingPowerPct = controls.buyingPowerProtection?.maxPctBuyingPower ?? 0.95
  const estimatedFeeContext = estimatePreTradeFee(
    decision.orderQuantity,
    limitPrice,
    tradingCurrency,
  )
  const estimatedFee = estimatedFeeContext.feeAmount ?? Infinity
  const feeRatio = estimatedFee / notional
  const maxFeeRatio = controls.feeDrag?.maxRoundTripFeePctNotional
  const leveragedLongEtfShortBlocked = decision.action === 'SELL_SHORT' && isLeveragedLongEtf(decision.ticker)
  const context = {
    event: 'live.risk.opening_evaluated',
    ...decisionLogMeta(decision.ticker),
    side: decision.action,
    quantity: decision.orderQuantity,
    limitPrice,
    notional,
    notionalText: formatCurrencyMoney(notional, tradingCurrency),
    tradingCurrency,
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
    leveragedLongEtfShortBlocked,
    strategyId: tradeStrategy.id,
  }
  if (leveragedLongEtfShortBlocked) {
    const item = llmUniverseItem(decision.ticker)
    const reason = `开仓风控被拦截：Futu REAL 美股实盘不支持卖空美股杠杆做多 ETF ${decision.ticker.toUpperCase()}（${item?.leverageFactor ?? 'leveraged long ETF'}），请改为 HOLD 或仅在已有多头时 SELL_TO_CLOSE。`
    logger.warn({ ...context, passed: false, blockedRule: 'leveraged_long_etf_short_unavailable', reason }, 'Live opening risk blocked')
    return reason
  }
  if (!equity || !buyingPower) {
    const reason = `开仓风控被拦截：${tradingCurrency} 账户权益或购买力不可用。`
    logger.warn({ ...context, passed: false, blockedRule: 'account_funds_unavailable', reason }, 'Live opening risk blocked')
    return reason
  }
  if (controls.minNotional?.mode === 'hard_block' && notional < controls.minNotional.amount) {
    const reason = `开仓风控被拦截：名义金额 ${formatCurrencyMoney(notional, tradingCurrency)} 低于最低开仓金额 ${formatCurrencyMoney(controls.minNotional.amount, tradingCurrency)}。`
    logger.warn({ ...context, passed: false, blockedRule: 'min_notional', reason }, 'Live opening risk blocked')
    return reason
  }
  if (singleNameHardBlock && maxSingleNamePct !== undefined && notional > equity * maxSingleNamePct) {
    const reason = `开仓风控被拦截：名义金额 ${formatCurrencyMoney(notional, tradingCurrency)} 超过当前策略 ${tradingCurrency} 单票权益硬上限 ${formatCurrencyMoney(equity * maxSingleNamePct, tradingCurrency)}（${(maxSingleNamePct * 100).toFixed(2)}%）。`
    logger.warn({ ...context, passed: false, blockedRule: 'single_name_hard_limit', reason }, 'Live opening risk blocked')
    return reason
  }
  if (controls.buyingPowerProtection?.mode !== 'off' && notional > buyingPower * buyingPowerPct) {
    const reason = `开仓风控被拦截：名义金额 ${formatCurrencyMoney(notional, tradingCurrency)} 超过 ${tradingCurrency} 可用购买力保护线 ${formatCurrencyMoney(buyingPower * buyingPowerPct, tradingCurrency)}。`
    logger.warn({ ...context, passed: false, blockedRule: 'buying_power_protection', reason }, 'Live opening risk blocked')
    return reason
  }
  if (maxFeeRatio !== undefined && controls.feeDrag?.mode !== 'off' && feeRatio > maxFeeRatio) {
    const reason = `开仓风控被拦截：估算往返费用 ${formatCurrencyMoney(estimatedFee, tradingCurrency)} 占名义金额 ${(feeRatio * 100).toFixed(2)}%，超过当前策略上限 ${(maxFeeRatio * 100).toFixed(2)}%。`
    logger.warn({ ...context, passed: false, blockedRule: 'fee_drag', reason }, 'Live opening risk blocked')
    return reason
  }
  logger.info({ ...context, passed: true }, 'Live opening risk passed')
  return undefined
}

function riskWarningsForIntent(intent: LiveOrderIntent): string[] {
  const warnings = ['真实订单必须人工二次确认后才会提交。', '提交前费用为估算值，成交后从 Futu REAL 回填真实费用。']
  if (intent.side === 'SELL_SHORT') warnings.unshift('SELL_SHORT 为实盘卖空，存在保证金、强平和无限亏损风险。')
  return warnings
}

async function waitForRealtimeWarmup(universe: string[]) {
  const deadline = Date.now() + WARMUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const readyCount = universe.filter((ticker) => loadStrategyMarketData(ticker, 30).ok).length
    if (readyCount > 0) return
    await sleep(1000)
  }
}

async function refreshRealtimeIfActiveCacheStale(activeUniverse: string[], dataWindow: LlmDataWindowRecommendation) {
  const staleTickers: { ticker: string; reason: string }[] = []
  for (const ticker of activeUniverse) {
    const marketData = loadStrategyMarketData(ticker, effectiveDataWindowForTicker(ticker, dataWindow))
    if (marketData.ok === false && isFutuRealtimeCacheStaleReason(marketData.reason)) {
      staleTickers.push({ ticker: ticker.toUpperCase(), reason: marketData.reason })
    }
  }
  if (!staleTickers.length) return

  logger.warn(
    {
      event: 'live.realtime_cache.stale_refresh_requested',
      staleCount: staleTickers.length,
      staleTickers: staleTickers.map((item) => item.ticker),
      reasonPreview: staleTickers[0]?.reason,
    },
    'Futu realtime cache is stale; refreshing subscriptions before LLM evaluation',
  )
  realtimeSubscriptionService.refresh(activeUniverse)
  const refreshedCount = await waitForRealtimeFreshness(staleTickers.map((item) => item.ticker), dataWindow)
  logger.info(
    {
      event: 'live.realtime_cache.stale_refresh_completed',
      staleCount: staleTickers.length,
      refreshedCount,
      remainingStaleTickers: staleTickers
        .map((item) => item.ticker)
        .filter((ticker) => {
          const marketData = loadStrategyMarketData(ticker, effectiveDataWindowForTicker(ticker, dataWindow))
          return marketData.ok === false && isFutuRealtimeCacheStaleReason(marketData.reason)
        }),
    },
    'Futu realtime cache refresh completed',
  )
}

async function waitForRealtimeFreshness(tickers: string[], dataWindow: LlmDataWindowRecommendation): Promise<number> {
  const deadline = Date.now() + WARMUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const refreshedCount = tickers.filter((ticker) => {
      const marketData = loadStrategyMarketData(ticker, effectiveDataWindowForTicker(ticker, dataWindow))
      return marketData.ok || (marketData.ok === false && !isFutuRealtimeCacheStaleReason(marketData.reason))
    }).length
    if (refreshedCount === tickers.length) return refreshedCount
    await sleep(1000)
  }
  return tickers.filter((ticker) => {
    const marketData = loadStrategyMarketData(ticker, effectiveDataWindowForTicker(ticker, dataWindow))
    return marketData.ok || (marketData.ok === false && !isFutuRealtimeCacheStaleReason(marketData.reason))
  }).length
}

function isFutuRealtimeCacheStaleReason(reason: string): boolean {
  return reason.startsWith(FUTU_REALTIME_STALE_REASON_PREFIX) || reason.includes('Futu 实时缓存缺少更新时间') || reason.includes('缺少 Futu 实时回调缓存')
}

export function stockPositionsByTicker(positions: Position[]): Map<string, Position> {
  const result = new Map<string, Position>()
  for (const position of positions) {
    if (!isDirectEquityPosition(position)) continue
    const ticker = (position.underlyingTicker || position.ticker).toUpperCase()
    if (!isInLlmSimulationUniverse(ticker)) continue
    result.set(ticker, position)
  }
  return result
}

function isDirectEquityPosition(position: Position): boolean {
  if (position.assetType === 'STOCK' || position.assetType === 'ETF') return true
  if (position.assetType === 'OPTION') return false
  const optionType = String(position.optionType ?? '').toUpperCase()
  if (optionType === 'CALL' || optionType === 'PUT') return false
  const ticker = position.ticker.toUpperCase()
  const underlying = (position.underlyingTicker || position.ticker).toUpperCase()
  return ticker === underlying
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
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
    reason: '实盘引擎第一版使用与模拟盘一致的默认窗口。',
    source: 'fallback',
  }
}

function effectiveDataWindowForTicker(ticker: string, dataWindow: LlmDataWindowRecommendation): LlmDataWindowRecommendation & { maxCacheAgeMs: number } {
  const snapshot = realtimeStore.snapshot(ticker)
  return {
    ...dataWindow,
    kline1mBars: effectiveWindowSize(dataWindow.kline1mBars, snapshot.klineBars.length, 30),
    tickerPoints: effectiveWindowSize(dataWindow.tickerPoints, snapshot.tickerPoints.length, 60),
    orderBookDepth: effectiveWindowSize(dataWindow.orderBookDepth, Math.min(snapshot.asks.length, snapshot.bids.length), 1),
    maxCacheAgeMs: FUTU_REALTIME_CACHE_MAX_AGE_MS,
  }
}

function effectiveWindowSize(requested: number, available: number, minimum: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return minimum
  if (!Number.isFinite(available) || available <= 0) return Math.min(requested, minimum)
  return Math.min(requested, Math.max(minimum, available))
}

function marketSessionSkipsFromRealtime(
  tickers: string[],
  runtimeConfig: LlmRuntimeConfig,
  marketSessions: Record<string, MarketSessionStatus>,
): { ticker: string; marketState?: string; reason: string }[] {
  return tickers.flatMap((ticker) => {
    const normalized = ticker.toUpperCase()
    const snapshot = realtimeStore.snapshot(normalized)
    const marketState = marketSessions[normalized]?.state ?? snapshot.quote?.marketState
    const reason = liveEvaluationSkipReason({ ticker: normalized, marketState, disableUsOvernightLlm: runtimeConfig.disableUsOvernightLlm })
    if (!reason) return []
    return [{ ticker: normalized, marketState, reason }]
  })
}

function evaluationMarketStates(
  tickers: string[],
  marketSessions: Record<string, MarketSessionStatus>,
) {
  return tickers.map((ticker) => {
    const normalized = ticker.toUpperCase()
    const snapshot = realtimeStore.snapshot(normalized)
    const session = marketSessions[normalized]
    return {
      ticker: normalized,
      marketState: session?.state ?? snapshot.quote?.marketState,
      updatedAt: session?.updatedAt ?? snapshot.quote?.updatedAt,
    }
  })
}

function positionQuantity(position?: Pick<Position, 'quantity'>): number {
  if (!position) return 0
  const value = Number(position.quantity.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(value) ? value : 0
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`
}

function formatCurrencyMoney(value: number, currency: string): string {
  return `${currency === 'HKD' ? 'HK$' : '$'}${value.toFixed(2)}`
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emptyAccount(): LiveAccountDashboardResponse {
  const timestamp = new Date().toISOString()
  return {
    ok: false,
    summary: {
      accountId: 'unavailable',
      currency: 'USD',
      totalAssets: 'unavailable',
      cash: 'unavailable',
      availableFunds: 'unavailable',
      buyingPower: 'unavailable',
      dailyPnL: 'unavailable',
      totalPnL: 'unavailable',
      source: { source: 'Futu OpenD Account', accessedAt: timestamp, timestamp },
    },
    positions: [],
    risk: {
      concentrationRisk: 'unavailable',
      largestPosition: 'unavailable',
      cashRatio: 'unavailable',
      top30Overlap: 'unavailable',
      warnings: [],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: 'Live account not loaded.',
    },
    missingCapabilities: ['实盘账户尚未加载。'],
    selectedAccountId: 'unavailable',
    warnings: ['实盘账户尚未加载。'],
  }
}
