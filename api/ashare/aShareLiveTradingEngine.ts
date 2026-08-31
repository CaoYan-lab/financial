import { aShareRealtimeStore } from './aShareRealtimeStore.js'
import { aShareRealtimeSubscriptionService } from './aShareRealtimeSubscriptionService.js'
import { currentAshareSession } from './aShareMarketSessionGate.js'
import { getAshareUniverse } from './aShareUniverseService.js'
import { requestAshareDecision } from './aShareLiveDecisionService.js'
import { getAshareTradingAgentRuntimeStatus, requestAshareTradingAgentDecision } from './aShareTradingAgentService.js'
import { validateAshareDecision } from './aShareRiskService.js'
import { aShareCandidatePoolService } from './aShareCandidatePoolService.js'
import { aShareOrderQueueService } from './aShareOrderQueueService.js'
import { aShareTradingAgentRunService } from './aShareTradingAgentRunService.js'
import { buildAshareCandidatePoolConfig, getAshareDecisionConcurrency, getAshareLiveTradingConfig, getAshareTradeStrategyConfig, getAshareActiveArkModel, getAshareActiveLlmModelOption } from './aShareRuntimeConfigService.js'
import { requestLivePortfolioReviewDecision } from '../live/livePortfolioReviewDecisionService.js'
import { loadLiveAccountDashboard } from '../live/liveAccountService.js'
import type { LiveAccountDashboardResponse, LlmTradingDecision, QuantSignal } from '../../shared/types.js'
import type { AShareDashboardResponse } from './types.js'

const DEFAULT_RUN_INTERVAL_MS = Math.max(10_000, Number(process.env.ASHARE_LIVE_RUN_INTERVAL_MS ?? 60_000))
const START_SCAN_DELAY_MS = Math.max(2_000, Number(process.env.ASHARE_LIVE_START_SCAN_DELAY_MS ?? 8_000))

class AShareLiveTradingEngine {
  private running = false
  private runInFlight = false
  private scanTimer?: NodeJS.Timeout
  private startedAt?: string
  private lastRunAt?: string
  private nextRunAt?: string
  private lastError?: string
  private accountSnapshot: LiveAccountDashboardResponse = emptyAshareAccount()

  dashboard(): AShareDashboardResponse {
    const universe = getAshareUniverse().universe
    const tickers = universe.map((item) => item.ticker)
    let realtimeStatus = aShareRealtimeSubscriptionService.status()
    if (!realtimeStatus.running && universe.length) {
      aShareRealtimeSubscriptionService.start(universe.map((item) => item.futuCode))
      realtimeStatus = aShareRealtimeSubscriptionService.status()
    }
    const runtimeConfig = getAshareLiveTradingConfig()
    return {
      ok: true,
      engine: {
        running: this.running,
        startedAt: this.startedAt,
        lastRunAt: this.lastRunAt,
        nextRunAt: this.nextRunAt,
        lastError: this.lastError,
        universe: tickers,
      },
      universe,
      realtime: {
        running: realtimeStatus.running,
        subscribedTickers: realtimeStatus.subscribedTickers,
        startedAt: realtimeStatus.startedAt,
        lastEventAt: realtimeStatus.lastEventAt,
        lastError: realtimeStatus.lastError,
      },
      session: currentAshareSession(),
      account: this.accountSnapshot,
      readiness: universe.map((item) => {
        const snapshot = aShareRealtimeStore.snapshot(item.ticker)
        return {
          ticker: item.ticker,
          name: item.name,
          quoteReady: Boolean(snapshot.quote),
          tickerPoints: snapshot.tickerPoints.length,
          klineBars: snapshot.klineBars.length,
          orderBookReady: snapshot.asks.length > 0 || snapshot.bids.length > 0,
          lastPrice: snapshot.quote?.price,
          change: snapshot.quote?.change,
          changePercent: snapshot.quote?.changePercent,
          marketState: snapshot.quote?.marketState,
          updatedAt: snapshot.updatedAt,
        }
      }),
      llmRuntimeConfig: runtimeConfig.llmRuntimeConfig,
      modelOptions: runtimeConfig.modelOptions,
      tradeStrategyConfig: runtimeConfig.tradeStrategyConfig,
      tradingAgent: getAshareTradingAgentRuntimeStatus(),
      tradingAgentLlmConfig: runtimeConfig.tradingAgentLlmConfig,
      tradingAgentLlmPresets: runtimeConfig.tradingAgentLlmPresets,
      latestSignals: aShareOrderQueueService.latestSignals().slice(0, 50),
      latestAgentRuns: aShareTradingAgentRunService.latest(20),
      pendingOrders: aShareOrderQueueService.activePendingOrders().slice(0, 50),
      skippedTickers: aShareOrderQueueService.skippedTickers().slice(0, 50),
      candidatePool: buildAshareCandidatePoolConfig(),
      rules: [
        'A 股股票池、行情订阅和运行状态独立于现有 Futu / Longbridge。',
        '仅连续竞价时段评估：09:30-11:30 / 13:00-15:00。',
        '第一版只多头：允许 BUY 和 SELL_TO_CLOSE，禁止 SELL_SHORT。',
        'LLM 数据窗口目标为 120 根 1m K线、240 个 tickerPoints 和盘口。',
      ],
      updatedAt: new Date().toISOString(),
    }
  }

