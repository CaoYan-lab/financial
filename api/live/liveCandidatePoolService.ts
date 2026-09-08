import type { LiveCandidatePoolSnapshot, LivePendingOrder, LlmTradingDecision, Position, QuantSignal, TradeExecutionMode, TrendContextSummary } from '../../shared/types.js'
import type { StrategyMarketData } from '../simulation/realtimeDataAdapter.js'
import type { LivePortfolioReviewCandidate, LivePortfolioReviewDecision } from './livePortfolioReviewDecisionService.js'
import { livePersistence } from './livePersistence.js'
import { llmUniverseItem } from '../simulation/simulationUniverse.js'
import { getActiveLivePortfolioReviewPrompt } from '../trade_strategy/tradeStrategyConfigService.js'
import { logger } from '../utils/logger.js'

export type LiveCandidateStatus = 'ACTIVE' | 'PROMOTED' | 'WATCH' | 'SUPPRESSED' | 'EXPIRED' | 'DISABLED_BY_MODE_SWITCH'

export type LiveCandidateRuntime = {
  candidateId: string
  ticker: string
  action: Exclude<QuantSignal['side'], 'HOLD'>
  groupKey: string
  riskTags: string[]
  firstSeenAt: string
  lastSeenAt: string
  expiresAt: string
  signalCount: number
  firstSignalPrice: number
  latestSignalPrice: number
  latestMarketPrice: number
  priceDriftPct: number
  proposedQuantity: number
  proposedNotional: number
  confidence: string
  recentReasons: string[]
  status: LiveCandidateStatus
  signalIds: string[]
  signal: QuantSignal
  decision: LlmTradingDecision
  marketData: Extract<StrategyMarketData, { ok: true }>
  position?: Position
  trendContext?: TrendContextSummary
  portfolioDecisionId?: string
  portfolioRank?: number
  portfolioDecisionReason?: string
}

export class LiveCandidatePoolService {
  private candidates = new Map<string, LiveCandidateRuntime>()
  private timingPresetLogKey = ''
  private hydrated = false

