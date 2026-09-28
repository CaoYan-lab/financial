import type { ContextEnvelope, ModelRunResult } from '../../../packages/domain/src/contracts.js'
import {
  ContextValidationError,
  validateContextEnvelope,
} from '../../../packages/domain/src/contextEnvelope.js'
import type { SafeLogger } from '../../../packages/observability/src/safeLogger.js'
import type { ModelRunRepository } from '../../../packages/persistence/src/modelRunRepository.js'
import type { DeviceAuthorizer } from '../../../packages/auth/src/deviceAuthorization.js'
import {
  TradingAuthorityError,
  type ResolvedTradingDecision,
  type TradingDecisionAuthority,
} from './tradingDecisionAuthority.js'
import type { TradingOutcomeRepository } from './tradingOutcomeRepository.js'

export type DecisionModel = {
  run(input: {
    userId: string
    modelConfigId: string | null | undefined
    context: ContextEnvelope
    userMessage: string | null
    authority: ResolvedTradingDecision | null
    signal: AbortSignal
  }): Promise<ModelRunResult>
}

export class DecisionService {
  constructor(
    private readonly repository: ModelRunRepository,
    private readonly model: DecisionModel,
    private readonly logger: SafeLogger,
    private readonly deviceAuthorizer: DeviceAuthorizer,
    private readonly tradingAuthority?: TradingDecisionAuthority,
    private readonly tradingOutcomeRepository?: TradingOutcomeRepository,
  ) {}

  async run(input: {
    userId: string
    deviceId: string
    rawContext: unknown
    byteLength: number
    userMessage: string | null
    modelConfigId?: string | null | undefined
    signal: AbortSignal
    now?: Date
    onProgress?: (stage: string, percent: number) => void
  }): Promise<ModelRunResult> {
    const { envelope, metadata } = validateContextEnvelope(input.rawContext, {
      byteLength: input.byteLength,
      ...(input.now ? { now: input.now } : {}),
    })
    if (envelope.deviceId !== input.deviceId) {
      throw new ContextValidationError('CONTEXT_DEVICE_MISMATCH', '上下文设备与访问令牌不一致')
    }
    await this.deviceAuthorizer.authorizeAndVerify(input.userId, envelope)
    input.onProgress?.('context_validated', 20)
    const executable = envelope.purpose !== 'CHAT' && envelope.purpose !== 'REPORT'
    if (executable && !this.tradingAuthority) {
      throw new TradingAuthorityError('TRADING_AUTHORITY_UNAVAILABLE')
    }
    const authority = this.tradingAuthority
      ? await this.tradingAuthority.resolve(input.userId, envelope)
      : null
    if (executable && !authority) {
      throw new TradingAuthorityError('TRADING_AUTHORITY_UNAVAILABLE')
    }
    input.onProgress?.('authority_resolved', 40)

    await this.repository.create({
      userId: input.userId,
      metadata,
      model: authority?.model.id ?? (envelope.capabilities.length > 0
        ? envelope.capabilities
          .map(capability => `${capability.kind}:${capability.id}:${capability.modelProfile}`)
          .join(',')
        : 'configured-at-runtime'),
      promptVersion: authority?.prompt.version ?? (envelope.capabilities
        .map(capability => capability.promptVersion)
        .filter((version): version is string => version !== null)
        .join(',') || 'changfu-global-chat-v1'),
      status: 'RUNNING',
    })
    this.logger.info('model_run_started', {
      requestId: metadata.requestId,
      deviceId: metadata.deviceId,
      byteLength: metadata.byteLength,
      positionCount: metadata.counts.positions,
      quoteCount: metadata.counts.quotes,
      minuteBarCount: metadata.counts.minuteBars,
      tickerPointCount: metadata.counts.tickerPoints,
      orderBookCount: metadata.counts.orderBooks,
      openOrderCount: metadata.counts.openOrders,
      recentDealCount: metadata.counts.recentDeals,
      capabilityCount: metadata.counts.capabilities,
      dataGapCount: metadata.counts.dataGaps,
      contentHash: metadata.contentHash,
    })

    try {
      const result = await this.model.run({
        userId: input.userId,
        modelConfigId: input.modelConfigId,
        context: envelope,
        userMessage: input.userMessage,
        authority,
        signal: input.signal,
      })
      this.assertResultSafe(envelope, result, authority)
      input.onProgress?.('model_completed', 80)
      const persistedResult = authority && this.tradingOutcomeRepository
        ? await this.tradingOutcomeRepository.persist({
            userId: input.userId,
            context: envelope,
            authority,
            result,
          })
        : result
      if (!authority || !this.tradingOutcomeRepository) {
        await this.repository.finish(metadata.requestId, {
          status: persistedResult.status,
          result: persistedResult,
          errorCode: null,
        })
      }
      input.onProgress?.('result_persisted', 100)
      this.logger.info('model_run_finished', {
        requestId: metadata.requestId,
        status: persistedResult.status,
        responseType: persistedResult.responseType,
      })
      return persistedResult
    } catch (error) {
      const errorCode = error instanceof ContextValidationError
        ? error.code
        : error instanceof TradingAuthorityError
          ? error.code
        : input.signal.aborted
          ? 'CLIENT_CANCELLED'
          : 'MODEL_RUN_FAILED'
      await this.repository.finish(metadata.requestId, {
        status: 'INTERRUPTED',
        result: null,
        errorCode,
      })
      this.logger.error('model_run_failed', {
        requestId: metadata.requestId,
        errorCode,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        failureReason: error instanceof Error ? error.message.slice(0, 200) : '未知错误',
      })
      throw error
    }
  }

