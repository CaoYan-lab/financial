import type { LiveAccountDashboardResponse, LiveEngineStatus, LiveOrderIntent, LivePendingOrder, LiveSignalHistoryItem, LlmDataWindowRecommendation, LlmTradingDecision, QuantStrategyName, TrendContextSummary } from '../../shared/types.js'
import type { LongbridgeLiveRunOnceResponse, LongbridgeLiveTradingDashboardResponse, LongbridgeSourceStatusResponse } from '../../shared/longbridgeTypes.js'
import { requestLivePortfolioReviewDecision } from '../live/livePortfolioReviewDecisionService.js'
import { getActiveArkModel, getActiveDecisionConcurrency, getActiveLlmModelOption, getLlmRuntimeConfig } from '../simulation/llmRuntimeConfigService.js'
import { llmRequestPacingPlan, waitForLlmRequestSlot, type LlmRequestPacingBatch } from '../simulation/llmRequestPacing.js'
import { llmSimulationTickers } from '../simulation/simulationUniverse.js'
import { llmMarketSessionSkipReason, orderSessionForMarketState } from '../simulation/usOvernightLlmGate.js'
import { getActiveLivePortfolioReviewPrompt, getTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import { logger } from '../utils/logger.js'
import { loadLongbridgeLiveAccountDashboard, loadLongbridgeSourceStatus } from './longbridgeAdapter.js'
import { longbridgeCandidatePoolService } from './longbridgeCandidatePoolService.js'
import { estimateLongbridgePreTradeFee } from './longbridgeFeeService.js'
import { requestLongbridgeLiveTradingDecision } from './longbridgeLiveDecisionService.js'
import { ensureLongbridgeRealtimeSubscriptions, loadLongbridgeRealtimeStrategyMarketData, loadLongbridgeRealtimeTrendContext } from './longbridgeRealtimeDataAdapter.js'
import { longbridgeRealtimeStore } from './longbridgeRealtimeStore.js'
import { longbridgeOrderQueueService } from './longbridgeOrderQueueService.js'
import { longbridgePersistence } from './longbridgePersistence.js'
import { getLongbridgeLiveSettings } from './longbridgeLiveSettings.js'
import { longbridgeOpeningRiskRejectionReason } from './longbridgeRiskService.js'
import { listManagedOrders } from '../cloud/state/managedOrderStore.js'
import { hasManagedOrderConflict } from '../live/managedOrderPolicy.js'

const STRATEGY: QuantStrategyName = 'LLM_AUTONOMOUS_STOCK_TRADER'
const DEFAULT_RUN_INTERVAL_MS = 60_000
const LIVE_TIMER_PHASE_OFFSET_MS = Number(process.env.LONGBRIDGE_LIVE_TRADING_TIMER_OFFSET_MS || process.env.LIVE_TRADING_TIMER_OFFSET_MS || 30_000)
const LONGBRIDGE_LIVE_EVALUATION_CONCURRENCY = Math.max(1, Number(process.env.LONGBRIDGE_LIVE_EVALUATION_CONCURRENCY || 1))
const LONG_BRIDGE_START_SOURCE_TIMEOUT_MS = Math.max(5_000, Number(process.env.LONGBRIDGE_LIVE_START_SOURCE_TIMEOUT_MS || 20_000) || 20_000)
const DEFAULT_DATA_WINDOW: LlmDataWindowRecommendation = {
  kline1mBars: 120,
  tickerPoints: 240,
  orderBookDepth: 5,
  pollIntervalSeconds: 60,
  trendLookbackTradingDays: 7,
  trendBarInterval: '30m',
  strategyHorizon: 'SWING_1_TO_7_DAYS',
  source: 'fallback',
  reason: 'Longbridge dry-run default data window.',
}

class LongbridgeLiveTradingEngine {
  private scanTimer?: NodeJS.Timeout
  private reviewTimer?: NodeJS.Timeout
  private starting = false
  private runInFlight = false
  private account?: LiveAccountDashboardResponse
  private engine: LiveEngineStatus = emptyLongbridgeEngineStatus()

  async start(): Promise<LongbridgeLiveTradingDashboardResponse> {
    if (this.scanTimer || this.reviewTimer || this.starting || this.engine.running) return this.dashboard()
    this.starting = true
    try {
      const sourceStatus = await withTimeout(loadLongbridgeSourceStatus(), LONG_BRIDGE_START_SOURCE_TIMEOUT_MS, '长桥授权状态读取超时，启动已中止。')
        .catch((error) => {
          this.setError(error instanceof Error ? error.message : '长桥授权状态读取失败，启动已中止。')
          return undefined
        })
      if (!sourceStatus) return this.dashboard()
      if (!sourceStatus.accountDataAvailable) {
        this.setError(sourceStatus.missingCapabilities[0] ?? '长桥账户不可用，无法启动实盘评估。')
        return this.dashboard()
      }
      const account = bootstrapLongbridgeAccount(sourceStatus)
      this.account = account
      const universe = llmSimulationTickers()
      this.setRunning(account.selectedAccountId, universe, this.currentRunIntervalMs())
      this.bootstrapAfterStart(account, universe).catch((error) => {
        this.setError(error instanceof Error ? error.message : '长桥实盘启动后台初始化失败。')
      })
      return this.dashboard()
    } finally {
      this.starting = false
    }
  }

  stop(): LongbridgeLiveTradingDashboardResponse {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = undefined
    }
    if (this.reviewTimer) {
      clearTimeout(this.reviewTimer)
      this.reviewTimer = undefined
    }
    this.starting = false
    this.engine = { ...this.engine, running: false, nextRunAt: '' }
    return this.dashboard()
  }

  async runPoolOnceDryRun(options: { reviewAfterCandidate?: boolean } = {}): Promise<LongbridgeLiveTradingDashboardResponse> {
    if (this.runInFlight) return this.dashboard()
    this.runInFlight = true
    try {
      const universe = this.engine.universe.length ? this.engine.universe : llmSimulationTickers()
      await ensureLongbridgeRealtimeSubscriptions(universe, { waitForSeed: true, requiredKlineCount: DEFAULT_DATA_WINDOW.kline1mBars })
      const account = await loadLongbridgeLiveAccountDashboard()
      this.account = account
      const runtimeConfig = getLlmRuntimeConfig().config
      const marketSessionSkipped = marketSessionSkipsFromLongbridgeCache(universe, runtimeConfig.disableUsOvernightLlm)
      const skippedByGate = new Set(marketSessionSkipped.flatMap((item) => [item.ticker, item.symbol]).map((item) => item.toUpperCase()))
      for (const skipped of marketSessionSkipped) {
        recordLongbridgeSkipped(skipped.ticker, skipped.reason)
        logger.info(
          { event: 'longbridge.live.market_session_llm_skipped_preflight', symbol: skipped.symbol, ticker: skipped.ticker, marketState: skipped.marketState, reason: skipped.reason },
          'Longbridge live ticker skipped by market-session LLM preflight gate',
        )
      }
      const activeUniverse = universe.filter((ticker) => !skippedByGate.has(ticker.toUpperCase()))
      const llmConcurrency = getActiveDecisionConcurrency(activeUniverse.length)
      const concurrency = Math.min(llmConcurrency, LONGBRIDGE_LIVE_EVALUATION_CONCURRENCY)
      const llmPacingBatch = { batchStartedAt: performance.now(), totalRequests: activeUniverse.length }
      logger.info(
        {
          event: 'longbridge.live.llm_batch.started',
          universeCount: universe.length,
          activeUniverseCount: activeUniverse.length,
          marketSessionSkippedCount: marketSessionSkipped.length,
          concurrency,
          llmConcurrency,
          marketDataConcurrencyCap: LONGBRIDGE_LIVE_EVALUATION_CONCURRENCY,
          llmRequestPacing: llmRequestPacingPlan(activeUniverse.length),
        },
        'Longbridge live LLM batch started',
      )
      await mapLimit(activeUniverse, concurrency, async (ticker, requestIndex) => this.runOnceDryRun(ticker, { reviewAfterCandidate: options.reviewAfterCandidate ?? false, ensureRealtime: false, account, llmPacingBatch, requestIndex }))
      this.markRun(this.currentRunIntervalMs())
      return this.dashboard()
    } finally {
      this.runInFlight = false
    }
  }

  async runOnceDryRun(symbol = 'AAPL.US', options: { reviewAfterCandidate?: boolean; ensureRealtime?: boolean; account?: LiveAccountDashboardResponse; llmPacingBatch?: LlmRequestPacingBatch; requestIndex?: number } = { reviewAfterCandidate: true, ensureRealtime: true }): Promise<LongbridgeLiveRunOnceResponse> {
    const warnings: string[] = []
    const account = options.account ?? (await loadLongbridgeLiveAccountDashboard())
    const managedOpenOrders = await listManagedOrders('longbridge', true)
    this.account = account
    warnings.push(...account.warnings)
    if (options.ensureRealtime ?? true) await ensureLongbridgeRealtimeSubscriptions([symbol], { waitForSeed: true, requiredKlineCount: DEFAULT_DATA_WINDOW.kline1mBars })
    const marketData = await loadLongbridgeRealtimeStrategyMarketData(symbol, {
      klineCount: DEFAULT_DATA_WINDOW.kline1mBars,
      includeDepth: true,
      includeTrades: true,
    })
    warnings.push(...marketData.warnings)
    const executionMode = getTradeStrategyRuntimeConfig('live').selection.executionMode

    if (!marketData.ok) {
      const reason = 'reason' in marketData ? marketData.reason : 'Longbridge market data unavailable'
      recordLongbridgeSkipped(symbol, reason)
      logger.warn({ event: 'longbridge.live.ticker.skipped_before_llm', symbol, reason }, 'Longbridge live ticker skipped before LLM decision')
      return {
        ok: false,
        symbol,
        marketData,
        candidatePool: longbridgeCandidatePoolService.snapshot(executionMode),
        pendingOrders: longbridgeOrderQueueService.activePendingOrders(),
        warnings: [...warnings, reason],
      }
    }

    const dataWindow = effectiveDataWindow(marketData)
    const sessionSkipReason = llmMarketSessionSkipReason({ ticker: marketData.ticker, marketState: marketData.marketState, disableUsOvernightLlm: getLlmRuntimeConfig().config.disableUsOvernightLlm })
    if (sessionSkipReason) {
      warnings.push(sessionSkipReason)
      recordLongbridgeSkipped(marketData.ticker, sessionSkipReason)
      logger.info({ event: 'longbridge.live.market_session_llm_skipped', symbol: marketData.symbol, ticker: marketData.ticker, marketState: marketData.marketState, reason: sessionSkipReason }, 'Longbridge live ticker skipped by market-session LLM gate')
      return {
        ok: false,
        symbol,
        marketData,
        candidatePool: longbridgeCandidatePoolService.snapshot(executionMode),
        pendingOrders: longbridgeOrderQueueService.activePendingOrders(),
        warnings,
      }
    }
    const trendContext = await loadLongbridgeRealtimeTrendContext(marketData.symbol, {
      lookbackTradingDays: dataWindow.trendLookbackTradingDays ?? 7,
      barInterval: dataWindow.trendBarInterval ?? '30m',
      currentPrice: marketData.lastPrice,
    })
    if (!trendContext.window.available) warnings.push(trendContext.window.reason ?? trendContext.summary)

    if (options.llmPacingBatch && options.requestIndex !== undefined) await waitForLlmRequestSlot({ index: options.requestIndex, ticker: marketData.symbol, batch: options.llmPacingBatch })
    const decision = await requestLongbridgeLiveTradingDecision({
      symbol: marketData.symbol,
      account,
      marketData,
      dataWindow,
      trendContext,
      managedOpenOrders: managedOpenOrders.filter((order) => order.ticker.toUpperCase() === marketData.ticker.toUpperCase()),
    })
    const orderSession = orderSessionForMarketState(marketData.marketState)
    const managedConflict = hasManagedOrderConflict(managedOpenOrders, marketData.ticker)
    const riskRejectionReason = managedConflict
      ? `存在未终态系统挂单 ${managedConflict.orderId}，本轮禁止生成重复或反向订单。`
      : decision.ok && decision.approved && decision.action !== 'HOLD' && decision.orderQuantity > 0
        ? orderSession
          ? longbridgeOpeningRiskRejectionReason(account, decision, decision.limitPrice || marketData.lastPrice, getTradeStrategyRuntimeConfig('live').activeStrategy)
          : `当前市场状态 ${marketData.marketState || '不可用'} 只允许策略研究，不允许生成真实订单。`
        : undefined
    const signal = signalFromDecision(decision, marketData, trendContext, riskRejectionReason)
    longbridgePersistence.appendSignal(signal)

    if (riskRejectionReason) warnings.push(riskRejectionReason)

    if (!riskRejectionReason && decision.ok && decision.approved && decision.action !== 'HOLD' && decision.orderQuantity > 0) {
      if (executionMode === 'candidate_pool') {
        const candidate = longbridgeCandidatePoolService.upsert({ signal, decision, marketData })
          if (options.reviewAfterCandidate ?? true) {
            const promoted = await this.reviewCandidatePool(account)
            for (const promotedCandidate of promoted) {
              const candidateMarketData = promotedCandidate.marketData?.ok ? promotedCandidate.marketData : marketData
              const promotedOrderSession = orderSessionForMarketState(candidateMarketData.marketState)
              if (!promotedOrderSession) {
                recordLongbridgeSkipped(promotedCandidate.ticker, `组合裁决已推进，但当前市场状态 ${candidateMarketData.marketState || '不可用'} 不允许生成真实订单。`)
                continue
              }
              const pending = longbridgeCandidatePoolService.decoratePendingOrder(pendingOrderFromDecision(promotedCandidate.decision as LlmTradingDecision, promotedCandidate.signal, candidateMarketData, promotedOrderSession), promotedCandidate)
              await this.createOrAutoSubmitPendingOrder(pending)
            }
        } else {
          warnings.push(`候选 ${candidate.candidateId} 已进入长桥候选池，但当前没有可裁决候选。`)
        }
      } else {
        await this.createOrAutoSubmitPendingOrder(pendingOrderFromDecision(decision, signal, marketData, orderSession!))
      }
    }

    return {
      ok: decision.ok,
      symbol: marketData.symbol,
      signal,
      decision,
      marketData,
      candidatePool: longbridgeCandidatePoolService.snapshot(executionMode),
      pendingOrders: longbridgeOrderQueueService.activePendingOrders(),
      warnings,
    }
  }

  dashboard(): LongbridgeLiveTradingDashboardResponse {
    const executionMode = getTradeStrategyRuntimeConfig('live').selection.executionMode
    return {
      ok: true,
      engine: this.getEngine(),
      ...getLongbridgeLiveSettings(),
      signals: longbridgePersistence.latestSignals(),
      pendingOrders: longbridgeOrderQueueService.activePendingOrders(),
      candidatePool: longbridgeCandidatePoolService.snapshot(executionMode),
      warnings: [],
      updatedAt: new Date().toISOString(),
    }
  }

  resetForTests() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = undefined
    }
    if (this.reviewTimer) {
      clearTimeout(this.reviewTimer)
      this.reviewTimer = undefined
    }
    this.starting = false
    this.runInFlight = false
    this.engine = emptyLongbridgeEngineStatus()
    longbridgePersistence.clearForTests()
  }

  private currentRunIntervalMs() {
    const runtime = getTradeStrategyRuntimeConfig('live')
    if (runtime.selection.executionMode !== 'candidate_pool') return DEFAULT_RUN_INTERVAL_MS
    const prompt = getActiveLivePortfolioReviewPrompt()
    const preset = prompt.timingPresets.find((item) => item.id === runtime.selection.portfolioTimingPresetId) ?? prompt.timingPresets.find((item) => item.id === prompt.defaultPresetId) ?? prompt.timingPresets[0]
    return Math.max(1, preset.singleSignalScanIntervalMinutes) * 60_000
  }

  private currentReviewIntervalMs() {
    const runtime = getTradeStrategyRuntimeConfig('live')
    const prompt = getActiveLivePortfolioReviewPrompt()
    const preset = prompt.timingPresets.find((item) => item.id === runtime.selection.portfolioTimingPresetId) ?? prompt.timingPresets.find((item) => item.id === prompt.defaultPresetId) ?? prompt.timingPresets[0]
    return Math.max(1, preset.portfolioReviewIntervalMinutes) * 60_000
  }

  private async reviewCandidatePool(accountInput?: LiveAccountDashboardResponse) {
    const reviewCandidates = longbridgeCandidatePoolService.reviewCandidates()
    if (!reviewCandidates.length) return []
    const account = accountInput ?? this.account ?? (await loadLongbridgeLiveAccountDashboard())
    this.account = account
    const prompt = getActiveLivePortfolioReviewPrompt()
    const runtime = getTradeStrategyRuntimeConfig('live')
    const managedOpenOrders = await listManagedOrders('longbridge', true)
    const preset = prompt.timingPresets.find((item) => item.id === runtime.selection.portfolioTimingPresetId) ?? prompt.timingPresets.find((item) => item.id === prompt.defaultPresetId) ?? prompt.timingPresets[0]
    const review = await requestLivePortfolioReviewDecision({
      candidates: reviewCandidates,
      account,
      positions: account.positions,
      pendingOrders: [
        ...longbridgeOrderQueueService.activePendingOrders().map((order) => ({ id: order.id, ticker: order.intent.ticker, side: order.intent.side, createdAt: order.createdAt })),
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
        maxPromotedOrdersPerReview: preset.maxPromotedOrdersPerReview,
        minSignalConfirmations: preset.minSignalConfirmations,
        leveragedEtfCooldownMinutes: preset.leveragedEtfCooldownMinutes,
        sameGroupMutualExclusion: false,
        humanConfirmationRequired: true,
      },
    })
    return review.ok ? longbridgeCandidatePoolService.applyReview(review) : []
  }

  private async bootstrapAfterStart(account: LiveAccountDashboardResponse, universe: string[]) {
    const startedAt = performance.now()
    logger.info({ event: 'longbridge.live.start.bootstrap_started', universeCount: universe.length }, 'Longbridge live start bootstrap started')
    await ensureLongbridgeRealtimeSubscriptions(universe, { waitForSeed: false, requiredKlineCount: DEFAULT_DATA_WINDOW.kline1mBars })
    if (!this.engine.running) return
    await this.runPoolOnceDryRun({ reviewAfterCandidate: false })
    if (!this.engine.running) return
    if (getTradeStrategyRuntimeConfig('live').selection.executionMode === 'candidate_pool') await this.reviewCandidatePool(account)
    if (!this.engine.running) return
    if (!this.scanTimer) this.scheduleNextScan(LIVE_TIMER_PHASE_OFFSET_MS)
    if (!this.reviewTimer && getTradeStrategyRuntimeConfig('live').selection.executionMode === 'candidate_pool') this.scheduleNextReview(this.currentReviewIntervalMs())
    logger.info({ event: 'longbridge.live.start.bootstrap_completed', universeCount: universe.length, durationMs: Math.round(performance.now() - startedAt) }, 'Longbridge live start bootstrap completed')
  }

  private async createOrAutoSubmitPendingOrder(order: LivePendingOrder) {
    longbridgeOrderQueueService.createPendingOrder(order)
    const settings = getLongbridgeLiveSettings()
    if (!settings.autoSubmitEnabled) return order
    if (!settings.liveTradingEnabled) return order
    await longbridgeOrderQueueService.confirmPendingOrder(order.id, {
      confirmedBy: 'system',
      confirmationId: `longbridge-auto-${Date.now()}`,
    })
    return order
  }

  private setRunning(accountId: string, universe: string[], runIntervalMs: number) {
    const now = new Date()
    this.engine = {
      ...this.engine,
      running: true,
      accountId,
      startedAt: this.engine.startedAt || now.toISOString(),
      universe,
      runIntervalMs,
      nextRunAt: new Date(now.getTime() + runIntervalMs).toISOString(),
      lastError: '',
    }
  }

  private markRun(runIntervalMs: number) {
    const now = new Date()
    const pendingOrders = longbridgeOrderQueueService.activePendingOrders()
    const signals = longbridgePersistence.latestSignals()
    this.engine = {
      ...this.engine,
      runIntervalMs,
      lastRunAt: now.toISOString(),
      nextRunAt: this.engine.running ? new Date(now.getTime() + runIntervalMs).toISOString() : '',
      pendingOrderCount: pendingOrders.length,
      signalCount: signals.length,
      submittedOrderCount: 0,
      lastError: '',
    }
  }

  private setError(message: string) {
    this.engine = { ...this.engine, lastError: message, running: false, nextRunAt: '' }
  }

  private getEngine() {
    const pendingOrders = longbridgeOrderQueueService.activePendingOrders()
    const signals = longbridgePersistence.latestSignals()
    return {
      ...this.engine,
      universe: this.engine.universe.length ? this.engine.universe : llmSimulationTickers(),
      pendingOrderCount: pendingOrders.length,
      signalCount: signals.length,
    }
  }

  private scheduleNextScan(delayMs: number) {
    if (!this.engine.running) return
    const nextRunAt = new Date(Date.now() + delayMs).toISOString()
    this.engine = { ...this.engine, nextRunAt, runIntervalMs: this.currentRunIntervalMs() }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined
      this.runPoolOnceDryRun({ reviewAfterCandidate: false })
        .catch((error) => {
          this.setError(error instanceof Error ? error.message : '长桥实盘评估引擎运行失败。')
        })
        .finally(() => {
          if (this.engine.running) this.scheduleNextScan(this.currentRunIntervalMs())
        })
    }, delayMs)
  }

  private scheduleNextReview(delayMs: number) {
    if (!this.engine.running || getTradeStrategyRuntimeConfig('live').selection.executionMode !== 'candidate_pool') return
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = undefined
        this.reviewCandidatePool()
          .then(async (promoted) => {
          for (const candidate of promoted) {
            if (!candidate.marketData?.ok) continue
            const orderSession = orderSessionForMarketState(candidate.marketData.marketState)
            if (!orderSession) {
              recordLongbridgeSkipped(candidate.ticker, `组合裁决已推进，但当前市场状态 ${candidate.marketData.marketState || '不可用'} 不允许生成真实订单。`)
              continue
            }
            const pending = longbridgeCandidatePoolService.decoratePendingOrder(pendingOrderFromDecision(candidate.decision as LlmTradingDecision, candidate.signal, candidate.marketData, orderSession), candidate)
            await this.createOrAutoSubmitPendingOrder(pending)
          }
          this.markRun(this.currentRunIntervalMs())
        })
        .catch((error) => {
          this.setError(error instanceof Error ? error.message : '长桥组合裁决运行失败。')
        })
        .finally(() => {
          if (this.engine.running && getTradeStrategyRuntimeConfig('live').selection.executionMode === 'candidate_pool') this.scheduleNextReview(this.currentReviewIntervalMs())
        })
    }, delayMs)
  }
}