  upsert(input: {
    signal: QuantSignal
    decision: LlmTradingDecision
    marketData: Extract<StrategyMarketData, { ok: true }>
    position?: Position
    trendContext?: TrendContextSummary
  }): LiveCandidateRuntime {
    this.ensureHydrated()
    const now = new Date()
    const preset = activeTimingPreset()
    this.logTimingPreset('upsert', preset)
    const key = candidateKey(input.decision.ticker, input.decision.action)
    const existing = this.candidates.get(key)
    const latestPrice = input.marketData.lastPrice || input.decision.limitPrice
    const proposedNotional = input.decision.orderQuantity * latestPrice
    const candidate: LiveCandidateRuntime = {
      candidateId: existing?.candidateId ?? `candidate-${input.decision.ticker.toUpperCase()}-${input.decision.action}-${Date.now()}`,
      ticker: input.decision.ticker.toUpperCase(),
      action: input.decision.action as Exclude<QuantSignal['side'], 'HOLD'>,
      groupKey: groupKeyForTicker(input.decision.ticker),
      riskTags: riskTagsForTicker(input.decision.ticker),
      firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + preset.candidateTtlMinutes * 60 * 1000).toISOString(),
      signalCount: (existing?.signalCount ?? 0) + 1,
      firstSignalPrice: existing?.firstSignalPrice ?? input.decision.limitPrice,
      latestSignalPrice: input.decision.limitPrice,
      latestMarketPrice: latestPrice,
      priceDriftPct: existing?.firstSignalPrice ? ((latestPrice - existing.firstSignalPrice) / existing.firstSignalPrice) * 100 : 0,
      proposedQuantity: input.decision.orderQuantity,
      proposedNotional,
      confidence: input.decision.confidence,
      recentReasons: [...(existing?.recentReasons ?? []), input.decision.reason].slice(-3),
      status: 'ACTIVE',
      signalIds: Array.from(new Set([...(existing?.signalIds ?? []), input.signal.id])),
      signal: input.signal,
      decision: input.decision,
      marketData: input.marketData,
      position: input.position,
      trendContext: input.trendContext,
    }
    this.candidates.set(key, candidate)
    this.persistCandidate(candidate, 'upsert')
    this.prune()
    return candidate
  }

  activeCandidates(): LiveCandidateRuntime[] {
    this.ensureHydrated()
    this.prune()
    const preset = activeTimingPreset()
    this.logTimingPreset('active_candidates', preset)
    return [...this.candidates.values()]
      .filter((candidate) => candidate.status === 'ACTIVE' || candidate.status === 'WATCH' || candidate.status === 'PROMOTED')
      .sort(candidateSort)
      .slice(0, preset.maxActiveCandidates)
  }

  visibleCandidates(): LiveCandidateRuntime[] {
    this.ensureHydrated()
    this.prune()
    const preset = activeTimingPreset()
    return [...this.candidates.values()]
      .filter((candidate) => candidate.status !== 'EXPIRED' && candidate.status !== 'DISABLED_BY_MODE_SWITCH')
      .sort(candidateSort)
      .slice(0, preset.maxActiveCandidates)
  }

  reviewCandidates(): LivePortfolioReviewCandidate[] {
    return this.activeCandidates().map((candidate) => ({
      candidateId: candidate.candidateId,
      ticker: candidate.ticker,
      action: candidate.action,
      groupKey: candidate.groupKey,
      riskTags: candidate.riskTags,
      firstSeenAt: candidate.firstSeenAt,
      lastSeenAt: candidate.lastSeenAt,
      signalCount: candidate.signalCount,
      firstSignalPrice: candidate.firstSignalPrice,
      latestSignalPrice: candidate.latestSignalPrice,
      latestMarketPrice: candidate.latestMarketPrice,
      priceDriftPct: candidate.priceDriftPct,
      proposedQuantity: candidate.proposedQuantity,
      proposedNotional: candidate.proposedNotional,
      confidence: candidate.confidence,
      recentReasons: candidate.recentReasons,
    }))
  }

  applyReview(decision: LivePortfolioReviewDecision): LiveCandidateRuntime[] {
    this.ensureHydrated()
    const byId = new Map([...this.candidates.values()].map((candidate) => [candidate.candidateId, candidate]))
    for (const item of decision.watchedCandidates) {
      const candidate = byId.get(item.candidateId)
      if (candidate) {
        candidate.status = 'WATCH'
        this.persistCandidate(candidate, 'review_watch')
      }
    }
    for (const item of decision.suppressedCandidates) {
      const candidate = byId.get(item.candidateId)
      if (candidate) {
        candidate.status = 'SUPPRESSED'
        candidate.portfolioDecisionReason = item.reason
        this.persistCandidate(candidate, 'review_suppress')
      }
    }
    for (const item of decision.expiredCandidates) {
      const candidate = byId.get(item.candidateId)
      if (candidate) {
        candidate.status = 'EXPIRED'
        this.persistCandidate(candidate, 'review_expire')
      }
    }
    const promoted: LiveCandidateRuntime[] = []
    for (const item of decision.promotedCandidates) {
      const candidate = byId.get(item.candidateId)
      if (!candidate) continue
      candidate.status = 'PROMOTED'
      candidate.portfolioDecisionId = decision.portfolioDecisionId
      candidate.portfolioRank = item.rank
      candidate.portfolioDecisionReason = item.reason
      this.persistCandidate(candidate, 'review_promote')
      promoted.push(candidate)
    }
    logger.info(
      {
        event: 'live.candidate_pool.review_applied',
        portfolioDecisionId: decision.portfolioDecisionId,
        ok: decision.ok,
        promotedCount: promoted.length,
        watchedCount: decision.watchedCandidates.length,
        suppressedCount: decision.suppressedCandidates.length,
        expiredCount: decision.expiredCandidates.length,
      },
      'Live candidate pool review applied',
    )
    return promoted.sort((left, right) => (left.portfolioRank ?? 999) - (right.portfolioRank ?? 999))
  }

  decoratePendingOrder(order: LivePendingOrder, candidate: LiveCandidateRuntime): LivePendingOrder {
    return {
      ...order,
      decisionMode: 'candidate_pool',
      candidateId: candidate.candidateId,
      portfolioDecisionId: candidate.portfolioDecisionId,
      portfolioRank: candidate.portfolioRank,
      portfolioDecisionReason: candidate.portfolioDecisionReason,
      riskWarnings: [
        `组合策略候选池来源：${candidate.candidateId}，裁决版本 live_portfolio_candidate_review_v1。`,
        ...(candidate.portfolioDecisionReason ? [`组合裁决理由：${candidate.portfolioDecisionReason}`] : []),
        ...order.riskWarnings,
      ],
    }
  }

  disableForModeSwitch() {
    this.ensureHydrated()
    let disabledCount = 0
    for (const candidate of this.candidates.values()) {
      if (candidate.status !== 'EXPIRED' && candidate.status !== 'DISABLED_BY_MODE_SWITCH') {
        candidate.status = 'DISABLED_BY_MODE_SWITCH'
        this.persistCandidate(candidate, 'mode_switch_disable')
        disabledCount += 1
      }
    }
    if (disabledCount) {
      logger.info({ event: 'live.candidate_pool.disabled_by_mode_switch', disabledCount }, 'Live candidate pool disabled active candidates by mode switch')
    }
  }

  snapshot(executionMode: TradeExecutionMode): LiveCandidatePoolSnapshot {
    this.ensureHydrated()
    const promptConfig = getActiveLivePortfolioReviewPrompt()
    const preset = promptConfig.timingPresets.find((item) => item.id === promptConfig.defaultPresetId) ?? promptConfig.timingPresets[0]
    return {
      executionMode,
      enabled: executionMode === 'candidate_pool',
      promptVersion: promptConfig.id,
      promptLabel: promptConfig.label,
      promptSummary: promptConfig.summary,
      promptConfigVersion: promptConfig.version,
      promptRawYaml: promptConfig.rawYaml,
      presetId: promptConfig.defaultPresetId,
      presetLabel: preset?.label ?? promptConfig.defaultPresetId,
      timingPresets: promptConfig.timingPresets,
      decisionRuleCount: promptConfig.decisionRules.length,
      requiredJsonKeys: Object.keys(promptConfig.requiredJson ?? {}),
      candidates: this.visibleCandidates().map((candidate) => ({
        candidateId: candidate.candidateId,
        ticker: candidate.ticker,
        action: candidate.action,
        groupKey: candidate.groupKey,
        riskTags: candidate.riskTags,
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
        expiresAt: candidate.expiresAt,
        signalCount: candidate.signalCount,
        priceDriftPct: candidate.priceDriftPct,
        proposedQuantity: candidate.proposedQuantity,
        proposedNotional: candidate.proposedNotional,
        confidence: candidate.confidence,
        status: executionMode === 'candidate_pool' ? candidate.status : 'DISABLED_BY_MODE_SWITCH',
        portfolioDecisionId: candidate.portfolioDecisionId,
        portfolioRank: candidate.portfolioRank,
        portfolioDecisionReason: candidate.portfolioDecisionReason,
      })),
    }
  }

  resetForTests(options?: { hydrateFromPersistence?: boolean }) {
    this.candidates.clear()
    this.timingPresetLogKey = ''
    this.hydrated = !options?.hydrateFromPersistence
  }

  findBySignalId(signalId: string): LiveCandidateRuntime | undefined {
    this.ensureHydrated()
    this.prune()
    return [...this.candidates.values()].find((candidate) => candidate.signalIds.includes(signalId))
  }

  private prune() {
    this.ensureHydrated()
    const now = Date.now()
    const preset = activeTimingPreset()
    this.logTimingPreset('prune', preset)
    const ttlMs = preset.candidateTtlMinutes * 60 * 1000
    let expiredCount = 0
    let deletedCount = 0
    for (const [key, candidate] of this.candidates.entries()) {
      if (Date.parse(candidate.expiresAt) < now) {
        if (candidate.status !== 'EXPIRED') {
          expiredCount += 1
          candidate.status = 'EXPIRED'
          this.persistCandidate(candidate, 'ttl_expire')
        }
      }
      if (candidate.status === 'EXPIRED' && Date.parse(candidate.expiresAt) < now - ttlMs) {
        this.candidates.delete(key)
        deletedCount += 1
      }
    }
    if (expiredCount || deletedCount) {
      logger.info(
        {
          event: 'live.candidate_pool.pruned',
          presetId: preset.id,
          ttlMinutes: preset.candidateTtlMinutes,
          expiredCount,
          deletedCount,
          remainingCount: this.candidates.size,
        },
        'Live candidate pool pruned expired candidates',
      )
    }
  }

  private ensureHydrated() {
    if (this.hydrated) return
    this.hydrated = true
    const restoredByKey = new Map<string, LiveCandidateRuntime>()
    const seenKeys = new Set<string>()
    for (const record of livePersistence.readLatest('candidate_pool', 500)) {
      const candidate = candidateFromRecord(record)
      if (!candidate) continue
      const key = candidateKey(candidate.ticker, candidate.action)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      if (candidate.status === 'EXPIRED' || candidate.status === 'DISABLED_BY_MODE_SWITCH') continue
      if (Date.parse(candidate.expiresAt) <= Date.now()) continue
      restoredByKey.set(key, candidate)
    }
    this.candidates = restoredByKey
    if (this.candidates.size) {
      logger.info({ event: 'live.candidate_pool.hydrated', restoredCount: this.candidates.size }, 'Live candidate pool restored persisted candidates')
    }
  }

  private persistCandidate(candidate: LiveCandidateRuntime, persistenceReason: string) {
    livePersistence.appendCandidatePoolRecord({
      ...candidate,
      persistenceReason,
      updatedAt: new Date().toISOString(),
    } as unknown as Record<string, unknown>)
  }

  private logTimingPreset(source: string, preset: ReturnType<typeof activeTimingPreset>) {
    const key = `${preset.id}:${preset.version}:${preset.candidateTtlMinutes}:${preset.maxActiveCandidates}:${preset.maxPromotedOrdersPerReview}`
    if (this.timingPresetLogKey === key) return
    this.timingPresetLogKey = key
    logger.info(
      {
        event: 'live.candidate_pool.timing_preset.active',
        source,
        presetId: preset.id,
        presetVersion: preset.version,
        scanMinutes: preset.singleSignalScanIntervalMinutes,
        reviewMinutes: preset.portfolioReviewIntervalMinutes,
        ttlMinutes: preset.candidateTtlMinutes,
        leveragedEtfCooldownMinutes: preset.leveragedEtfCooldownMinutes,
        minSignalConfirmations: preset.minSignalConfirmations,
        maxPromotedOrdersPerReview: preset.maxPromotedOrdersPerReview,
        maxActiveCandidates: preset.maxActiveCandidates,
      },
      'Live candidate pool timing preset activated',
    )
  }
}

