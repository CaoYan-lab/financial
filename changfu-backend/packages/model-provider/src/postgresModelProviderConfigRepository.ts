import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  credentialAad,
  decodeCredentialKey,
  decryptCredential,
  encryptCredential,
} from './credentialCrypto.js'

export type ModelProviderProtocol =
  | 'OPENAI_RESPONSES'
  | 'OPENAI_CHAT_COMPLETIONS'

export type PublicModelProviderConfig = {
  configId: string
  displayName: string
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  enabled: boolean
  keyConfigured: true
  keyLastFour: string
  updatedAt: string
}

export type ModelProviderConfigEnvelope = {
  eligible: boolean
  planCode: string | null
  config: PublicModelProviderConfig | null
}

export type EffectiveModelProviderConfig = {
  configId: string
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  apiKey: string
}

type ConfigRow = {
  config_id: string
  display_name: string
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  api_key_ciphertext: Buffer
  api_key_nonce: Buffer
  api_key_auth_tag: Buffer
  api_key_last_four: string
  enabled: boolean
  updated_at: Date
}

type Queryable = Pool | PoolClient

export class ModelProviderConfigError extends Error {
  constructor(readonly code: string) {
    super('第三方模型配置未完成')
    this.name = 'ModelProviderConfigError'
  }
}

function publicConfig(row: ConfigRow): PublicModelProviderConfig {
  return {
    configId: row.config_id,
    displayName: row.display_name,
    protocol: row.protocol,
    endpoint: row.endpoint,
    model: row.model,
    enabled: row.enabled,
    keyConfigured: true,
    keyLastFour: row.api_key_last_four,
    updatedAt: row.updated_at.toISOString(),
  }
}

export class PostgresModelProviderConfigRepository {
  private readonly encryptionKey: Buffer | null

  constructor(
    private readonly pool: Pool,
    encodedEncryptionKey: string,
  ) {
    this.encryptionKey = encodedEncryptionKey ? decodeCredentialKey(encodedEncryptionKey) : null
  }

  async get(userId: string): Promise<ModelProviderConfigEnvelope> {
    const [planCode, config] = await Promise.all([
      this.currentPlanCode(this.pool, userId, false),
      this.configRow(this.pool, userId, false),
    ])
    return {
      eligible: planCode === 'FLAGSHIP',
      planCode,
      config: config ? publicConfig(config) : null,
    }
  }

  async upsert(input: {
    userId: string
    displayName: string
    protocol: ModelProviderProtocol
    endpoint: string
    model: string
    apiKey: string | null
    enabled: boolean
  }): Promise<ModelProviderConfigEnvelope> {
    const key = this.encryptionKey
    if (!key) throw new ModelProviderConfigError('MODEL_CREDENTIAL_KEY_MISSING')
    return this.transaction(async client => {
      const planCode = await this.currentPlanCode(client, input.userId, true)
      if (planCode !== 'FLAGSHIP') {
        throw new ModelProviderConfigError('FLAGSHIP_SUBSCRIPTION_REQUIRED')
      }
      const existing = await this.configRow(client, input.userId, true)
      const configId = existing?.config_id ?? randomUUID()
      let ciphertext = existing?.api_key_ciphertext
      let nonce = existing?.api_key_nonce
      let authTag = existing?.api_key_auth_tag
      let lastFour = existing?.api_key_last_four
      if (input.apiKey !== null) {
        const encrypted = encryptCredential(
          input.apiKey,
          key,
          credentialAad(input.userId, configId),
        )
        ciphertext = encrypted.ciphertext
        nonce = encrypted.nonce
        authTag = encrypted.authTag
        lastFour = input.apiKey.slice(-4)
      }
      if (!ciphertext || !nonce || !authTag || !lastFour) {
        throw new ModelProviderConfigError('MODEL_API_KEY_REQUIRED')
      }
      const saved = await client.query<ConfigRow>(
        `INSERT INTO changfu.third_party_model_configs (
           config_id, user_id, display_name, protocol, endpoint, model,
           api_key_ciphertext, api_key_nonce, api_key_auth_tag, api_key_last_four,
           key_version, enabled, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::bigint, $3, $4, $5, $6,
           $7, $8, $9, $10, 1, $11, now(), now()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           protocol = EXCLUDED.protocol,
           endpoint = EXCLUDED.endpoint,
           model = EXCLUDED.model,
           api_key_ciphertext = EXCLUDED.api_key_ciphertext,
           api_key_nonce = EXCLUDED.api_key_nonce,
           api_key_auth_tag = EXCLUDED.api_key_auth_tag,
           api_key_last_four = EXCLUDED.api_key_last_four,
           key_version = EXCLUDED.key_version,
           enabled = EXCLUDED.enabled,
           updated_at = now()
         RETURNING config_id, display_name, protocol, endpoint, model,
                   api_key_ciphertext, api_key_nonce, api_key_auth_tag,
                   api_key_last_four, enabled, updated_at`,
        [
          configId,
          input.userId,
          input.displayName,
          input.protocol,
          input.endpoint,
          input.model,
          ciphertext,
          nonce,
          authTag,
          lastFour,
          input.enabled,
        ],
      )
      return {
        eligible: true,
        planCode,
        config: publicConfig(saved.rows[0]!),
      }
    })
  }