export const longbridgeLiveTradingEngine = new LongbridgeLiveTradingEngine()

function signalFromDecision(decision: LlmTradingDecision, marketData: Extract<Awaited<ReturnType<typeof loadLongbridgeRealtimeStrategyMarketData>>, { ok: true }>, trendContext?: TrendContextSummary, riskRejectionReason?: string): LiveSignalHistoryItem {
  const now = new Date().toISOString()
  const modelOption = getActiveLlmModelOption()
  return {
    id: `longbridge-signal-${marketData.ticker}-${Date.now()}`,
    ticker: marketData.ticker,
    strategy: STRATEGY,
    model: getActiveArkModel(),
    modelLabel: modelOption.label,
    side: decision.action,
    confidence: decision.confidence,
    reason: decision.reason,
    price: formatMoney(marketData.lastPrice),
    quantity: String(decision.orderQuantity),
    limitPrice: formatMoney(decision.limitPrice || marketData.lastPrice),
    riskAssessment: decision.riskAssessment,
    generatedAt: now,
    dataWindow: dataWindowDescription(decision, marketData.updatedAt, trendContext),
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
    source: marketData.source,
    rawModelOutput: decision.rawText,
    lifecycleStatus: riskRejectionReason ? 'BLOCKED_BY_RISK' : decision.action === 'HOLD' ? 'HOLD' : 'CANDIDATE_POOL',
    lifecycleReason: riskRejectionReason ?? (decision.action === 'HOLD' ? '模型建议 HOLD。' : '长桥 dry-run 非观望信号。'),
  }
}