export const liveCandidatePoolService = new LiveCandidatePoolService()

function activeTimingPreset() {
  const promptConfig = getActiveLivePortfolioReviewPrompt()
  return promptConfig.timingPresets.find((item) => item.id === promptConfig.defaultPresetId) ?? promptConfig.timingPresets[0]
}

function candidateKey(ticker: string, action: string) {
  return `${ticker.toUpperCase()}:${action.toUpperCase()}`
}

function candidateFromRecord(record: Record<string, unknown>): LiveCandidateRuntime | undefined {
  const candidate = record as unknown as LiveCandidateRuntime
  if (!candidate || typeof candidate !== 'object') return undefined
  if (typeof candidate.candidateId !== 'string' || !candidate.candidateId) return undefined
  if (typeof candidate.ticker !== 'string' || !candidate.ticker) return undefined
  if (candidate.action !== 'BUY' && candidate.action !== 'SELL_SHORT' && candidate.action !== 'SELL_TO_CLOSE') return undefined
  if (!isCandidateStatus(candidate.status)) return undefined
  if (typeof candidate.expiresAt !== 'string' || !candidate.expiresAt) return undefined
  if (!candidate.signal || !candidate.decision || !candidate.marketData?.ok) return undefined
  return {
    ...candidate,
    ticker: candidate.ticker.toUpperCase(),
    groupKey: groupKeyForTicker(candidate.ticker),
    signalIds: Array.isArray(candidate.signalIds) ? candidate.signalIds.filter((item): item is string => typeof item === 'string') : [candidate.signal.id],
    riskTags: Array.isArray(candidate.riskTags) ? candidate.riskTags.filter((item): item is string => typeof item === 'string') : [],
    recentReasons: Array.isArray(candidate.recentReasons) ? candidate.recentReasons.filter((item): item is string => typeof item === 'string') : [],
  }
}