  start(): AShareDashboardResponse {
    if (this.running) {
      if (!this.scanTimer) this.scheduleNextScan(START_SCAN_DELAY_MS)
      return this.dashboard()
    }
    const universe = getAshareUniverse().universe
    this.running = true
    this.startedAt = this.startedAt ?? new Date().toISOString()
    this.lastError = undefined
    aShareRealtimeSubscriptionService.start(universe.map((item) => item.futuCode))
    this.scheduleNextScan(START_SCAN_DELAY_MS)
    return this.dashboard()
  }

  stop(): AShareDashboardResponse {
    this.running = false
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = undefined
    }
    this.nextRunAt = undefined
    aShareRealtimeSubscriptionService.stop()
    return this.dashboard()
  }

  async dashboardWithAccount(): Promise<AShareDashboardResponse> {
    await this.refreshAccountSnapshot()
    return this.dashboard()
  }

  async runOnce(): Promise<AShareDashboardResponse> {
    if (this.runInFlight) return this.dashboard()
    this.runInFlight = true
    try {
      this.lastRunAt = new Date().toISOString()
      const session = currentAshareSession()
      if (session.shouldSkipLlm) {
        this.lastError = session.reason
        for (const item of getAshareUniverse().universe) aShareOrderQueueService.recordSkipped(item.ticker, session.reason ?? 'A 股非连续竞价时段。')
        return this.dashboard()
      }
      const universe = getAshareUniverse().universe
      if (!this.running) aShareRealtimeSubscriptionService.start(universe.map((item) => item.futuCode))
      const tradeStrategyConfig = getAshareTradeStrategyConfig()
      const executionMode = tradeStrategyConfig.selection.executionMode
      if (executionMode !== 'candidate_pool') aShareCandidatePoolService.disableForModeSwitch()
      const concurrency = getAshareDecisionConcurrency(universe.length)
      const account = await this.refreshAccountSnapshot().catch(() => undefined)
      const positions = account?.positions ?? []
      await mapLimit(universe, concurrency, async (item) => {
        const snapshot = aShareRealtimeStore.snapshot(item.ticker)
        const readinessReason = readinessBlockReason(snapshot)
        if (readinessReason) {
          aShareOrderQueueService.recordSkipped(item.ticker, readinessReason)
          return
        }
        const decision = executionMode === 'trading_agent'
          ? await requestAshareTradingAgentDecision({ instrument: item, marketData: snapshot, session: session.session, positions, accountSummary: account?.summary })
          : await requestAshareDecision({ instrument: item, marketData: snapshot, session: session.session, positions, accountSummary: account?.summary })
        const signal = buildSignal(item.ticker, decision, snapshot)
        aShareOrderQueueService.addSignal(signal)
        if (!decision.ok) {
          aShareOrderQueueService.recordSkipped(item.ticker, decision.error ?? decision.reason, { signalId: signal.id, side: signal.side })
          return
        }
        if (decision.action === 'HOLD' || !decision.approved) return
        const risk = validateAshareDecision(decision.action, session.session, {
          ticker: item.ticker,
          orderQuantity: decision.orderQuantity,
          limitPrice: decision.limitPrice,
          positions,
          accountSummary: account?.summary,
        })
        if (!risk.ok) {
          aShareOrderQueueService.recordSkipped(item.ticker, risk.blockedReason ?? 'A 股风控拦截。', { signalId: signal.id, side: signal.side })
          return
        }
        if (executionMode === 'candidate_pool') {
          const candidate = aShareCandidatePoolService.upsert(signal, decision)
          aShareOrderQueueService.recordSkipped(item.ticker, `已进入组合策略候选池：${candidate.candidateId}，等待组合裁决推进。`, { signalId: signal.id, side: signal.side })
          return
        }
        if (executionMode === 'trading_agent') {
          aShareOrderQueueService.createPendingOrder(signal, decision, {
            decisionMode: 'trading_agent',
            portfolioDecisionId: decision.agentRunId,
            portfolioDecisionReason: decision.reason,
            riskWarnings: [
              `Trading Agent 裁决来源：${decision.agentRunId ?? 'unknown-agent-run'}。`,
              '上游使用 TauricResearch/TradingAgents；A 股 adapter 负责映射 BUY / HOLD / SELL_TO_CLOSE。',
              'A 股第一版只多头；禁止 SELL_SHORT；只允许 RTH；真实提交前仍需人工确认。',
            ],
          })
          return
        }
        aShareOrderQueueService.createPendingOrder(signal, decision, {
          decisionMode: 'legacy_direct',
          riskWarnings: ['A 股老逻辑直推；禁止 SELL_SHORT；只允许 RTH；真实提交前仍需人工确认。'],
        })
      })
      if (executionMode === 'candidate_pool') await this.reviewCandidatePool(account)
      this.lastError = undefined
      return this.dashboard()
    } finally {
      this.runInFlight = false
    }
  }

  refreshSubscriptions(): AShareDashboardResponse {
    const universe = getAshareUniverse().universe
    aShareRealtimeSubscriptionService.start(universe.map((item) => item.futuCode))
    return this.dashboard()
  }

  private scheduleNextScan(delayMs: number) {
    if (!this.running) return
    if (this.scanTimer) clearTimeout(this.scanTimer)
    const safeDelay = Math.max(1_000, delayMs)
    this.nextRunAt = new Date(Date.now() + safeDelay).toISOString()
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined
      this.nextRunAt = undefined
      this.runOnce()
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : 'A 股实盘评估失败。'
        })
        .finally(() => {
          if (this.running) this.scheduleNextScan(DEFAULT_RUN_INTERVAL_MS)
        })
    }, safeDelay)
  }

  private async reviewCandidatePool(account?: LiveAccountDashboardResponse) {
    const candidates = aShareCandidatePoolService.reviewCandidates()
    if (!candidates.length) return
    const promptConfig = buildAshareCandidatePoolConfig()
    const preset = promptConfig.timingPresets.find((item) => item.id === promptConfig.presetId) ?? promptConfig.timingPresets[0]
    const decision = await requestLivePortfolioReviewDecision(
      {
        candidates,
        account: emptyAshareAccount(),
        positions: [],
        pendingOrders: aShareOrderQueueService.activePendingOrders().map((order) => ({
          id: order.id,
          ticker: order.intent.ticker,
          side: order.intent.side,
          createdAt: order.createdAt,
        })),
        constraints: {
          maxPromotedOrdersPerReview: preset?.maxPromotedOrdersPerReview ?? 1,
          minSignalConfirmations: preset?.minSignalConfirmations ?? 1,
          leveragedEtfCooldownMinutes: preset?.leveragedEtfCooldownMinutes ?? 30,
          sameGroupMutualExclusion: true,
          humanConfirmationRequired: true,
        },
      },
      { namespace: 'ashare', model: getAshareActiveArkModel(), modelOption: getAshareActiveLlmModelOption() },
    )
    const promoted = decision.ok ? aShareCandidatePoolService.applyReview(decision) : []
    for (const candidate of promoted) {
      if (!candidate.signal || !candidate.decision) {
        aShareOrderQueueService.recordSkipped(candidate.ticker, `组合裁决推进 ${candidate.candidateId}，但当前进程缺少原始信号上下文，未进入待确认队列。`)
        continue
      }
      const risk = validateAshareDecision(candidate.action, currentAshareSession().session, {
        ticker: candidate.ticker,
        orderQuantity: candidate.decision.orderQuantity,
        limitPrice: candidate.decision.limitPrice,
        positions: account?.positions ?? [],
        accountSummary: account?.summary,
      })
      if (!risk.ok) {
        aShareOrderQueueService.recordSkipped(candidate.ticker, risk.blockedReason ?? '组合策略候选未通过 A 股硬风控。', { signalId: candidate.signal.id, side: candidate.action })
        continue
      }
      const order = aShareOrderQueueService.createPendingOrder(candidate.signal, candidate.decision, {
        decisionMode: 'candidate_pool',
        candidateId: candidate.candidateId,
        portfolioDecisionId: candidate.portfolioDecisionId,
        portfolioRank: candidate.portfolioRank,
        portfolioDecisionReason: candidate.portfolioDecisionReason,
        riskWarnings: [
          `组合策略候选池来源：${candidate.candidateId}，裁决版本 live_portfolio_candidate_review_v1。`,
          ...(candidate.portfolioDecisionReason ? [`组合裁决理由：${candidate.portfolioDecisionReason}`] : []),
          'A 股第一版只多头；禁止 SELL_SHORT；只允许 RTH。',
        ],
      })
      void order
    }
  }

  private async refreshAccountSnapshot(): Promise<LiveAccountDashboardResponse> {
    const account = await loadLiveAccountDashboard({ market: 'CN', tradingCurrency: 'CNY' }).catch((error) => ({
      ...emptyAshareAccount(),
      ok: false,
      warnings: [error instanceof Error ? error.message : 'A 股账户快照加载失败。'],
    }))
    this.accountSnapshot = normalizeAshareAccountSnapshot(account)
    return this.accountSnapshot
  }
}

