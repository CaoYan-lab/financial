import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { ContextEnvelope, ModelRunResult } from '../../../packages/domain/src/contracts.js'
import type { ResolvedTradingDecision } from './tradingDecisionAuthority.js'

export interface TradingOutcomeRepository {
  persist(input: {
    userId: string
    context: ContextEnvelope
    authority: ResolvedTradingDecision
    result: ModelRunResult
  }): Promise<ModelRunResult>
}

export class PostgresTradingOutcomeRepository implements TradingOutcomeRepository {
  constructor(private readonly pool: Pool) {}

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
        const signalId = randomUUID()
        await client.query(
          `INSERT INTO changfu.signals (
             signal_id, request_id, user_id, broker_connection_id, symbol, action,
             evidence_summary, risk_summary, exit_condition
           ) VALUES (
             $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6,
             $7::jsonb, $8::jsonb, $9
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
          ],
        )

        if (result.responseType === 'CANDIDATE' && signal.action !== 'HOLD') {
          const candidateId = randomUUID()
          const createdAt = new Date()
          const expiresAt = new Date(
            createdAt.getTime() + input.authority.candidateTtlSeconds * 1_000,
          )
          await client.query(
            `INSERT INTO changfu.candidate_pool_items (
               candidate_id, signal_id, user_id, broker_connection_id, symbol, side,
               status, rank, pool_version, config_version, created_at, expires_at
             ) VALUES (
               $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6,
               'PENDING', NULL, $7, $8, $9::timestamptz, $10::timestamptz
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
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }
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
}
