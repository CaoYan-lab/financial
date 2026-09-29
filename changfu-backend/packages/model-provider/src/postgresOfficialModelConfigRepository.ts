import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { PostgresAdminRepository } from '../../persistence/src/postgresAdminRepository.js'
import {
  decodeCredentialKey,
  decryptCredential,
  encryptCredential,
  officialCredentialAad,
} from './credentialCrypto.js'
import type { ModelProviderProtocol } from './postgresModelProviderConfigRepository.js'

type Status = 'DRAFT' | 'ACTIVE' | 'RETIRED'
type TestStatus = 'UNTESTED' | 'SUCCEEDED' | 'FAILED'

type ConfigRow = {
  config_version_id: string
  version: number
  display_name: string
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  api_key_ciphertext: Buffer
  api_key_nonce: Buffer
  api_key_auth_tag: Buffer
  api_key_last_four: string
  key_version: number
  status: Status
  test_status: TestStatus
  test_error_code: string | null
  tested_at: Date | null
  activated_at: Date | null
  created_at: Date
  updated_at: Date
}

export type EffectiveOfficialModelConfig = {
  configVersionId: string
  version: number
  displayName: string
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  apiKey: string
}

function publicConfig(row: ConfigRow) {
  return {
    configVersionId: row.config_version_id,
    version: row.version,
    displayName: row.display_name,
    protocol: row.protocol,
    endpoint: row.endpoint,
    model: row.model,
    keyConfigured: true as const,
    keyLastFour: row.api_key_last_four,
    keyVersion: row.key_version,
    status: row.status,
    testStatus: row.test_status,
    testErrorCode: row.test_error_code,
    testedAt: row.tested_at?.toISOString() ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export class OfficialModelConfigError extends Error {
  constructor(readonly code: string) {
    super('长富Pro模型配置操作失败')
    this.name = 'OfficialModelConfigError'
  }
}

export class PostgresOfficialModelConfigRepository {
  private readonly encryptionKey: Buffer | null

  constructor(
    private readonly pool: Pool,
    encodedEncryptionKey: string,
    private readonly adminRepository?: PostgresAdminRepository,
  ) {
    this.encryptionKey = encodedEncryptionKey ? decodeCredentialKey(encodedEncryptionKey) : null
  }

  async list(): Promise<{ activeConfigVersionId: string | null; versions: unknown[] }> {
    const rows = await this.rows(this.pool, '')
    return {
      activeConfigVersionId: rows.find(row => row.status === 'ACTIVE')?.config_version_id ?? null,
      versions: rows.map(publicConfig),
    }
  }

  async createDraft(input: {
    displayName: string
    protocol: ModelProviderProtocol
    endpoint: string
    model: string
    apiKey: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<unknown> {
    const key = this.requiredKey()
    return this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('changfu-official-model-version'))`)
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::integer + 1 AS version
           FROM changfu_admin.official_model_config_versions`,
      )
      const configVersionId = randomUUID()
      const encrypted = encryptCredential(
        input.apiKey,
        key,
        officialCredentialAad(configVersionId),
      )
      const result = await client.query<ConfigRow>(
        `INSERT INTO changfu_admin.official_model_config_versions (
           config_version_id, version, display_name, protocol, endpoint, model,
           api_key_ciphertext, api_key_nonce, api_key_auth_tag, api_key_last_four,
           key_version, status, test_status, created_by
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           1, 'DRAFT', 'UNTESTED', $11::uuid
         )
         RETURNING *`,
        [
          configVersionId,
          next.rows[0]!.version,
          input.displayName,
          input.protocol,
          input.endpoint,
          input.model,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          input.apiKey.slice(-4),
          input.actorAdminUserId,
        ],
      )
      await this.audit(client, input, 'OFFICIAL_MODEL_DRAFT_CREATED', configVersionId, {
        version: next.rows[0]!.version,
        displayName: input.displayName,
        protocol: input.protocol,
        endpoint: input.endpoint,
        model: input.model,
      })
      return publicConfig(result.rows[0]!)
    })
  }

  async updateDraft(input: {
    configVersionId: string
    displayName: string
    protocol: ModelProviderProtocol
    endpoint: string
    model: string
    apiKey: string | null
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<unknown> {
    return this.transaction(async client => {
      const existing = await this.row(client, input.configVersionId, true)
      if (!existing) throw new OfficialModelConfigError('OFFICIAL_MODEL_CONFIG_NOT_FOUND')
      if (existing.status !== 'DRAFT') {
        throw new OfficialModelConfigError('OFFICIAL_MODEL_CONFIG_IMMUTABLE')
      }
      let encrypted = {
        ciphertext: existing.api_key_ciphertext,
        nonce: existing.api_key_nonce,
        authTag: existing.api_key_auth_tag,
      }
      let lastFour = existing.api_key_last_four
      if (input.apiKey) {
        encrypted = encryptCredential(
          input.apiKey,
          this.requiredKey(),
          officialCredentialAad(input.configVersionId),
        )
        lastFour = input.apiKey.slice(-4)
      }
      const result = await client.query<ConfigRow>(
        `UPDATE changfu_admin.official_model_config_versions
            SET display_name = $2, protocol = $3, endpoint = $4, model = $5,
                api_key_ciphertext = $6, api_key_nonce = $7, api_key_auth_tag = $8,
                api_key_last_four = $9, test_status = 'UNTESTED',
                test_error_code = NULL, tested_at = NULL, updated_at = now()
          WHERE config_version_id = $1::uuid
          RETURNING *`,
        [
          input.configVersionId,
          input.displayName,
          input.protocol,
          input.endpoint,
          input.model,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          lastFour,
        ],
      )
      await this.audit(
        client,
        input,
        'OFFICIAL_MODEL_DRAFT_UPDATED',
        input.configVersionId,
        {
          displayName: input.displayName,
          protocol: input.protocol,
          endpoint: input.endpoint,
          model: input.model,
        },
      )
      return publicConfig(result.rows[0]!)
    })
  }

  async effective(configVersionId?: string): Promise<EffectiveOfficialModelConfig | null> {
    const result = configVersionId
      ? await this.rows(this.pool, 'WHERE config_version_id = $1::uuid', [configVersionId])
      : await this.rows(this.pool, `WHERE status = 'ACTIVE'`)
    const row = result[0]
    if (!row) return null
    return {
      configVersionId: row.config_version_id,
      version: row.version,
      displayName: row.display_name,
      protocol: row.protocol,
      endpoint: row.endpoint,
      model: row.model,
      apiKey: decryptCredential(
        {
          ciphertext: row.api_key_ciphertext,
          nonce: row.api_key_nonce,
          authTag: row.api_key_auth_tag,
        },
        this.requiredKey(),
        officialCredentialAad(row.config_version_id),
      ),
    }
  }

  async recordTest(input: {
    configVersionId: string
    succeeded: boolean
    errorCode: string | null
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<unknown> {
    return this.transaction(async client => {
      const result = await client.query<ConfigRow>(
        `UPDATE changfu_admin.official_model_config_versions
            SET test_status = $2, test_error_code = $3, tested_at = now(), updated_at = now()
          WHERE config_version_id = $1::uuid AND status = 'DRAFT'
          RETURNING *`,
        [
          input.configVersionId,
          input.succeeded ? 'SUCCEEDED' : 'FAILED',
          input.errorCode,
        ],
      )
      if (!result.rows[0]) throw new OfficialModelConfigError('OFFICIAL_MODEL_CONFIG_NOT_FOUND')
      await this.audit(
        client,
        input,
        input.succeeded ? 'OFFICIAL_MODEL_TEST_SUCCEEDED' : 'OFFICIAL_MODEL_TEST_FAILED',
        input.configVersionId,
        { testStatus: input.succeeded ? 'SUCCEEDED' : 'FAILED', errorCode: input.errorCode },
      )
      return publicConfig(result.rows[0])
    })
  }

  async activate(input: {
    configVersionId: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<void> {
    await this.transaction(async client => {
      const row = await this.row(client, input.configVersionId, true)
      if (!row) throw new OfficialModelConfigError('OFFICIAL_MODEL_CONFIG_NOT_FOUND')
      if (row.status !== 'DRAFT' || row.test_status !== 'SUCCEEDED') {
        throw new OfficialModelConfigError('OFFICIAL_MODEL_TEST_REQUIRED')
      }
      await client.query(
        `UPDATE changfu_admin.official_model_config_versions
            SET status = 'RETIRED', updated_at = now()
          WHERE status = 'ACTIVE'`,
      )
      await client.query(
        `UPDATE changfu_admin.official_model_config_versions
            SET status = 'ACTIVE', activated_by = $2::uuid,
                activated_at = now(), updated_at = now()
          WHERE config_version_id = $1::uuid`,
        [input.configVersionId, input.actorAdminUserId],
      )
      await this.audit(client, input, 'OFFICIAL_MODEL_ACTIVATED', input.configVersionId, {
        version: row.version,
      })
    })
  }

  async createRollbackDraft(input: {
    configVersionId: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<unknown> {
    const key = this.requiredKey()
    return this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('changfu-official-model-version'))`)
      const source = await this.row(client, input.configVersionId, true)
      if (!source) throw new OfficialModelConfigError('OFFICIAL_MODEL_CONFIG_NOT_FOUND')
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::integer + 1 AS version
           FROM changfu_admin.official_model_config_versions`,
      )
      const configVersionId = randomUUID()
      const apiKey = decryptCredential(
        {
          ciphertext: source.api_key_ciphertext,
          nonce: source.api_key_nonce,
          authTag: source.api_key_auth_tag,
        },
        key,
        officialCredentialAad(source.config_version_id),
      )
      const encrypted = encryptCredential(
        apiKey,
        key,
        officialCredentialAad(configVersionId),
      )
      const result = await client.query<ConfigRow>(
        `INSERT INTO changfu_admin.official_model_config_versions (
           config_version_id, version, display_name, protocol, endpoint, model,
           api_key_ciphertext, api_key_nonce, api_key_auth_tag, api_key_last_four,
           key_version, status, test_status, created_by
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, 'DRAFT', 'UNTESTED', $12::uuid
         )
         RETURNING *`,
        [
          configVersionId,
          next.rows[0]!.version,
          source.display_name,
          source.protocol,
          source.endpoint,
          source.model,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          source.api_key_last_four,
          source.key_version,
          input.actorAdminUserId,
        ],
      )
      await this.audit(client, input, 'OFFICIAL_MODEL_ROLLBACK_DRAFT_CREATED', configVersionId, {
        sourceConfigVersionId: source.config_version_id,
        sourceVersion: source.version,
        version: next.rows[0]!.version,
      })
      return publicConfig(result.rows[0]!)
    })
  }

  async retire(input: {
    configVersionId: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<void> {
    await this.transaction(async client => {
      const result = await client.query<{ version: number }>(
        `UPDATE changfu_admin.official_model_config_versions
            SET status = 'RETIRED', updated_at = now()
          WHERE config_version_id = $1::uuid AND status <> 'RETIRED'
          RETURNING version`,
        [input.configVersionId],
      )
      if (!result.rows[0]) throw new OfficialModelConfigError('OFFICIAL_MODEL_CONFIG_NOT_FOUND')
      await this.audit(client, input, 'OFFICIAL_MODEL_RETIRED', input.configVersionId, {
        version: result.rows[0].version,
      })
    })
  }

  private requiredKey(): Buffer {
    if (!this.encryptionKey) {
      throw new OfficialModelConfigError('MODEL_CREDENTIAL_KEY_MISSING')
    }
    return this.encryptionKey
  }

  private async row(
    queryable: Pool | PoolClient,
    configVersionId: string,
    lock: boolean,
  ): Promise<ConfigRow | null> {
    return (await this.rows(
      queryable,
      `WHERE config_version_id = $1::uuid${lock ? ' FOR UPDATE' : ''}`,
      [configVersionId],
    ))[0] ?? null
  }

  private async rows(
    queryable: Pool | PoolClient,
    where: string,
    values: unknown[] = [],
  ): Promise<ConfigRow[]> {
    const result = await queryable.query<ConfigRow>(
      `SELECT config_version_id, version, display_name, protocol, endpoint, model,
              api_key_ciphertext, api_key_nonce, api_key_auth_tag, api_key_last_four,
              key_version, status, test_status, test_error_code, tested_at,
              activated_at, created_at, updated_at
         FROM changfu_admin.official_model_config_versions
         ${where}
        ORDER BY version DESC`,
      values,
    )
    return result.rows
  }

  private async audit(
    client: PoolClient,
    input: {
      actorAdminUserId: string
      requestId: string
      sourceIp: string | null
    },
    action: string,
    resourceId: string,
    afterSummary: unknown,
  ): Promise<void> {
    if (!this.adminRepository) return
    await this.adminRepository.writeAudit(client, {
      actorAdminUserId: input.actorAdminUserId,
      action,
      resourceType: 'OFFICIAL_MODEL_CONFIG',
      resourceId,
      outcome: 'SUCCESS',
      requestId: input.requestId,
      sourceIp: input.sourceIp,
      afterSummary,
    })
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