  async delete(userId: string): Promise<ModelProviderConfigEnvelope> {
    return this.transaction(async client => {
      const planCode = await this.currentPlanCode(client, userId, true)
      if (planCode !== 'FLAGSHIP') {
        throw new ModelProviderConfigError('FLAGSHIP_SUBSCRIPTION_REQUIRED')
      }
      await client.query(
        'DELETE FROM changfu.third_party_model_configs WHERE user_id = $1::bigint',
        [userId],
      )
      return { eligible: true, planCode, config: null }
    })
  }

  async getEffective(
    userId: string,
    configId?: string,
  ): Promise<EffectiveModelProviderConfig | null> {
    const key = this.encryptionKey
    const result = await this.pool.query<ConfigRow>(
      `SELECT c.config_id, c.display_name, c.protocol, c.endpoint, c.model,
              c.api_key_ciphertext, c.api_key_nonce, c.api_key_auth_tag,
              c.api_key_last_four, c.enabled, c.updated_at
         FROM changfu.third_party_model_configs c
         JOIN changfu.user_subscriptions s ON s.user_id = c.user_id
         JOIN changfu.subscription_plan_versions p
           ON p.plan_version_id = s.plan_version_id
        WHERE c.user_id = $1::bigint
          AND ($2::uuid IS NULL OR c.config_id = $2::uuid)
          AND c.enabled = true
          AND s.status = 'ACTIVE'
          AND s.starts_at <= now()
          AND now() < s.expires_at
          AND p.plan_code = 'FLAGSHIP'
        LIMIT 1`,
      [userId, configId ?? null],
    )
    const row = result.rows[0]
    if (!row) return null
    if (!key) throw new ModelProviderConfigError('MODEL_CREDENTIAL_KEY_MISSING')
    return {
      configId: row.config_id,
      protocol: row.protocol,
      endpoint: row.endpoint,
      model: row.model,
      apiKey: decryptCredential(
        {
          ciphertext: row.api_key_ciphertext,
          nonce: row.api_key_nonce,
          authTag: row.api_key_auth_tag,
        },
        key,
        credentialAad(userId, row.config_id),
      ),
    }
  }

  private async currentPlanCode(
    queryable: Queryable,
    userId: string,
    lock: boolean,
  ): Promise<string | null> {
    const result = await queryable.query<{ plan_code: string }>(
      `SELECT p.plan_code
         FROM changfu.user_subscriptions s
         JOIN changfu.subscription_plan_versions p
           ON p.plan_version_id = s.plan_version_id
        WHERE s.user_id = $1::bigint
          AND s.status = 'ACTIVE'
          AND s.starts_at <= now()
          AND now() < s.expires_at
        LIMIT 1${lock ? ' FOR UPDATE OF s' : ''}`,
      [userId],
    )
    return result.rows[0]?.plan_code ?? null
  }

  private async configRow(
    queryable: Queryable,
    userId: string,
    lock: boolean,
  ): Promise<ConfigRow | null> {
    const result = await queryable.query<ConfigRow>(
      `SELECT config_id, display_name, protocol, endpoint, model,
              api_key_ciphertext, api_key_nonce, api_key_auth_tag,
              api_key_last_four, enabled, updated_at
         FROM changfu.third_party_model_configs
        WHERE user_id = $1::bigint${lock ? ' FOR UPDATE' : ''}`,
      [userId],
    )
    return result.rows[0] ?? null
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
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
