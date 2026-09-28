import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export class OrderClaimConflictError extends Error {
  constructor() {
    super('订单意图已被处理、已过期或交易租约无效')
    this.name = 'OrderClaimConflictError'
  }
}

export type ClaimedOrderIntent = {
  claimToken: string
  expiresAt: Date
  version: number
}

export class PostgresOrderIntentRepository {
  constructor(private readonly pool: Pool) {}

  async claim(input: {
    intentId: string
    userId: string
    deviceId: string
    expectedVersion: number
    now?: Date
  }): Promise<ClaimedOrderIntent> {
    const now = input.now ?? new Date()
    const claimToken = randomBytes(32).toString('base64url')
    const claimTokenHash = createHash('sha256').update(claimToken).digest('hex')
    const claimExpiresAt = new Date(now.getTime() + 60_000)
    const result = await this.pool.query<{
      claim_expires_at: Date
      version: string
    }>(
      `UPDATE changfu.pending_orders p
          SET state = 'CLAIMED',
              claim_token_hash = $5,
              claim_expires_at = $6::timestamptz,
              claimed_at = $7::timestamptz,
              version = p.version + 1,
              updated_at = $7::timestamptz
         FROM changfu.trading_leases l
        WHERE p.intent_id = $1::uuid
          AND p.user_id = $2::bigint
          AND p.device_id = $3::uuid
          AND p.version = $4::bigint
          AND p.state = 'PENDING_CONFIRMATION'
          AND p.expires_at > $7::timestamptz
          AND l.broker_connection_id = p.broker_connection_id
          AND l.user_id = p.user_id
          AND l.device_id = p.device_id
          AND l.expires_at > $7::timestamptz
       RETURNING p.claim_expires_at, p.version`,
      [
        input.intentId,
        input.userId,
        input.deviceId,
        input.expectedVersion,
        claimTokenHash,
        claimExpiresAt,
        now,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new OrderClaimConflictError()
    return {
      claimToken,
      expiresAt: row.claim_expires_at,
      version: Number(row.version),
    }
  }

  async beginSubmission(input: {
    intentId: string
    userId: string
    deviceId: string
    claimToken: string
    now?: Date
  }): Promise<void> {
    const now = input.now ?? new Date()
    const claimTokenHash = createHash('sha256').update(input.claimToken).digest('hex')
    const result = await this.pool.query(
      `UPDATE changfu.pending_orders
          SET state = 'SUBMITTING',
              version = version + 1,
              updated_at = $5::timestamptz
        WHERE intent_id = $1::uuid
          AND user_id = $2::bigint
          AND device_id = $3::uuid
          AND claim_token_hash = $4
          AND claim_expires_at > $5::timestamptz
          AND state = 'CLAIMED'`,
      [input.intentId, input.userId, input.deviceId, claimTokenHash, now],
    )
    if (result.rowCount !== 1) throw new OrderClaimConflictError()
  }
}