export const aShareLiveTradingEngine = new AShareLiveTradingEngine()

function readinessBlockReason(snapshot: ReturnType<typeof aShareRealtimeStore.snapshot>): string | undefined {
  if (!snapshot.quote) return `${snapshot.ticker} A 股 quote 尚未就绪，跳过 LLM。`
  if (snapshot.klineBars.length < 120) return `${snapshot.ticker} A 股 1m K线不足 120 根，跳过 LLM。`
  if (snapshot.tickerPoints.length < 1) return `${snapshot.ticker} A 股 tickerPoints 尚未就绪，跳过 LLM。`
  return undefined
}

function buildSignal(ticker: string, decision: LlmTradingDecision, snapshot: ReturnType<typeof aShareRealtimeStore.snapshot>): QuantSignal {
  const model = getAshareActiveArkModel()
  const modelOption = getAshareActiveLlmModelOption()
  return {
    id: `ashare-signal-${ticker}-${Date.now()}`,
    ticker,
    strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
    model,
    modelLabel: modelOption.label,
    side: decision.action,
    confidence: decision.confidence,
    reason: decision.reason,
    price: snapshot.quote?.price ?? String(decision.limitPrice),
    quantity: String(decision.orderQuantity),
    limitPrice: String(decision.limitPrice),
    riskAssessment: decision.riskAssessment,
    generatedAt: new Date().toISOString(),
    dataWindow: `A股窗口：${decision.dataWindowUsed.kline1mBars} 根 1m K线，${decision.dataWindowUsed.tickerPoints} 个 tickerPoints，${decision.dataWindowUsed.orderBookDepth} 档盘口。`,
    trendAlignment: decision.trendAlignment,
    tradeHorizon: decision.tradeHorizon,
    whyNotNoise: decision.whyNotNoise,
    source: 'futu-callback',
    rawModelOutput: decision.rawText,
    agentRunId: decision.agentRunId,
    agentReports: decision.agentReports,
    finalAgentDecision: decision.finalAgentDecision,
    agentFailureReason: decision.agentFailureReason,
  }
}