  private assertResultSafe(
    context: ContextEnvelope,
    result: ModelRunResult,
    authority: ResolvedTradingDecision | null,
  ): void {
    if (result.requestId !== context.requestId) throw new Error('模型结果 requestId 不匹配')
    if (result.evidence.length === 0 && result.responseType !== 'ERROR') {
      throw new Error('模型结果缺少证据')
    }
    if (context.dataGaps.length > 0 && result.responseType === 'ORDER_DRAFT') {
      throw new Error('存在数据缺口时禁止生成可执行订单意图')
    }
    if (
      context.purpose !== 'CHAT'
      && context.purpose !== 'REPORT'
      && result.responseType === 'ORDER_DRAFT'
    ) {
      throw new Error('影子决策阶段禁止生成可执行订单意图')
    }
    if (result.responseType === 'ORDER_DRAFT' && result.orderIntent === null) {
      throw new Error('订单草案缺少签名意图')
    }
    if (result.responseType !== 'ORDER_DRAFT' && result.orderIntent !== null) {
      throw new Error('非订单草案不得携带订单意图')
    }
    if (
      context.purpose === 'SINGLE_DECISION'
      && (result.responseType === 'SIGNAL' || result.responseType === 'CANDIDATE')
      && !result.signal
    ) {
      throw new Error('单标的影子结果缺少结构化信号')
    }
    if (result.signal) {
      if (
        !authority
        || authority.requestedSymbols.length !== 1
        || authority.requestedSymbols[0] !== result.signal.symbol
        || result.signal.confidence < 0
        || result.signal.confidence > 1
      ) {
        throw new Error('结构化信号超出服务端授权范围')
      }
    }
    if (
      authority?.role === 'SINGLE_DECISION'
      && (
        (authority.executionMode === 'DIRECT' && result.responseType === 'CANDIDATE')
        || (authority.executionMode === 'CANDIDATE_POOL' && result.responseType === 'SIGNAL')
      )
    ) {
      throw new Error('影子结果与服务端执行模式不一致')
    }
    if (
      context.purpose === 'PORTFOLIO_REVIEW'
      && result.responseType === 'CANDIDATE'
      && !result.portfolioReview
    ) {
      throw new Error('组合裁决结果缺少候选分类')
    }
    if (
      context.purpose === 'MANAGED_ORDER_REVIEW'
      && result.responseType !== 'HOLD'
      && result.responseType !== 'ERROR'
    ) {
      throw new Error('挂单监管影子结果类型非法')
    }
  }
}
