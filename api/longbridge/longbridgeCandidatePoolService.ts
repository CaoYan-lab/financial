import type { LiveCandidatePoolItem, LiveCandidatePoolSnapshot, LivePendingOrder, LiveSignalHistoryItem, LlmTradingDecision, TradeExecutionMode } from '../../shared/types.js'
import { getActiveLivePortfolioReviewPrompt, getTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import type { LongbridgeStrategyMarketData } from '../../shared/longbridgeTypes.js'
import type { LivePortfolioReviewDecision } from '../live/livePortfolioReviewDecisionService.js'
import { longbridgePersistence, type LongbridgeCandidateRecord } from './longbridgePersistence.js'

class LongbridgeCandidatePoolService {
  upsert(input: {
    signal: LiveSignalHistoryItem
    decision: LlmTradingDecision
    marketData: Extract<LongbridgeStrategyMarketData, { ok: true }>
  }): LongbridgeCandidateRecord {
    const existing = longbridgePersistence.latestCandidates().find((item) => item.ticker === input.decision.ticker.toUpperCase() && item.action === input.decision.action)
    const now = new Date()
    const preset = activePreset()
    const firstPrice = existing?.proposedNotional && existing.proposedQuantity ? existing.proposedNotional / existing.proposedQuantity : input.decision.limitPrice || input.marketData.lastPrice
    const latestPrice = input.marketData.lastPrice || input.decision.limitPrice
    const candidate: LongbridgeCandidateRecord = {
      candidateId: existing?.candidateId ?? `longbridge-candidate-${input.decision.ticker.toUpperCase()}-${input.decision.action}-${Date.now()}`,
      ticker: input.decision.ticker.toUpperCase(),
      action: input.decision.action as Exclude<LiveSignalHistoryItem['side'], 'HOLD'>,
      groupKey: `${input.decision.ticker.toUpperCase()}_DIRECT`,
      riskTags: ['LONGBRIDGE_REAL_DRY_RUN'],
      firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + preset.candidateTtlMinutes * 60 * 1000).toISOString(),
      signalCount: (existing?.signalCount ?? 0) + 1,
      priceDriftPct: firstPrice ? ((latestPrice - firstPrice) / firstPrice) * 100 : 0,
      proposedQuantity: input.decision.orderQuantity,
      proposedNotional: input.decision.orderQuantity * latestPrice,
      confidence: input.decision.confidence,
      status: 'ACTIVE',
      signal: input.signal,
      decision: input.decision,
      marketData: input.marketData,
    }
    longbridgePersistence.appendCandidate(candidate)
    return candidate
  }

  reviewCandidates() {
    return longbridgePersistence.latestCandidates()
      .filter((candidate) => candidate.status === 'ACTIVE' || candidate.status === 'WATCH' || candidate.status === 'PROMOTED')
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        ticker: candidate.ticker,
        action: candidate.action,
        groupKey: candidate.groupKey,
        riskTags: candidate.riskTags,
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
        signalCount: candidate.signalCount,
        firstSignalPrice: candidate.proposedQuantity ? candidate.proposedNotional / candidate.proposedQuantity : 0,
        latestSignalPrice: candidate.proposedQuantity ? candidate.proposedNotional / candidate.proposedQuantity : 0,
        latestMarketPrice: candidate.proposedQuantity ? candidate.proposedNotional / candidate.proposedQuantity : 0,
        priceDriftPct: candidate.priceDriftPct,
        proposedQuantity: candidate.proposedQuantity,
        proposedNotional: candidate.proposedNotional,
        confidence: candidate.confidence,
        recentReasons: [candidate.signal.reason],
      }))
  }

  applyReview(decision: LivePortfolioReviewDecision): LongbridgeCandidateRecord[] {
    const byId = new Map(longbridgePersistence.latestCandidates().map((candidate) => [candidate.candidateId, candidate]))
    for (const item of decision.watchedCandidates) updateStatus(byId.get(item.candidateId), 'WATCH', item.reason, decision)
    for (const item of decision.suppressedCandidates) updateStatus(byId.get(item.candidateId), 'SUPPRESSED', item.reason, decision)
    for (const item of decision.expiredCandidates) updateStatus(byId.get(item.candidateId), 'EXPIRED', item.reason, decision)
    const promoted: LongbridgeCandidateRecord[] = []
    for (const item of decision.promotedCandidates) {
      const candidate = byId.get(item.candidateId)
      if (!candidate) continue
      updateStatus(candidate, 'PROMOTED', item.reason, decision, item.rank)
      promoted.push(candidate)
    }
    return promoted.sort((left, right) => (left.portfolioRank ?? 999) - (right.portfolioRank ?? 999))
  }

  suppressByRisk(candidate: LongbridgeCandidateRecord, reason: string): void {
    candidate.status = 'SUPPRESSED'
    candidate.portfolioRank = undefined
    candidate.portfolioDecisionReason = reason
    longbridgePersistence.appendCandidate(candidate)
  }

  decoratePendingOrder(order: LivePendingOrder, candidate: LongbridgeCandidateRecord): LivePendingOrder {
    return {
      ...order,
      decisionMode: 'candidate_pool',
      candidateId: candidate.candidateId,
      portfolioDecisionId: candidate.portfolioDecisionId,
      portfolioRank: candidate.portfolioRank,
      portfolioDecisionReason: candidate.portfolioDecisionReason,
      riskWarnings: [
        `长桥组合策略候选池来源：${candidate.candidateId}，裁决版本 live_portfolio_candidate_review_v1。`,
        ...(candidate.portfolioDecisionReason ? [`组合裁决理由：${candidate.portfolioDecisionReason}`] : []),
        ...order.riskWarnings,
      ],
    }
  }

  snapshot(executionMode: TradeExecutionMode): LiveCandidatePoolSnapshot {
    const prompt = getActiveLivePortfolioReviewPrompt()
    const preset = activePreset()
    return {
      executionMode,
      enabled: executionMode === 'candidate_pool',
      promptVersion: prompt.id,
      promptLabel: prompt.label,
      promptSummary: prompt.summary,
      promptConfigVersion: prompt.version,
      promptRawYaml: prompt.rawYaml,
      presetId: preset.id,
      presetLabel: preset.label,
      timingPresets: prompt.timingPresets,
      decisionRuleCount: prompt.decisionRules.length,
      requiredJsonKeys: Object.keys(prompt.requiredJson ?? {}),
      candidates: longbridgePersistence.latestCandidates().map(toItem),
    }
  }
}

export const longbridgeCandidatePoolService = new LongbridgeCandidatePoolService()

function activePreset() {
  const prompt = getActiveLivePortfolioReviewPrompt()
  const selection = getTradeStrategyRuntimeConfig('live').selection
  return prompt.timingPresets.find((item) => item.id === selection.portfolioTimingPresetId) ?? prompt.timingPresets.find((item) => item.id === prompt.defaultPresetId) ?? prompt.timingPresets[0]
}

function updateStatus(candidate: LongbridgeCandidateRecord | undefined, status: string, reason: string, decision: LivePortfolioReviewDecision, rank?: number) {
  if (!candidate) return
  candidate.status = status
  candidate.portfolioDecisionId = decision.portfolioDecisionId
  candidate.portfolioRank = rank
  candidate.portfolioDecisionReason = reason
  longbridgePersistence.appendCandidate(candidate)
}

function toItem(candidate: LongbridgeCandidateRecord): LiveCandidatePoolItem {
  return {
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
    status: candidate.status,
    portfolioDecisionId: candidate.portfolioDecisionId,
    portfolioRank: candidate.portfolioRank,
    portfolioDecisionReason: candidate.portfolioDecisionReason,
  }
}
