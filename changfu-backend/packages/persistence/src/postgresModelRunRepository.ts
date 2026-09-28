import type { Pool } from 'pg'
import type { ModelRunRecord, ModelRunRepository } from './modelRunRepository.js'

export class PostgresModelRunRepository implements ModelRunRepository {
  constructor(private readonly pool: Pool) {}

  async create(record: Omit<ModelRunRecord, 'result' | 'errorCode'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO changfu.model_runs (
         request_id, user_id, device_id, broker_connection_id, purpose,
         content_hash, byte_length, item_counts, captured_at, source_expires_at,
         requested_symbols, model, prompt_version, status
       ) VALUES (
         $1::uuid, $2::bigint, $3::uuid, $4::uuid, $5,
         $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz,
         $11::varchar[], $12, $13, $14
       )`,
      [
        record.metadata.requestId,
        record.userId,
        record.metadata.deviceId,
        record.metadata.brokerConnectionId,
        record.metadata.purpose,
        record.metadata.contentHash,
        record.metadata.byteLength,
        JSON.stringify(record.metadata.counts),
        record.metadata.capturedAt,
        record.metadata.expiresAt,
        record.metadata.requestedSymbols,
        record.model,
        record.promptVersion,
        record.status,
      ],
    )
  }

  async finish(
    requestId: string,
    completion: Pick<ModelRunRecord, 'status' | 'result' | 'errorCode'>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE changfu.model_runs
          SET status = $2,
              result = $3::jsonb,
              error_code = $4,
              finished_at = now()
        WHERE request_id = $1::uuid`,
      [
        requestId,
        completion.status,
        completion.result ? JSON.stringify(completion.result) : null,
        completion.errorCode,
      ],
    )
  }
}
