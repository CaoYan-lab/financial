import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { LEASE_TTL_MS, TradingLeaseConflictError, type TradingLease } from '../../domain/src/tradingLease.js'

export class PostgresTradingLeaseRepository {
  constructor(private readonly pool: Pool) {}

  async acquire(input: {
    userId: string
    deviceId: string
    brokerConnectionId: string
    now?: Date
  }): Promise<TradingLease> {
    const now = input.now ?? new Date()
    const leaseId = randomUUID()
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS)
    const result = await this.pool.query<{
      lease_id: string
      user_id: string
      broker_connection_id: string
      device_id: string
      expires_at: Date
      version: string
    }>(
      `INSERT INTO changfu.trading_leases (
         broker_connection_id, lease_id, user_id, device_id, version, expires_at, updated_at
       )
       SELECT $1::uuid, $2::uuid, $3::bigint, $4::uuid, 1, $5::timestamptz, $6::timestamptz
       WHERE EXISTS (
         SELECT 1
           FROM changfu.devices d
           JOIN changfu.broker_connections b ON b.user_id = d.user_id
          WHERE d.device_id = $4::uuid
            AND d.user_id = $3::bigint
            AND d.status = 'ACTIVE'
            AND b.broker_connection_id = $1::uuid
            AND b.status = 'ACTIVE'
       )
       ON CONFLICT (broker_connection_id) DO UPDATE
         SET lease_id = CASE
               WHEN changfu.trading_leases.device_id = EXCLUDED.device_id
                 THEN changfu.trading_leases.lease_id
               ELSE EXCLUDED.lease_id
             END,
             device_id = EXCLUDED.device_id,
             version = changfu.trading_leases.version + 1,
             expires_at = EXCLUDED.expires_at,
             updated_at = EXCLUDED.updated_at
       WHERE changfu.trading_leases.expires_at <= $6::timestamptz
          OR changfu.trading_leases.device_id = EXCLUDED.device_id
       RETURNING lease_id, user_id, broker_connection_id, device_id, expires_at, version`,
      [
        input.brokerConnectionId,
        leaseId,
        input.userId,
        input.deviceId,
        expiresAt,
        now,
      ],
    )
    const row = result.rows[0]
    if (!row) {
      const active = await this.pool.query<{ device_id: string }>(
        `SELECT device_id
           FROM changfu.trading_leases
          WHERE broker_connection_id = $1::uuid
            AND expires_at > $2::timestamptz`,
        [input.brokerConnectionId, now],
      )
      if (active.rows[0]) throw new TradingLeaseConflictError(active.rows[0].device_id)
      throw new Error('设备或券商连接无效')
    }
    return {
      leaseId: row.lease_id,
      userId: row.user_id,
      brokerConnectionId: row.broker_connection_id,
      deviceId: row.device_id,
      expiresAt: row.expires_at,
      version: Number(row.version),
    }
  }

  async release(input: {
    userId: string
    deviceId: string
    brokerConnectionId: string
  }): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM changfu.trading_leases
        WHERE broker_connection_id = $1::uuid
          AND user_id = $2::bigint
          AND device_id = $3::uuid`,
      [input.brokerConnectionId, input.userId, input.deviceId],
    )
    return result.rowCount === 1
  }
}
