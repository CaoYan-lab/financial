import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ContextEnvelope, ModelRunResult } from '../../../packages/domain/src/contracts.js'
import {
  evaluateLiveOrderRisk,
  type LiveOrderRiskInput,
} from '../../../packages/domain/src/liveOrderRiskPolicy.js'
import {
  decideSameSymbolConflict,
  normalizeTradingSymbol,
  type LatestSignalAction,
} from '../../../packages/domain/src/sameSymbolConflictPolicy.js'
import {
  createSignedOrderIntent,
  type OrderSpec,
  type SignedOrderIntent,
} from '../../../packages/domain/src/signedOrderIntent.js'
import type { ResolvedTradingDecision } from './tradingDecisionAuthority.js'

export type OrderIntentSigningConfig = {
  privateKeyPem: string
  keyId: string
  quoteMaxAgeMs?: number
  accountMaxAgeMs?: number
}

export interface TradingOutcomeRepository {
  persist(input: {
    userId: string
    context: ContextEnvelope
    authority: ResolvedTradingDecision
    result: ModelRunResult
  }): Promise<ModelRunResult>
}

export class PostgresTradingOutcomeRepository implements TradingOutcomeRepository {
  constructor(
    private readonly pool: Pool,
    private readonly signing: OrderIntentSigningConfig | null = null,
  ) {}

  async persist(input: {
    userId: string
    context: ContextEnvelope
    authority: ResolvedTradingDecision
    result: ModelRunResult
  }): Promise<ModelRunResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      let result = input.result

      const signal = result.signal ?? null
      let candidate: Record<string, unknown> | null = null
      if (signal) {
        await lockSymbol(client, input.userId, input.context.brokerConnectionId, signal.symbol)
        const signalId = randomUUID()
        await client.query(
          `INSERT INTO changfu.signals (
             signal_id, request_id, user_id, broker_connection_id, symbol, action,
             evidence_summary, risk_summary, exit_condition, valid_until
           ) VALUES (
             $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6,
             $7::jsonb, $8::jsonb, $9, $10::timestamptz
           )`,
          [
            signalId,
            input.context.requestId,
            input.userId,
            input.context.brokerConnectionId,
            signal.symbol,
            signal.action,
            JSON.stringify({
              confidence: signal.confidence,
              intent: signal.intent,
              evidence: result.evidence,
              counterEvidence: result.counterEvidence,
              sourceValidUntil: result.sourceValidUntil,
            }),
            JSON.stringify({
              risks: result.risks,
              dataGaps: result.dataGaps,
              strategyId: input.authority.strategyId,
              riskPolicyId: input.authority.riskPolicyId,
            }),
            result.exitCondition,
            result.sourceValidUntil,
          ],
        )
        await client.query(
          `UPDATE changfu.signals
              SET lifecycle_status = 'SUPERSEDED',
                  superseded_at = now(),
                  superseded_by_signal_id = $1::uuid
            WHERE user_id = $2::bigint
              AND broker_connection_id = $3::uuid
              AND symbol = $4
              AND signal_id <> $1::uuid
              AND lifecycle_status = 'ACTIVE'`,
          [signalId, input.userId, input.context.brokerConnectionId, signal.symbol],
        )

        if (result.responseType === 'CANDIDATE' && signal.action !== 'HOLD') {
          const orderDraft = result.proposedOrder
            ? buildOrderSpec(input.context, input.authority, result.proposedOrder)
            : null
          const candidateId = randomUUID()
          const createdAt = new Date()
          const expiresAt = new Date(
            createdAt.getTime() + input.authority.candidateTtlSeconds * 1_000,
          )
          await client.query(
            `INSERT INTO changfu.candidate_pool_items (
               candidate_id, signal_id, user_id, broker_connection_id, symbol, side,
               status, rank, pool_version, config_version, order_draft, created_at, expires_at
             ) VALUES (
               $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6,
               'PENDING', NULL, $7, $8, $9::jsonb, $10::timestamptz, $11::timestamptz
             )`,
            [
              candidateId,
              signalId,
              input.userId,
              input.context.brokerConnectionId,
              signal.symbol,
              signal.action,
              input.authority.researchPoolVersion,
              input.authority.configVersion,
              JSON.stringify(orderDraft),
              createdAt,
              expiresAt,
            ],
          )
          candidate = {
            candidateId,
            brokerConnectionId: input.context.brokerConnectionId,
            signalId,
            symbol: signal.symbol,
            side: signal.action,
            status: 'PENDING',
            rank: null,
            poolVersion: input.authority.researchPoolVersion,
            configVersion: input.authority.configVersion,
            orderDraft,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }
        }

        if (input.authority.role === 'SINGLE_DECISION') {
          result = await this.reconcileSingleDecision(
            client,
            input,
            signalId,
            result,
          )
        }
      }
      result = {
        ...result,
        signal,
        candidate,
      }

