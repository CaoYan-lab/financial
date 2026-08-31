import type { LiveCandidatePoolItem, LlmTradingDecision, QuantSignal, TradeExecutionMode } from '../../shared/types.js'
import type { LivePortfolioReviewCandidate, LivePortfolioReviewDecision } from '../live/livePortfolioReviewDecisionService.js'
import { aSharePersistence } from './aSharePersistence.js'

const MAX_ITEMS = 500
type RuntimeCandidate = LiveCandidatePoolItem & {
  signal?: QuantSignal
  decision?: LlmTradingDecision
  signalIds?: string[]
}

class AShareCandidatePoolService {
  private readonly candidates: RuntimeCandidate[] = aSharePersistence.readLatest('candidate_pool', MAX_ITEMS)

  upsert(signal: QuantSignal, decision: LlmTradingDecision): RuntimeCandidate {
    const now = new Date()
    const existing = this.candidates.find((item) => item.ticker === signal.ticker && item.action === signal.side && item.status === 'ACTIVE')
    const candidate: RuntimeCandidate = {
      candidateId: existing?.candidateId ?? `ashare-candidate-${signal.ticker}-${signal.side}-${Date.now()}`,
      ticker: signal.ticker,
      action: signal.side as Exclude<QuantSignal['side'], 'HOLD'>,
      groupKey: `CN:${signal.ticker.split('.', 1)[0]}`,
      riskTags: ['A_SHARE', 'LONG_ONLY', 'CNY'],
      firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      signalCount: (existing?.signalCount ?? 0) + 1,
      priceDriftPct: 0,
      proposedQuantity: decision.orderQuantity,
      proposedNotional: decision.orderQuantity * decision.limitPrice,
      confidence: decision.confidence,
      status: 'ACTIVE',
      signalIds: Array.from(new Set([...(existing?.signalIds ?? []), signal.id])),
      signal,
      decision,
    }
    if (existing) {
      const index = this.candidates.findIndex((item) => item.candidateId === existing.candidateId)
      if (index >= 0) this.candidates.splice(index, 1)
    }
    this.candidates.unshift(candidate)
    this.candidates.splice(MAX_ITEMS)
    aSharePersistence.appendCandidate(candidate)
    return candidate
  }

  activeCandidates(): LiveCandidatePoolItem[] {
    const now = Date.now()
    return this.candidates
      .filter((item) => item.status === 'ACTIVE' && (Date.parse(item.expiresAt) || 0) > now)
      .slice(0, MAX_ITEMS)
  }

  visibleCandidates(executionMode: TradeExecutionMode): LiveCandidatePoolItem[] {
    const now = Date.now()
    return this.candidates
      .filter((item) => (Date.parse(item.expiresAt) || 0) > now || item.status !== 'ACTIVE')
      .slice(0, MAX_ITEMS)
      .map(({ signal: _signal, decision: _decision, signalIds: _signalIds, ...item }) => ({
        ...item,
        status: executionMode === 'candidate_pool' ? item.status : 'DISABLED_BY_MODE_SWITCH',
      }))
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
      firstSignalPrice: Number(candidate.proposedNotional / Math.max(1, candidate.proposedQuantity)),
      latestSignalPrice: Number(candidate.proposedNotional / Math.max(1, candidate.proposedQuantity)),
      latestMarketPrice: Number(candidate.proposedNotional / Math.max(1, candidate.proposedQuantity)),
      priceDriftPct: candidate.priceDriftPct,
      proposedQuantity: candidate.proposedQuantity,
      proposedNotional: candidate.proposedNotional,
      confidence: candidate.confidence,
      recentReasons: [],
    }))
  }

  applyReview(decision: LivePortfolioReviewDecision): RuntimeCandidate[] {
    const byId = new Map(this.candidates.map((candidate) => [candidate.candidateId, candidate]))
    for (const item of decision.watchedCandidates) {
      const candidate = byId.get(item.candidateId)
      if (candidate) this.persistWithStatus(candidate, 'WATCH', item.reason)
    }
    for (const item of decision.suppressedCandidates) {
      const candidate = byId.get(item.candidateId)
      if (candidate) this.persistWithStatus(candidate, 'SUPPRESSED', item.reason)
    }
    for (const item of decision.expiredCandidates) {
      const candidate = byId.get(item.candidateId)
      if (candidate) this.persistWithStatus(candidate, 'EXPIRED', item.reason)
    }
    const promoted: RuntimeCandidate[] = []
    for (const item of decision.promotedCandidates) {
      const candidate = byId.get(item.candidateId)
      if (!candidate) continue
      candidate.status = 'PROMOTED'
      candidate.portfolioDecisionId = decision.portfolioDecisionId
      candidate.portfolioRank = item.rank
      candidate.portfolioDecisionReason = item.reason
      aSharePersistence.appendCandidate(candidate)
      promoted.push(candidate)
    }
    return promoted.sort((left, right) => (left.portfolioRank ?? 999) - (right.portfolioRank ?? 999))
  }

  decoratePendingOrder<T extends { riskWarnings: string[] }>(order: T, candidate: RuntimeCandidate): T {
    return {
      ...order,
      riskWarnings: [
        `组合策略候选池来源：${candidate.candidateId}，裁决版本 live_portfolio_candidate_review_v1。`,
        ...(candidate.portfolioDecisionReason ? [`组合裁决理由：${candidate.portfolioDecisionReason}`] : []),
        ...order.riskWarnings,
      ],
      decisionMode: 'candidate_pool',
      candidateId: candidate.candidateId,
      portfolioDecisionId: candidate.portfolioDecisionId,
      portfolioRank: candidate.portfolioRank,
      portfolioDecisionReason: candidate.portfolioDecisionReason,
    } as T
  }

  disableForModeSwitch() {
    for (const candidate of this.candidates) {
      if (candidate.status !== 'EXPIRED' && candidate.status !== 'DISABLED_BY_MODE_SWITCH') {
        this.persistWithStatus(candidate, 'DISABLED_BY_MODE_SWITCH', '组合策略关闭，候选池切为只读。')
      }
    }
  }

  private persistWithStatus(candidate: RuntimeCandidate, status: string, reason?: string) {
    candidate.status = status
    candidate.portfolioDecisionReason = reason ?? candidate.portfolioDecisionReason
    aSharePersistence.appendCandidate(candidate)
  }
}

export const aShareCandidatePoolService = new AShareCandidatePoolService()
