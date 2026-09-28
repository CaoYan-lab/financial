import { createHash } from 'node:crypto'
import type { Pool } from 'pg'

export type StoredResponse = {
  status: number
  body: unknown
}

export class IdempotencyConflictError extends Error {
  constructor(readonly code: 'KEY_REUSED' | 'REQUEST_IN_PROGRESS') {
    super(code === 'KEY_REUSED' ? '幂等键已用于不同请求' : '相同请求正在处理中')
    this.name = 'IdempotencyConflictError'
  }
}

export function requestHash(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

export class IdempotencyService {
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 24 * 60 * 60 * 1_000,
  ) {}

  async begin(input: {
    userId: string
    operation: string
    key: string
    requestHash: string
    now?: Date
  }): Promise<StoredResponse | null> {
    const now = input.now ?? new Date()
    const expiresAt = new Date(now.getTime() + this.ttlMs)
    const inserted = await this.pool.query(
      `INSERT INTO changfu.idempotency_records (
         user_id, operation, idempotency_key, request_hash, expires_at
       ) VALUES ($1::bigint, $2, $3, $4, $5::timestamptz)
       ON CONFLICT (user_id, operation, idempotency_key) DO NOTHING`,
      [input.userId, input.operation, input.key, input.requestHash, expiresAt],
    )
    if (inserted.rowCount === 1) return null

    const existing = await this.pool.query<{
      request_hash: string
      response_status: number | null
      response_body: unknown
      expires_at: Date
    }>(
      `SELECT request_hash, response_status, response_body, expires_at
         FROM changfu.idempotency_records
        WHERE user_id = $1::bigint
          AND operation = $2
          AND idempotency_key = $3`,
      [input.userId, input.operation, input.key],
    )
    const row = existing.rows[0]
    if (!row || row.expires_at.getTime() <= now.getTime()) {
      await this.pool.query(
        `DELETE FROM changfu.idempotency_records
          WHERE user_id = $1::bigint AND operation = $2 AND idempotency_key = $3`,
        [input.userId, input.operation, input.key],
      )
      return this.begin(input)
    }
    if (row.request_hash !== input.requestHash) {
      throw new IdempotencyConflictError('KEY_REUSED')
    }
    if (row.response_status === null) {
      throw new IdempotencyConflictError('REQUEST_IN_PROGRESS')
    }
    return { status: row.response_status, body: row.response_body }
  }

  async complete(input: {
    userId: string
    operation: string
    key: string
    requestHash: string
    response: StoredResponse
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE changfu.idempotency_records
          SET response_status = $5,
              response_body = $6::jsonb
        WHERE user_id = $1::bigint
          AND operation = $2
          AND idempotency_key = $3
          AND request_hash = $4
          AND response_status IS NULL`,
      [
        input.userId,
        input.operation,
        input.key,
        input.requestHash,
        input.response.status,
        JSON.stringify(input.response.body),
      ],
    )
    if (result.rowCount !== 1) throw new IdempotencyConflictError('KEY_REUSED')
  }
}