function pendingOrderFromDecision(
  decision: LlmTradingDecision,
  signal: LiveSignalHistoryItem,
  marketData: Extract<Awaited<ReturnType<typeof loadLongbridgeRealtimeStrategyMarketData>>, { ok: true }>,
  orderSession: LiveOrderIntent['orderSession'],
): LivePendingOrder {
  const now = new Date().toISOString()
  const intent: LiveOrderIntent = {
    ticker: decision.ticker,
    side: decision.action as Exclude<LlmTradingDecision['action'], 'HOLD'>,
    quantity: decision.orderQuantity,
    orderType: 'MARKETABLE_LIMIT',
    orderSession,
    limitPrice: decision.limitPrice || marketData.lastPrice,
    strategy: STRATEGY,
    signalId: signal.id,
    reason: decision.reason,
    estimatedNotional: formatMoney(decision.orderQuantity * (decision.limitPrice || marketData.lastPrice)),
    feeContext: estimateLongbridgePreTradeFee(decision.orderQuantity, decision.limitPrice || marketData.lastPrice, marketData.symbol),
  }
  return {
    id: `longbridge-pending-${decision.ticker}-${Date.now()}`,
    status: 'PENDING_CONFIRMATION',
    createdAt: now,
    updatedAt: now,
    intent,
    signal,
    llmDecision: decision,
    riskWarnings: [
      '长桥实盘 dry-run：该订单只进入长桥待确认队列，不会自动提交真实订单。',
      '真实提交接口当前受 LONGBRIDGE_LIVE_TRADING_ENABLED 门禁保护。',
    ],
    decisionMode: getTradeStrategyRuntimeConfig('live').selection.executionMode,
  }
}