function isCandidateStatus(status: unknown): status is LiveCandidateStatus {
  return status === 'ACTIVE' || status === 'PROMOTED' || status === 'WATCH' || status === 'SUPPRESSED' || status === 'EXPIRED' || status === 'DISABLED_BY_MODE_SWITCH'
}

function candidateSort(left: LiveCandidateRuntime, right: LiveCandidateRuntime) {
  const confidenceScore = (value: string) => (value === 'high' ? 3 : value === 'medium' ? 2 : 1)
  return (
    right.signalCount - left.signalCount ||
    confidenceScore(right.confidence) - confidenceScore(left.confidence) ||
    Math.abs(left.priceDriftPct) - Math.abs(right.priceDriftPct) ||
    Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
  )
}

function groupKeyForTicker(ticker: string) {
  const normalized = ticker.toUpperCase()
  if (normalized === 'NVDL') return 'NVDA_LONG_BETA'
  if (normalized === 'AMD' || normalized === 'AMDL') return 'AMD_LONG_BETA'
  if (normalized === 'AMZN' || normalized === 'AMZZ') return 'AMZN_LONG_BETA'
  if (normalized === 'TSM' || normalized === 'TSMU') return 'TSM_LONG_BETA'
  if (normalized === '07709') return 'SK_HYNIX_LONG_BETA'
  if (normalized === '07747') return 'SAMSUNG_ELECTRONICS_LONG_BETA'
  if (normalized === 'SPCX' || normalized === 'SPCU' || normalized === 'SPAL') return 'SPACEX_LONG_BETA'
  if (normalized === 'TQQQ') return 'NASDAQ_LONG_BETA'
  return `${normalized}_DIRECT`
}

function riskTagsForTicker(ticker: string) {
  const item = llmUniverseItem(ticker)
  const normalized = ticker.toUpperCase()
  const tags: string[] = []
  if (item?.assetType === 'ETF') tags.push('ETF')
  if (isLeveraged2x(item?.leverageFactor)) tags.push('LEVERAGED_2X_ETF')
  if (['NVDL', 'AMDL', 'AMZZ', 'TSMU', 'MULL', 'TQQQ', '07709', '07747'].includes(normalized)) tags.push('HIGH_BETA_TECH')
  return tags
}

function isLeveraged2x(leverageFactor: unknown) {
  if (typeof leverageFactor === 'number') return leverageFactor >= 2
  if (typeof leverageFactor === 'string') return /(^|\D)2\s*x/i.test(leverageFactor)
  return false
}
