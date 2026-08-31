import type { LiveAccountDashboardResponse, LlmModelOption, Position, QuantSignal } from '../../shared/types.js'
import { durationMs, logger } from '../utils/logger.js'
import { callArkResponses, parseJsonObject } from '../simulation/llmResponseUtils.js'
import { getActiveArkModel } from '../simulation/llmRuntimeConfigService.js'
import { getActiveLivePortfolioReviewPrompt } from '../trade_strategy/tradeStrategyConfigService.js'

export type LivePortfolioReviewCandidate = {
  candidateId: string
  ticker: string
  action: QuantSignal['side']
  groupKey: string
  riskTags: string[]
  firstSeenAt: string
  lastSeenAt: string
  signalCount: number
  firstSignalPrice: number
  latestSignalPrice: number
  latestMarketPrice: number
  priceDriftPct: number
  proposedQuantity: number
  proposedNotional: number
  confidence: string
  recentReasons: string[]
}

export type LivePortfolioReviewDecision = {
  ok: boolean
  portfolioDecisionId: string
  promptVersion: 'live_portfolio_candidate_review_v1'
  promotedCandidates: Array<{
    candidateId: string
    rank: number
    reason: string
    riskAssessment?: string
    whyPromoteNow?: string
    whyNotOthers?: string
  }>
  watchedCandidates: Array<{ candidateId: string; reason: string }>
  suppressedCandidates: Array<{ candidateId: string; reason: string }>
  expiredCandidates: Array<{ candidateId: string; reason: string }>
  portfolioRationale: string
  rawText?: string
  error?: string
}

type PortfolioReviewOptions = {
  namespace?: string
  model?: string
  modelOption?: LlmModelOption
}

type ReviewInput = {
  candidates: LivePortfolioReviewCandidate[]
  account: LiveAccountDashboardResponse
  positions: Position[]
  pendingOrders: Array<{ id: string; ticker: string; side: string; createdAt: string }>
  constraints: {
    maxPromotedOrdersPerReview: number
    minSignalConfirmations: number
    leveragedEtfCooldownMinutes: number
    sameGroupMutualExclusion: boolean
    humanConfirmationRequired: boolean
  }
}

export async function requestLivePortfolioReviewDecision(input: ReviewInput, options: PortfolioReviewOptions = {}): Promise<LivePortfolioReviewDecision> {
  const startedAt = performance.now()
  const model = options.model ?? getActiveArkModel()
  const promptConfig = getActiveLivePortfolioReviewPrompt(options.namespace)
  const preset = activePreset(promptConfig)
  const portfolioDecisionId = `portfolio-review-${Date.now()}`
  logger.info(
    {
      event: 'live.portfolio_review.started',
      model,
      candidateCount: input.candidates.length,
      portfolioDecisionId,
      promptId: promptConfig.id,
      promptVersion: promptConfig.version,
      defaultPresetId: promptConfig.defaultPresetId,
      selectedPresetId: preset?.id,
      decisionRuleCount: promptConfig.decisionRules.length,
      maxPromotedOrdersPerReview: input.constraints.maxPromotedOrdersPerReview,
      minSignalConfirmations: input.constraints.minSignalConfirmations,
      leveragedEtfCooldownMinutes: input.constraints.leveragedEtfCooldownMinutes,
    },
    'Live portfolio review started',
  )
  const response = await callArkResponses(buildPortfolioReviewPrompt(input, portfolioDecisionId, promptConfig), { model, modelOption: options.modelOption })
  if (response.ok === false) {
    logger.error({ event: 'live.portfolio_review.failed', model, portfolioDecisionId, durationMs: durationMs(startedAt), error: response.error }, 'Live portfolio review failed')
    return {
      ok: false,
      portfolioDecisionId,
      promptVersion: 'live_portfolio_candidate_review_v1',
      promotedCandidates: [],
      watchedCandidates: [],
      suppressedCandidates: [],
      expiredCandidates: [],
      portfolioRationale: `组合裁决调用失败：${response.error}`,
      error: response.error,
    }
  }
  const parsed = parsePortfolioReviewDecision(response.text, input, portfolioDecisionId)
  logger.info(
    {
      event: parsed.ok ? 'live.portfolio_review.succeeded' : 'live.portfolio_review.failed',
      model,
      portfolioDecisionId,
      durationMs: durationMs(startedAt),
      promotedCount: parsed.promotedCandidates.length,
      error: parsed.error,
    },
    parsed.ok ? 'Live portfolio review succeeded' : 'Live portfolio review failed',
  )
  return parsed
}