      if (result.portfolioReview) {
        for (const item of result.portfolioReview) {
          const updated = await client.query(
            `UPDATE changfu.candidate_pool_items
                SET status = $5, rank = $6, updated_at = now()
              WHERE candidate_id = $1::uuid
                AND user_id = $2::bigint
                AND broker_connection_id = $3::uuid
                AND config_version = $4
                AND status IN ('PENDING', 'WATCH')`,
            [
              item.candidateId,
              input.userId,
              input.context.brokerConnectionId,
              input.authority.configVersion,
              item.status,
              item.rank,
            ],
          )
          if (updated.rowCount !== 1) throw new Error('CANDIDATE_STATE_CONFLICT')
        }
      }

      await client.query(
        `UPDATE changfu.model_runs
            SET status = $2, result = $3::jsonb, error_code = NULL, finished_at = now()
          WHERE request_id = $1::uuid`,
        [input.context.requestId, result.status, JSON.stringify(result)],
      )
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async reconcileSingleDecision(
    client: PoolClient,
    input: {
      userId: string
      context: ContextEnvelope
      authority: ResolvedTradingDecision
      result: ModelRunResult
    },
    signalId: string,
    result: ModelRunResult,
  ): Promise<ModelRunResult> {
    const signal = result.signal
    if (!signal) return result
    const proposedOrder = result.proposedOrder
      ? buildOrderSpec(input.context, input.authority, result.proposedOrder)
      : null
    const existing = await client.query<{
      intent_id: string
      device_id: string
      state: import('../../../packages/domain/src/contracts.js').OrderIntentState
      order_spec: OrderSpec
    }>(
      `SELECT intent_id, device_id, state, order_spec
         FROM changfu.pending_orders
        WHERE user_id = $1::bigint
          AND broker_connection_id = $2::uuid
          AND normalized_symbol = $3
          AND NOT is_terminal
        FOR UPDATE`,
      [
        input.userId,
        input.context.brokerConnectionId,
        normalizeTradingSymbol(signal.symbol),
      ],
    )
    const current = existing.rows[0]
    if (current) {
      const decision = decideSameSymbolConflict({
        state: current.state,
        order: current.order_spec,
        latestAction: (signal.intent ?? 'HOLD') as LatestSignalAction,
        proposedOrder,
        hasExternalOpenOrder: hasExternalOpenOrder(input.context, signal.symbol),
      })
      if (decision.action === 'SUPERSEDE_PENDING') {
        await client.query(
          `UPDATE changfu.pending_orders
              SET state = 'SUPERSEDED',
                  superseded_by_signal_id = $2::uuid,
                  claim_token_hash = NULL,
                  claim_expires_at = NULL,
                  version = version + 1,
                  updated_at = now()
            WHERE intent_id = $1::uuid
              AND state IN ('PENDING_CONFIRMATION', 'CLAIMED')`,
          [current.intent_id, signalId],
        )
      } else if (decision.action === 'REQUEST_CANCEL') {
        await client.query(
          `UPDATE changfu.pending_orders
              SET state = 'CANCEL_REQUESTED',
                  superseded_by_signal_id = $2::uuid,
                  cancel_reason_code = $3,
                  last_cancel_requested_at = now(),
                  version = version + 1,
                  updated_at = now()
            WHERE intent_id = $1::uuid
              AND state IN ('SUBMITTED', 'TRACKING', 'PARTIALLY_FILLED')`,
          [current.intent_id, signalId, decision.reason],
        )
        await client.query(
          `INSERT INTO changfu.order_actions (
             action_id, intent_id, user_id, device_id, provider, broker_connection_id,
             action_type, reason_code, idempotency_key, state
           ) VALUES (
             $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6::uuid,
             'CANCEL', $7, $8, 'PENDING'
           )
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            current.intent_id,
            input.userId,
            current.device_id,
            input.authority.provider,
            input.context.brokerConnectionId,
            decision.reason,
            `signal-conflict:${current.intent_id}`,
          ],
        )
        return withoutOrderIntent(result)
      } else if (decision.action !== 'ALLOW_NEW') {
        return withoutOrderIntent(result)
      }
    }

    if (
      signal.action === 'HOLD'
      || !proposedOrder
      || input.authority.executionMode !== 'DIRECT'
      || input.authority.environment !== 'REAL'
      || input.authority.hardGateEnabled !== true
    ) {
      return withoutOrderIntent(result)
    }
    if (!this.signing?.privateKeyPem || !this.signing.keyId) {
      throw new Error('ORDER_INTENT_SIGNING_CONFIG_MISSING')
    }
    const risk = evaluateLiveOrderRisk(buildRiskInput(input.context, input.authority, proposedOrder))
    if (!risk.allowed) {
      return {
        ...withoutOrderIntent(result),
        risks: [...new Set([...result.risks, `LIVE_ORDER_RISK_${risk.code}`])],
      }
    }
    const sourceValidUntil = result.sourceValidUntil
      ? new Date(result.sourceValidUntil)
      : new Date(Number.NaN)
    if (!Number.isFinite(sourceValidUntil.getTime())) {
      return {
        ...withoutOrderIntent(result),
        risks: [...new Set([...result.risks, 'LIVE_ORDER_RISK_SOURCE_EXPIRED'])],
      }
    }
    const intent = createSignedOrderIntent({
      userId: input.userId,
      deviceId: input.context.deviceId,
      brokerConnectionId: input.context.brokerConnectionId,
      provider: input.authority.provider,
      accountIdHash: input.authority.accountIdHash!,
      contextHash: input.context.contentHash,
      strategyVersion: input.authority.strategyId,
      sessionId: input.authority.tradingSessionId ?? null,
      poolVersion: input.authority.researchPoolVersion,
      configVersion: input.authority.configVersion,
      riskPolicyVersion: input.authority.riskPolicyId,
      executionMode: input.authority.submissionMode ?? 'MANUAL_CONFIRM',
      clientRevalidation: {
        quoteMaxAgeMs: this.signing.quoteMaxAgeMs ?? 5_000,
        accountMaxAgeMs: this.signing.accountMaxAgeMs ?? 5_000,
        mustCheckOpenOrders: true,
      },
      order: proposedOrder,
      sourceValidUntil,
      keyId: this.signing.keyId,
      privateKeyPem: this.signing.privateKeyPem,
    })
    await insertPendingOrder(client, input, signalId, intent)
    return {
      ...result,
      responseType: 'ORDER_DRAFT',
      orderIntent: intent,
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function numeric(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function buildOrderSpec(
  context: ContextEnvelope,
  authority: ResolvedTradingDecision,
  proposed: NonNullable<ModelRunResult['proposedOrder']>,
): OrderSpec {
  const positions = context.positions
    .map(record)
    .filter((item): item is Record<string, unknown> => item?.symbol === proposed.symbol)
  const longQuantity = positions
    .filter(item => item.side === 'LONG')
    .reduce((sum, item) => sum + numeric(item.quantity), 0)
  const shortQuantity = positions
    .filter(item => item.side === 'SHORT')
    .reduce((sum, item) => sum + numeric(item.quantity), 0)
  const positionEffect: OrderSpec['positionEffect'] = proposed.action === 'BUY'
    ? longQuantity > 0 ? 'ADD_LONG' : 'OPEN_LONG'
    : proposed.action === 'BUY_TO_COVER'
      ? 'COVER_SHORT'
      : proposed.action === 'SELL_TO_CLOSE'
        ? 'REDUCE_LONG'
        : shortQuantity > 0 ? 'ADD_SHORT' : 'OPEN_SHORT'
  return {
    broker: authority.provider,
    environment: authority.environment ?? 'SIMULATE',
    market: authority.instrument?.market ?? 'US',
    symbol: proposed.symbol,
    side: proposed.action === 'BUY' || proposed.action === 'BUY_TO_COVER' ? 'BUY' : 'SELL',
    positionEffect,
    orderType: 'MARKETABLE_LIMIT',
    tradingSession: 'RTH',
    timeInForce: 'DAY',
    quantity: proposed.quantity,
    limitPrice: proposed.limitPrice,
    currency: authority.instrument?.market === 'HK' ? 'HKD' : 'USD',
    maxSlippageBps: 15,
  }
}

function buildRiskInput(
  context: ContextEnvelope,
  authority: ResolvedTradingDecision,
  order: OrderSpec,
): LiveOrderRiskInput {
  const account = record(context.account) ?? {}
  const buyingPower = record(account.buyingPower)
  const quote = context.quotes.map(record).find(item => item?.symbol === order.symbol)
  const session = context.marketSessions.map(record).find(item => item?.market === order.market)
  const positions = context.positions
    .map(record)
    .filter((item): item is Record<string, unknown> => item?.symbol === order.symbol)
  const longQuantity = positions
    .filter(item => item.side === 'LONG')
    .reduce((sum, item) => sum + numeric(item.availableQuantity), 0)
  const shortQuantity = positions
    .filter(item => item.side === 'SHORT')
    .reduce((sum, item) => sum + numeric(item.availableQuantity), 0)
  const quoteSourceAt = typeof quote?.sourceAt === 'string'
    ? quote.sourceAt
    : typeof quote?.updateTime === 'string' ? quote.updateTime : null
  const quoteAt = quoteSourceAt ? Date.parse(quoteSourceAt) : Number.NaN
  const capturedAt = Date.parse(context.capturedAt)
  return {
    order,
    instrumentType: authority.instrument?.instrumentType ?? 'UNKNOWN',
    quoteFresh: Number.isFinite(quoteAt)
      && Number.isFinite(capturedAt)
      && Math.abs(capturedAt - quoteAt) <= 5_000,
    marketOpen: session?.state === 'OPEN',
    hasOpenOrderConflict: hasExternalOpenOrder(context, order.symbol),
    availableBuyingPower: numeric(buyingPower?.value),
    longQuantity,
    shortQuantity,
    lotSize: quote ? numeric(quote.lotSize, 0) || null : null,
    marginAccount: account.marginAccount === true,
    marginCallActive: account.marginCallActive !== false,
    shortRiskDisclosureAccepted: account.shortRiskDisclosureAccepted === true,
    shortable: typeof quote?.shortable === 'boolean' ? quote.shortable : null,
    maxShortQuantity: quote?.maxShortQuantity === undefined
      ? null
      : numeric(quote.maxShortQuantity),
  }
}

function hasExternalOpenOrder(context: ContextEnvelope, symbol: string): boolean {
  return context.openOrders.some(item => record(item)?.symbol === symbol)
}

function withoutOrderIntent(result: ModelRunResult): ModelRunResult {
  return { ...result, orderIntent: null }
}

async function lockSymbol(
  client: PoolClient,
  userId: string,
  brokerConnectionId: string,
  symbol: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`live-order:${userId}:${brokerConnectionId}:${normalizeTradingSymbol(symbol)}`],
  )
}

async function insertPendingOrder(
  client: PoolClient,
  input: {
    userId: string
    context: ContextEnvelope
    authority: ResolvedTradingDecision
  },
  signalId: string,
  intent: SignedOrderIntent,
): Promise<void> {
  await client.query(
    `INSERT INTO changfu.pending_orders (
       intent_id, signal_id, user_id, device_id, broker_connection_id,
       account_id_hash, context_hash, strategy_version, order_spec, state,
       signature, signing_key_id, issued_at, expires_at, provider,
       trading_session_id, research_pool_version, trading_config_version,
       risk_policy_version, execution_mode, client_revalidation,
       symbol, normalized_symbol, side, position_effect, submission_mode,
       signal_valid_until
     ) VALUES (
       $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid,
       $6, $7, $8, $9::jsonb, 'PENDING_CONFIRMATION',
       $10, $11, $12::timestamptz, $13::timestamptz, $14,
       $15::uuid, $16, $17, $18, $19, $20::jsonb,
       $21, $22, $23, $24, $25, $26::timestamptz
     )`,
    [
      intent.intentId,
      signalId,
      input.userId,
      intent.deviceId,
      intent.brokerConnectionId,
      intent.accountIdHash,
      intent.contextHash,
      intent.strategyVersion,
      JSON.stringify(intent.order),
      intent.signature,
      intent.keyId,
      intent.issuedAt,
      intent.expiresAt,
      intent.provider,
      intent.sessionId,
      intent.poolVersion,
      intent.configVersion,
      intent.riskPolicyVersion,
      intent.executionMode,
      JSON.stringify(intent.clientRevalidation),
      intent.order.symbol,
      normalizeTradingSymbol(intent.order.symbol),
      intent.order.side,
      intent.order.positionEffect,
      intent.executionMode,
      intent.expiresAt,
    ],
  )
}