function formatMoney(value: number) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : 'unavailable'
}

function effectiveDataWindow(marketData: { bars: unknown[]; tickerPoints: unknown[]; asks: unknown[]; bids: unknown[] }): LlmDataWindowRecommendation {
  return {
    ...DEFAULT_DATA_WINDOW,
    kline1mBars: effectiveWindowSize(DEFAULT_DATA_WINDOW.kline1mBars, marketData.bars.length, 30),
    tickerPoints: effectiveWindowSize(DEFAULT_DATA_WINDOW.tickerPoints, marketData.tickerPoints.length, 60),
    orderBookDepth: effectiveWindowSize(DEFAULT_DATA_WINDOW.orderBookDepth, Math.min(marketData.asks.length, marketData.bids.length), 1),
  }
}

function effectiveWindowSize(requested: number, available: number, minimum: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return minimum
  if (!Number.isFinite(available) || available <= 0) return Math.min(requested, minimum)
  return Math.min(requested, Math.max(minimum, available))
}

function marketSessionSkipsFromLongbridgeCache(
  symbols: string[],
  disableUsOvernightLlm: boolean,
): { symbol: string; ticker: string; marketState?: string; reason: string }[] {
  return symbols.flatMap((symbol) => {
    const snapshot = longbridgeRealtimeStore.getSnapshot(symbol)
    const ticker = (snapshot?.ticker ?? symbol).toUpperCase()
    const marketState = snapshot?.quote?.marketState
    const reason = llmMarketSessionSkipReason({ ticker, marketState, disableUsOvernightLlm })
    if (!reason) return []
    return [{ symbol: (snapshot?.symbol ?? symbol).toUpperCase(), ticker, marketState, reason }]
  })
}

