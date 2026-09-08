import { randomUUID } from 'node:crypto'
import { getPool, query, queryOne } from '../../db/pgClient.js'
import type { BrokerConnection, LongbridgeCredentialBundle } from '../types.js'
import {
  credentialFingerprint,
  decryptCredentialBundle,
  encryptCredentialBundle,
  tokenExpiresAt,
} from './credentialVault.js'

type ConnectionRow = {
  id: string
  user_id: string
  platform: 'longbridge'
  credential_source: 'legacy_env' | 'encrypted_bundle'
  credential_ciphertext: string | null
  credential_iv: string | null
  credential_auth_tag: string | null
  key_version: number
  account_fingerprint: string | null
  status: BrokerConnection['status']
  token_expires_at: Date | null
  last_verified_at: Date | null
}

function normalize(row: ConnectionRow): BrokerConnection {
  const connection: BrokerConnection = {
    id: row.id,
    userId: String(row.user_id),
    platform: row.platform,
    credentialSource: row.credential_source,
    status: row.status,
    accountFingerprint: row.account_fingerprint ?? undefined,
    tokenExpiresAt: row.token_expires_at?.toISOString(),
    lastVerifiedAt: row.last_verified_at?.toISOString(),
  }
  if (row.credential_source === 'encrypted_bundle'
    && row.credential_ciphertext && row.credential_iv && row.credential_auth_tag) {
    connection.encrypted = {
      ciphertext: row.credential_ciphertext,
      iv: row.credential_iv,
      authTag: row.credential_auth_tag,
      keyVersion: row.key_version,
    }
  }
  return connection
}

const SELECT_COLUMNS = `
  id, user_id, platform, credential_source, credential_ciphertext,
  credential_iv, credential_auth_tag, key_version, account_fingerprint,
  status, token_expires_at, last_verified_at`

export async function getActiveConnection(userId: string): Promise<BrokerConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM multiuser.broker_connections
     WHERE user_id = $1 AND platform = 'longbridge' AND status <> 'disabled'
     ORDER BY CASE WHEN status = 'verified' THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 1`,
    [userId],
  )
  return row ? normalize(row) : null
}

export async function getOwnedConnection(
  userId: string,
  connectionId: string,
): Promise<BrokerConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM multiuser.broker_connections
     WHERE id = $1 AND user_id = $2 AND status = 'verified'`,
    [connectionId, userId],
  )
  return row ? normalize(row) : null
}

export async function getConnectionForVerification(
  userId: string,
  connectionId: string,
): Promise<BrokerConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM multiuser.broker_connections
     WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'verified')`,
    [connectionId, userId],
  )
  return row ? normalize(row) : null
}

export async function savePendingConnection(
  userId: string,
  bundle: LongbridgeCredentialBundle,
): Promise<BrokerConnection> {
  const encrypted = encryptCredentialBundle(bundle)
  const id = randomUUID()
  const expiresAt = tokenExpiresAt(bundle.accessToken)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<ConnectionRow>(
      `INSERT INTO multiuser.broker_connections
         (id, user_id, platform, credential_source, credential_ciphertext,
          credential_iv, credential_auth_tag, key_version, account_fingerprint,
          status, token_expires_at, last_verified_at)
       VALUES ($1, $2, 'longbridge', 'encrypted_bundle', $3, $4, $5, $6, $7,
               'pending', $8, NULL)
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        userId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,
        credentialFingerprint(bundle),
        expiresAt ?? null,
      ],
    )
    await client.query('COMMIT')
    return normalize(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function markConnectionVerified(userId: string, connectionId: string): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE multiuser.broker_connections
       SET status = 'disabled', updated_at = now()
       WHERE user_id = $1 AND platform = 'longbridge'
         AND status = 'verified' AND id <> $2`,
      [userId, connectionId],
    )
    await client.query(
      `UPDATE multiuser.broker_connections
       SET status = 'verified', last_verified_at = now(), updated_at = now()
       WHERE id = $2 AND user_id = $1 AND status = 'pending'`,
      [userId, connectionId],
    )
    await client.query(
      `INSERT INTO multiuser.longbridge_engine_state (user_id, binding_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, binding_id) DO NOTHING`,
      [userId, connectionId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function disableConnection(userId: string): Promise<void> {
  await query(
    `UPDATE multiuser.broker_connections
     SET status = 'disabled', updated_at = now()
     WHERE user_id = $1 AND platform = 'longbridge' AND status <> 'disabled'`,
    [userId],
  )
}

export async function markConnectionInvalid(connectionId: string): Promise<void> {
  await query(
    `UPDATE multiuser.broker_connections
     SET status = 'invalid', updated_at = now()
     WHERE id = $1 AND credential_source = 'encrypted_bundle'`,
    [connectionId],
  )
}

export function credentialsForConnection(connection: BrokerConnection): LongbridgeCredentialBundle {
  if (connection.credentialSource === 'legacy_env') {
    const appKey = process.env.LONGBRIDGE_APP_KEY?.trim() ?? ''
    const appSecret = process.env.LONGBRIDGE_APP_SECRET?.trim() ?? ''
    const accessToken = process.env.LONGBRIDGE_ACCESS_TOKEN?.trim() ?? ''
    if (!appKey || !appSecret || !accessToken) throw new Error('owner 长桥环境变量凭据未配置')
    return { appKey, appSecret, accessToken }
  }
  if (!connection.encrypted) throw new Error('长桥加密凭据不完整')
  return decryptCredentialBundle(connection.encrypted)
}