function buildPortfolioReviewPrompt(input: ReviewInput, portfolioDecisionId: string, promptConfig = getActiveLivePortfolioReviewPrompt()): Array<{ role: string; content: string }> {
  const preset = activePreset(promptConfig)
  logger.info(
    {
      event: 'live.portfolio_review.prompt_built',
      portfolioDecisionId,
      promptId: promptConfig.id,
      promptVersion: promptConfig.version,
      selectedPresetId: preset?.id,
      candidateCount: input.candidates.length,
      positionCount: input.positions.length,
      pendingOrderCount: input.pendingOrders.length,
      requiredJsonKeys: Object.keys(promptConfig.requiredJson ?? {}),
    },
    'Live portfolio review prompt payload built',
  )
  return [
    {
      role: 'system',
      content: promptConfig.systemPrompt,
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: promptConfig.task,
        portfolioDecisionId,
        promptVersion: promptConfig.id,
        reviewPreset: {
          ...preset,
          leveragedEtfCooldownMinutes: input.constraints.leveragedEtfCooldownMinutes,
        },
        candidatePool: input.candidates,
        portfolioState: {
          account: {
            accountId: input.account.selectedAccountId,
            totalAssets: input.account.summary.totalAssetsInTradingCurrency ?? input.account.summary.totalAssets,
            buyingPower: input.account.summary.buyingPowerInTradingCurrency ?? input.account.summary.buyingPower,
            tradingCurrency: input.account.summary.tradingCurrency ?? 'USD',
          },
          positions: input.positions.map((position) => ({
            ticker: (position.underlyingTicker || position.ticker).toUpperCase(),
            assetType: position.assetType,
            quantity: position.quantity,
            marketValue: position.marketValue,
            unrealizedPnL: position.unrealizedPnL,
          })),
          pendingOrders: input.pendingOrders,
        },
        constraints: input.constraints,
        decisionRules: promptConfig.decisionRules,
        requiredJson: promptConfig.requiredJson,
      }),
    },
  ]
}

function activePreset(promptConfig: ReturnType<typeof getActiveLivePortfolioReviewPrompt>) {
  return promptConfig.timingPresets.find((item) => item.id === promptConfig.defaultPresetId) ?? promptConfig.timingPresets[0]
}

function parsePortfolioReviewDecision(text: string, input: ReviewInput, portfolioDecisionId: string): LivePortfolioReviewDecision {
  const parsed = parseJsonObject(text)
  if (!parsed) {
    return {
      ok: false,
      portfolioDecisionId,
      promptVersion: 'live_portfolio_candidate_review_v1',
      promotedCandidates: [],
      watchedCandidates: [],
      suppressedCandidates: [],
      expiredCandidates: [],
      portfolioRationale: '组合裁决未返回可解析 JSON。',
      rawText: text,
      error: 'unparseable_json',
    }
  }
  const knownIds = new Set(input.candidates.map((candidate) => candidate.candidateId))
  const promotedCandidates = asArray(parsed.promotedCandidates)
    .map((item, index) => {
      const record = item as Record<string, unknown>
      return {
        candidateId: String(record.candidateId ?? ''),
        rank: Number(record.rank ?? index + 1),
        reason: String(record.reason ?? record.whyPromoteNow ?? '组合裁决建议推进。'),
        riskAssessment: typeof record.riskAssessment === 'string' ? record.riskAssessment : undefined,
        whyPromoteNow: typeof record.whyPromoteNow === 'string' ? record.whyPromoteNow : undefined,
        whyNotOthers: typeof record.whyNotOthers === 'string' ? record.whyNotOthers : undefined,
      }
    })
    .filter((item) => knownIds.has(item.candidateId))
    .slice(0, input.constraints.maxPromotedOrdersPerReview)
  return {
    ok: true,
    portfolioDecisionId,
    promptVersion: 'live_portfolio_candidate_review_v1',
    promotedCandidates,
    watchedCandidates: parseReasonList(parsed.watchedCandidates, knownIds),
    suppressedCandidates: parseReasonList(parsed.suppressedCandidates, knownIds),
    expiredCandidates: parseReasonList(parsed.expiredCandidates, knownIds),
    portfolioRationale: typeof parsed.portfolioRationale === 'string' ? parsed.portfolioRationale : '组合裁决完成。',
    rawText: text,
  }
}

function parseReasonList(value: unknown, knownIds: Set<string>): Array<{ candidateId: string; reason: string }> {
  return asArray(value)
    .map((item) => {
      const record = item as Record<string, unknown>
      return {
        candidateId: String(record.candidateId ?? ''),
        reason: String(record.reason ?? ''),
      }
    })
    .filter((item) => knownIds.has(item.candidateId))
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