function emptyAshareAccount(): LiveAccountDashboardResponse {
  const now = new Date().toISOString()
  return {
    ok: true,
    selectedAccountId: 'ashare-real',
    summary: {
      accountId: 'ashare-real',
      currency: 'CNY',
      totalAssets: 'unavailable',
      cash: 'unavailable',
      availableFunds: 'unavailable',
      buyingPower: 'unavailable',
      tradingCurrency: 'CNY',
      totalAssetsInTradingCurrency: 'unavailable',
      cashInTradingCurrency: 'unavailable',
      availableFundsInTradingCurrency: 'unavailable',
      buyingPowerInTradingCurrency: 'unavailable',
      dailyPnL: 'unavailable',
      totalPnL: 'unavailable',
      source: { source: 'A股独立实盘配置', accessedAt: now, timestamp: now },
    },
    positions: [],
    risk: {
      concentrationRisk: 'A股第一版未接入持仓聚合',
      largestPosition: '无',
      cashRatio: 'unavailable',
      top30Overlap: 'unavailable',
      warnings: ['A股组合裁决暂使用空持仓上下文，真实账户持仓接入后会自动进入组合评审输入。'],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: 'A股第一版只生成待确认订单，不自动实盘提交。',
    },
    missingCapabilities: [],
    warnings: [],
  }
}

function normalizeAshareAccountSnapshot(account: LiveAccountDashboardResponse): LiveAccountDashboardResponse {
  const positions = account.positions.filter((position) => isAsharePosition(position))
  const warnings = account.warnings.filter((warning) => !warning.toLowerCase().includes('concentration risk'))
  const summary = {
    ...account.summary,
    tradingCurrency: 'CNY',
  }
  return {
    ...account,
    summary,
    positions,
    risk: {
      ...account.risk,
      concentrationRisk: positions.length ? account.risk.concentrationRisk : 'unavailable',
      largestPosition: positions.length ? account.risk.largestPosition : 'unavailable',
      warnings: account.risk.warnings.filter((warning) => !warning.toLowerCase().includes('concentration risk')),
    },
    warnings,
  }
}

function isAsharePosition(position: LiveAccountDashboardResponse['positions'][number]): boolean {
  const values = [position.code, position.ticker, position.underlyingTicker].map((value) => (value ?? '').toUpperCase())
  return values.some((value) => value.startsWith('SH.') || value.startsWith('SZ.') || /^\d{6}\.(SH|SZ)$/.test(value))
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  })
  await Promise.all(workers)
  return results
}
