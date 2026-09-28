import { createPublicKey, verify } from 'node:crypto'
import type { Pool } from 'pg'
import type { ContextEnvelope } from '../../domain/src/contracts.js'

export interface DeviceAuthorizer {
  authorizeAndVerify(userId: string, envelope: ContextEnvelope): Promise<void>
}

export class DeviceAuthorizationError extends Error {
  constructor(readonly code: string) {
    super('设备无权提交该上下文')
    this.name = 'DeviceAuthorizationError'
  }
}

export class PostgresDeviceAuthorizer implements DeviceAuthorizer {
  constructor(private readonly pool: Pool) {}

  async authorizeAndVerify(userId: string, envelope: ContextEnvelope): Promise<void> {
    const result = await this.pool.query<{
      public_key: string
      device_status: string
      connection_status: string
    }>(
      `SELECT d.public_key,
              d.status AS device_status,
              b.status AS connection_status
         FROM changfu.devices d
         JOIN changfu.broker_connections b
           ON b.broker_connection_id = $3::uuid
          AND b.user_id = d.user_id
        WHERE d.user_id = $1::bigint
          AND d.device_id = $2::uuid`,
      [userId, envelope.deviceId, envelope.brokerConnectionId],
    )
    const row = result.rows[0]
    if (!row || row.device_status !== 'ACTIVE' || row.connection_status !== 'ACTIVE') {
      throw new DeviceAuthorizationError('DEVICE_OR_CONNECTION_INACTIVE')
    }

    let valid = false
    try {
      valid = verify(
        null,
        Buffer.from(envelope.contentHash, 'hex'),
        createPublicKey(row.public_key),
        Buffer.from(envelope.deviceSignature, 'base64url'),
      )
    } catch {
      throw new DeviceAuthorizationError('DEVICE_SIGNATURE_INVALID')
    }
    if (!valid) throw new DeviceAuthorizationError('DEVICE_SIGNATURE_INVALID')
  }
}