function recordLongbridgeSkipped(ticker: string, reason: string) {
  longbridgePersistence.appendSkipped({
    ticker: normalizeLongbridgeSkippedTicker(ticker),
    reason,
    updatedAt: new Date().toISOString(),
  })
}

function normalizeLongbridgeSkippedTicker(ticker: string): string {
  const normalized = ticker.toUpperCase().trim()
  if (normalized.endsWith('.HK')) return normalized.replace('.HK', '').padStart(5, '0')
  if (normalized.endsWith('.US')) return normalized.replace('.US', '')
  return normalized
}

function bootstrapLongbridgeAccount(sourceStatus: LongbridgeSourceStatusResponse): LiveAccountDashboardResponse {
  const now = new Date().toISOString()
  return {
    ok: sourceStatus.accountDataAvailable,
    selectedAccountId: 'longbridge-real',
    summary: {
      accountId: 'longbridge-real',
      currency: 'USD',
      totalAssets: 'unavailable',
      cash: 'unavailable',
      availableFunds: 'unavailable',
      buyingPower: 'unavailable',
      tradingCurrency: 'USD',
      totalAssetsInTradingCurrency: 'unavailable',
      cashInTradingCurrency: 'unavailable',
      availableFundsInTradingCurrency: 'unavailable',
      buyingPowerInTradingCurrency: 'unavailable',
      dailyPnL: 'unavailable',
      totalPnL: 'unavailable',
      source: { source: 'Longbridge source status', accessedAt: now, timestamp: now },
    },
    positions: [],
    risk: {
      concentrationRisk: '启动后后台刷新账户资产',
      largestPosition: 'unavailable',
      cashRatio: 'unavailable',
      top30Overlap: 'unavailable',
      warnings: sourceStatus.missingCapabilities,
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: sourceStatus.tradingAvailable,
      requiresConfirmation: true,
      warning: sourceStatus.tradingAvailable ? '长桥真实提交门禁已开启。' : '长桥真实提交门禁关闭，本轮只允许 dry-run。',
    },
    missingCapabilities: sourceStatus.missingCapabilities,
    warnings: sourceStatus.missingCapabilities,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function dataWindowDescription(decision: LlmTradingDecision, updatedAt: string, trendContext?: TrendContextSummary): string {
  const execution = `${decision.dataWindowUsed.kline1mBars} x 1m K线 / ${decision.dataWindowUsed.tickerPoints} 分时点 / ${decision.dataWindowUsed.orderBookDepth} 档摆盘 @ ${updatedAt}`
  if (!trendContext) return execution
  const trend = trendContext.window.available
    ? `趋势: ${trendContext.window.lookbackTradingDays}日 ${trendContext.window.barInterval} Longbridge K线 / ${trendContext.trendDirection} / ${trendContext.trendStrength}`
    : `趋势: 不可用 / ${trendContext.window.reason ?? trendContext.summary}`
  return `${execution}；${trend}`
}

function emptyLongbridgeEngineStatus(): LiveEngineStatus {
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

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const workerCount = Math.max(1, Math.min(limit, items.length || 1))
  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index
      index += 1
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return results
}
