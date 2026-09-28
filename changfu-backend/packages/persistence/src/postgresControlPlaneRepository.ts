import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { BrokerProvider } from '../../domain/src/contracts.js'

export type TradingConfigData = {
  catalogVersion: string
  executionMode: 'DIRECT' | 'CANDIDATE_POOL'
  confirmationMode: 'MANUAL_CONFIRM' | 'AUTO_EXECUTE_PREFERENCE'
  models: {
    singleDecision: string
    portfolioReview: string
    managedOrderReview: string
  }
  strategyId: string
  singlePromptId: string
  portfolioPromptId: string
  managedOrderPromptId: string
  scanIntervalSeconds: number
  portfolioReviewIntervalSeconds: number
  candidateTtlSeconds: number
  maxConcurrency: number
  disableUsOvernightEvaluation: boolean
  riskPolicyId: string
}

export class ControlPlaneConflictError extends Error {
  constructor(readonly code: string) {
    super('控制面资源版本或状态冲突')
    this.name = 'ControlPlaneConflictError'
  }
}

export class PostgresControlPlaneRepository {
  constructor(private readonly pool: Pool) {}

  async listBrokerConnections(userId: string): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT broker_connection_id AS "brokerConnectionId", broker AS provider,
              display_name AS "displayName", environment, status, updated_at AS "updatedAt"
         FROM changfu.broker_connections
        WHERE user_id = $1::bigint AND status <> 'DELETED'
        ORDER BY updated_at DESC`,
      [userId],
    )
    return result.rows
  }

  async upsertBrokerConnection(input: {
    userId: string
    provider: BrokerProvider
    accountIdHash: string
    environment: 'SIMULATE' | 'REAL'
    displayName: string
  }): Promise<unknown> {
    const result = await this.pool.query(
      `INSERT INTO changfu.broker_connections (
         broker_connection_id, user_id, broker, display_name,
         account_id_hash, environment, status
       ) VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, 'ACTIVE')
       ON CONFLICT (user_id, broker, account_id_hash, environment) DO UPDATE
         SET display_name = EXCLUDED.display_name, status = 'ACTIVE', updated_at = now()
       RETURNING broker_connection_id AS "brokerConnectionId", broker AS provider,
                 display_name AS "displayName", environment, status`,
      [
        randomUUID(),
        input.userId,
        input.provider,
        input.displayName,
        input.accountIdHash,
        input.environment,
      ],
    )
    return result.rows[0]
  }

  async updateBrokerConnection(input: {
    userId: string
    brokerConnectionId: string
    displayName?: string
    status?: 'ACTIVE' | 'DISABLED' | 'DELETED'
  }): Promise<unknown> {
    const result = await this.pool.query(
      `UPDATE changfu.broker_connections
          SET display_name = COALESCE($3, display_name),
              status = COALESCE($4, status),
              updated_at = now()
        WHERE broker_connection_id = $1::uuid AND user_id = $2::bigint
       RETURNING broker_connection_id AS "brokerConnectionId", broker AS provider,
                 display_name AS "displayName", environment, status`,
      [input.brokerConnectionId, input.userId, input.displayName ?? null, input.status ?? null],
    )
    if (!result.rows[0]) throw new ControlPlaneConflictError('BROKER_CONNECTION_NOT_FOUND')
    return result.rows[0]
  }

  async getResearchPool(userId: string): Promise<unknown> {
    const entitlement = await this.pool.query<{
      status: string
      plan_name: string | null
      capacity: number
      replacement_limit: number
      replacement_used: number
      renews_at: Date | null
    }>(
      `SELECT status, plan_name, capacity, replacement_limit, replacement_used, renews_at
         FROM changfu.research_entitlements WHERE user_id = $1::bigint`,
      [userId],
    )
    const pool = await this.pool.query<{ version: string; updated_at: Date }>(
      `SELECT version, updated_at FROM changfu.research_pools WHERE user_id = $1::bigint`,
      [userId],
    )
    const items = await this.pool.query(
      `SELECT symbol, market, instrument_type AS "instrumentType", added_at AS "addedAt"
         FROM changfu.research_pool_items
        WHERE user_id = $1::bigint ORDER BY added_at, symbol`,
      [userId],
    )
    const rights = entitlement.rows[0]
    const current = pool.rows[0]
    return {
      entitlement: rights
        ? {
            status: rights.status,
            planName: rights.plan_name,
            capacity: rights.capacity,
            replacementLimit: rights.replacement_limit,
            replacementUsed: rights.replacement_used,
            renewsAt: rights.renews_at?.toISOString() ?? null,
          }
        : {
            status: 'UNAVAILABLE',
            planName: null,
            capacity: 0,
            replacementLimit: 0,
            replacementUsed: 0,
            renewsAt: null,
          },
      version: Number(current?.version ?? 1),
      items: items.rows,
      updatedAt: current?.updated_at.toISOString() ?? new Date(0).toISOString(),
    }
  }

  async addResearchPoolItem(input: {
    userId: string
    symbol: string
    market: 'US' | 'HK'
    instrumentType: 'STOCK' | 'ETF'
  }): Promise<unknown> {
    return this.mutateResearchPool(input.userId, async client => {
      const entitlement = await this.lockEntitlement(client, input.userId)
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM changfu.research_pool_items
          WHERE user_id = $1::bigint`,
        [input.userId],
      )
      if (Number(count.rows[0]?.count ?? 0) >= entitlement.capacity) {
        throw new ControlPlaneConflictError('RESEARCH_POOL_CAPACITY_EXCEEDED')
      }
      const inserted = await client.query(
        `INSERT INTO changfu.research_pool_items (
           user_id, symbol, market, instrument_type
         ) VALUES ($1::bigint, $2, $3, $4)
         ON CONFLICT (user_id, symbol) DO NOTHING`,
        [input.userId, input.symbol, input.market, input.instrumentType],
      )
      if (inserted.rowCount !== 1) throw new ControlPlaneConflictError('RESEARCH_SYMBOL_EXISTS')
    })
  }

  async removeResearchPoolItem(userId: string, symbol: string): Promise<unknown> {
    return this.mutateResearchPool(userId, async client => {
      await this.lockEntitlement(client, userId)
      const removed = await client.query(
        `DELETE FROM changfu.research_pool_items
          WHERE user_id = $1::bigint AND symbol = $2`,
        [userId, symbol],
      )
      if (removed.rowCount !== 1) throw new ControlPlaneConflictError('RESEARCH_SYMBOL_NOT_FOUND')
    })
  }

  async replaceResearchPoolItem(input: {
    userId: string
    oldSymbol: string
    symbol: string
    market: 'US' | 'HK'
    instrumentType: 'STOCK' | 'ETF'
  }): Promise<unknown> {
    return this.mutateResearchPool(input.userId, async client => {
      const entitlement = await this.lockEntitlement(client, input.userId)
      if (entitlement.replacement_used >= entitlement.replacement_limit) {
        throw new ControlPlaneConflictError('RESEARCH_REPLACEMENT_LIMIT_EXCEEDED')
      }
      const removed = await client.query(
        `DELETE FROM changfu.research_pool_items
          WHERE user_id = $1::bigint AND symbol = $2`,
        [input.userId, input.oldSymbol],
      )
      if (removed.rowCount !== 1) throw new ControlPlaneConflictError('RESEARCH_SYMBOL_NOT_FOUND')
      const inserted = await client.query(
        `INSERT INTO changfu.research_pool_items (
           user_id, symbol, market, instrument_type
         ) VALUES ($1::bigint, $2, $3, $4)
         ON CONFLICT (user_id, symbol) DO NOTHING`,
        [input.userId, input.symbol, input.market, input.instrumentType],
      )
      if (inserted.rowCount !== 1) throw new ControlPlaneConflictError('RESEARCH_SYMBOL_EXISTS')
      await client.query(
        `UPDATE changfu.research_entitlements
            SET replacement_used = replacement_used + 1, updated_at = now()
          WHERE user_id = $1::bigint`,
        [input.userId],
      )
    })
  }

  private async lockEntitlement(
    client: PoolClient,
    userId: string,
  ): Promise<{ capacity: number; replacement_limit: number; replacement_used: number }> {
    const result = await client.query<{
      capacity: number
      replacement_limit: number
      replacement_used: number
    }>(
      `SELECT capacity, replacement_limit, replacement_used
         FROM changfu.research_entitlements
        WHERE user_id = $1::bigint AND status = 'ACTIVE'
          AND (renews_at IS NULL OR renews_at > now())
        FOR UPDATE`,
      [userId],
    )
    const row = result.rows[0]
    if (!row) throw new ControlPlaneConflictError('RESEARCH_ENTITLEMENT_INACTIVE')
    return row
  }

  private async mutateResearchPool(
    userId: string,
    mutation: (client: PoolClient) => Promise<void>,
  ): Promise<unknown> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await mutation(client)
      const version = await client.query<{ version: string; updated_at: Date }>(
        `INSERT INTO changfu.research_pools (user_id, version)
         VALUES ($1::bigint, 1)
         ON CONFLICT (user_id) DO UPDATE
           SET version = changfu.research_pools.version + 1, updated_at = now()
         RETURNING version, updated_at`,
        [userId],
      )
      await client.query('COMMIT')
      return {
        version: Number(version.rows[0]!.version),
        updatedAt: version.rows[0]!.updated_at.toISOString(),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getTradingConfig(userId: string, brokerConnectionId: string): Promise<unknown | null> {
    const result = await this.pool.query<{
      provider: BrokerProvider
      version: string
      config: TradingConfigData
    }>(
      `SELECT provider, version, config
         FROM changfu.trading_configs
        WHERE user_id = $1::bigint AND broker_connection_id = $2::uuid`,
      [userId, brokerConnectionId],
    )
    const row = result.rows[0]
    return row ? {
      brokerConnectionId,
      provider: row.provider,
      version: Number(row.version),
      ...row.config,
    } : null
  }

  async listModelRuns(
    userId: string,
    brokerConnectionId: string,
    limit: number,
    offset = 0,
  ): Promise<{ items: unknown[]; total: number }> {
    const [result, count] = await Promise.all([
      this.pool.query(
      `SELECT request_id AS "requestId",
              broker_connection_id AS "brokerConnectionId", purpose, model,
              prompt_version AS "promptVersion", status, result, error_code AS "errorCode",
              requested_symbols AS "requestedSymbols",
              captured_at AS "capturedAt", source_expires_at AS "sourceExpiresAt",
              started_at AS "startedAt", finished_at AS "finishedAt"
         FROM changfu.model_runs
        WHERE user_id = $1::bigint AND broker_connection_id = $2::uuid
        ORDER BY started_at DESC
        LIMIT $3 OFFSET $4`,
        [userId, brokerConnectionId, limit, offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM changfu.model_runs
          WHERE user_id = $1::bigint AND broker_connection_id = $2::uuid`,
        [userId, brokerConnectionId],
      ),
    ])
    return {
      items: result.rows,
      total: Number(count.rows[0]?.total ?? 0),
    }
  }

  async getModelRun(userId: string, requestId: string): Promise<unknown | null> {
    const result = await this.pool.query(
      `SELECT request_id AS "requestId", broker_connection_id AS "brokerConnectionId",
              purpose, model, prompt_version AS "promptVersion", status, result,
              error_code AS "errorCode", requested_symbols AS "requestedSymbols",
              captured_at AS "capturedAt",
              source_expires_at AS "sourceExpiresAt", started_at AS "startedAt",
              finished_at AS "finishedAt"
         FROM changfu.model_runs
        WHERE user_id = $1::bigint AND request_id = $2::uuid`,
      [userId, requestId],
    )
    return result.rows[0] ?? null
  }

  async listSignals(
    userId: string,
    brokerConnectionId: string,
    limit: number,
  ): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT signal_id AS "signalId", request_id AS "requestId",
              broker_connection_id AS "brokerConnectionId", symbol, action,
              evidence_summary AS "evidenceSummary", risk_summary AS "riskSummary",
              exit_condition AS "exitCondition", created_at AS "createdAt"
         FROM changfu.signals
        WHERE user_id = $1::bigint AND broker_connection_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, brokerConnectionId, limit],
    )
    return result.rows
  }

  async listCandidates(
    userId: string,
    brokerConnectionId: string,
    limit: number,
  ): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT candidate.candidate_id AS "candidateId", candidate.signal_id AS "signalId",
              candidate.broker_connection_id AS "brokerConnectionId",
              candidate.symbol, candidate.side, candidate.status, candidate.rank,
              candidate.pool_version AS "poolVersion",
              candidate.config_version AS "configVersion",
              candidate.created_at AS "createdAt", candidate.expires_at AS "expiresAt",
              candidate.updated_at AS "updatedAt"
         FROM changfu.candidate_pool_items candidate
         JOIN changfu.trading_configs config
           ON config.user_id = candidate.user_id
          AND config.broker_connection_id = candidate.broker_connection_id
        WHERE candidate.user_id = $1::bigint
          AND candidate.broker_connection_id = $2::uuid
          AND config.config ->> 'executionMode' = 'CANDIDATE_POOL'
          AND candidate.config_version = config.version
        ORDER BY
          CASE candidate.status
            WHEN 'PROMOTED' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'WATCH' THEN 2 ELSE 3
          END,
          candidate.rank NULLS LAST, candidate.created_at DESC
        LIMIT $3`,
      [userId, brokerConnectionId, limit],
    )
    return result.rows.map(row => ({
      ...row,
      poolVersion: Number(row.poolVersion),
      configVersion: Number(row.configVersion),
    }))
  }

  async putTradingConfig(input: {
    userId: string
    brokerConnectionId: string
    expectedVersion: number
    config: TradingConfigData
  }): Promise<unknown> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const owner = await client.query<{ broker: BrokerProvider }>(
        `SELECT broker FROM changfu.broker_connections
          WHERE broker_connection_id = $1::uuid AND user_id = $2::bigint
            AND status = 'ACTIVE' FOR UPDATE`,
        [input.brokerConnectionId, input.userId],
      )
      const connection = owner.rows[0]
      if (!connection) throw new ControlPlaneConflictError('BROKER_CONNECTION_NOT_FOUND')

      const current = await client.query<{ version: string }>(
        `SELECT version FROM changfu.trading_configs
          WHERE broker_connection_id = $1::uuid FOR UPDATE`,
        [input.brokerConnectionId],
      )
      const actualVersion = Number(current.rows[0]?.version ?? 0)
      if (actualVersion !== input.expectedVersion) {
        throw new ControlPlaneConflictError('TRADING_CONFIG_VERSION_CONFLICT')
      }
      const version = actualVersion + 1
      const configJson = JSON.stringify(input.config)
      await client.query(
        `INSERT INTO changfu.trading_configs (
           broker_connection_id, user_id, provider, version, catalog_version,
           execution_mode, confirmation_mode, config
         ) VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (broker_connection_id) DO UPDATE
           SET version = EXCLUDED.version, catalog_version = EXCLUDED.catalog_version,
               execution_mode = EXCLUDED.execution_mode,
               confirmation_mode = EXCLUDED.confirmation_mode,
               config = EXCLUDED.config, updated_at = now()`,
        [
          input.brokerConnectionId,
          input.userId,
          connection.broker,
          version,
          input.config.catalogVersion,
          input.config.executionMode,
          input.config.confirmationMode,
          configJson,
        ],
      )
      await client.query(
        `INSERT INTO changfu.trading_config_versions (
           broker_connection_id, user_id, version, catalog_version, config
         ) VALUES ($1::uuid, $2::bigint, $3, $4, $5::jsonb)`,
        [
          input.brokerConnectionId,
          input.userId,
          version,
          input.config.catalogVersion,
          configJson,
        ],
      )
      await client.query('COMMIT')
      return {
        brokerConnectionId: input.brokerConnectionId,
        provider: connection.broker,
        version,
        ...input.config,
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async activateTradingSession(input: {
    userId: string
    deviceId: string
    brokerConnectionId: string
    configVersion: number
    riskPolicyVersion: string
    confirmationDigest: string
    appSessionId: string
    now?: Date
  }): Promise<unknown> {
    const now = input.now ?? new Date()
    const expiresAt = new Date(now.getTime() + 90_000)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE changfu.trading_sessions SET status = 'EXPIRED', updated_at = $3::timestamptz
          WHERE broker_connection_id = $1::uuid AND user_id = $2::bigint
            AND status = 'ACTIVE' AND expires_at <= $3::timestamptz`,
        [input.brokerConnectionId, input.userId, now],
      )
      const active = await client.query(
        `SELECT 1 FROM changfu.trading_sessions
          WHERE broker_connection_id = $1::uuid AND user_id = $2::bigint
            AND status = 'ACTIVE' FOR UPDATE`,
        [input.brokerConnectionId, input.userId],
      )
      if (active.rowCount) throw new ControlPlaneConflictError('TRADING_SESSION_ALREADY_ACTIVE')
      const result = await client.query<{ session_id: string }>(
        `INSERT INTO changfu.trading_sessions (
           session_id, broker_connection_id, user_id, device_id, app_session_id,
           mode, status, config_version, risk_policy_version, confirmation_digest,
           expires_at
         )
         SELECT $1::uuid, c.broker_connection_id, c.user_id, $3::uuid, $4::uuid,
                'AUTO_EXECUTE', 'ACTIVE', $5, $6, $7, $8::timestamptz
           FROM changfu.trading_configs c
          WHERE c.broker_connection_id = $2::uuid AND c.user_id = $9::bigint
            AND c.version = $5 AND c.confirmation_mode = 'AUTO_EXECUTE_PREFERENCE'
         RETURNING session_id`,
        [
          randomUUID(),
          input.brokerConnectionId,
          input.deviceId,
          input.appSessionId,
          input.configVersion,
          input.riskPolicyVersion,
          input.confirmationDigest,
          expiresAt,
          input.userId,
        ],
      )
      const session = result.rows[0]
      if (!session) throw new ControlPlaneConflictError('AUTO_SESSION_PRECONDITION_FAILED')
      await client.query('COMMIT')
      return {
        sessionId: session.session_id,
        brokerConnectionId: input.brokerConnectionId,
        deviceId: input.deviceId,
        mode: 'AUTO_EXECUTE',
        status: 'ACTIVE',
        configVersion: input.configVersion,
        riskPolicyVersion: input.riskPolicyVersion,
        appSessionId: input.appSessionId,
        expiresAt: expiresAt.toISOString(),
        version: 1,
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async renewTradingSession(input: {
    userId: string
    deviceId: string
    sessionId: string
    now?: Date
  }): Promise<unknown> {
    const now = input.now ?? new Date()
    const expiresAt = new Date(now.getTime() + 90_000)
    const result = await this.pool.query<{
      broker_connection_id: string
      config_version: string
      risk_policy_version: string
      app_session_id: string
      version: string
    }>(
      `UPDATE changfu.trading_sessions
          SET expires_at = $4::timestamptz, version = version + 1, updated_at = $3::timestamptz
        WHERE session_id = $1::uuid AND user_id = $2::bigint AND device_id = $5::uuid
          AND status = 'ACTIVE' AND expires_at > $3::timestamptz
       RETURNING broker_connection_id, config_version, risk_policy_version, app_session_id, version`,
      [input.sessionId, input.userId, now, expiresAt, input.deviceId],
    )
    const row = result.rows[0]
    if (!row) throw new ControlPlaneConflictError('TRADING_SESSION_EXPIRED')
    return {
      sessionId: input.sessionId,
      brokerConnectionId: row.broker_connection_id,
      deviceId: input.deviceId,
      mode: 'AUTO_EXECUTE',
      status: 'ACTIVE',
      configVersion: Number(row.config_version),
      riskPolicyVersion: row.risk_policy_version,
      appSessionId: row.app_session_id,
      expiresAt: expiresAt.toISOString(),
      version: Number(row.version),
    }
  }

  async deactivateTradingSession(input: {
    userId: string
    deviceId: string
    sessionId: string
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE changfu.trading_sessions
          SET status = 'DEACTIVATED', updated_at = now(), version = version + 1
        WHERE session_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid
          AND status = 'ACTIVE'`,
      [input.sessionId, input.userId, input.deviceId],
    )
    if (result.rowCount !== 1) throw new ControlPlaneConflictError('TRADING_SESSION_NOT_ACTIVE')
  }

  async getCurrentTradingSession(
    userId: string,
    brokerConnectionId: string,
    now = new Date(),
  ): Promise<unknown | null> {
    const result = await this.pool.query<{
      session_id: string
      device_id: string
      config_version: string
      risk_policy_version: string
      app_session_id: string
      expires_at: Date
      version: string
    }>(
      `SELECT session_id, device_id, config_version, risk_policy_version,
              app_session_id, expires_at, version
         FROM changfu.trading_sessions
        WHERE broker_connection_id = $1::uuid AND user_id = $2::bigint
          AND status = 'ACTIVE' AND expires_at > $3::timestamptz`,
      [brokerConnectionId, userId, now],
    )
    const row = result.rows[0]
    return row ? {
      sessionId: row.session_id,
      brokerConnectionId,
      deviceId: row.device_id,
      mode: 'AUTO_EXECUTE',
      status: 'ACTIVE',
      configVersion: Number(row.config_version),
      riskPolicyVersion: row.risk_policy_version,
      appSessionId: row.app_session_id,
      expiresAt: row.expires_at.toISOString(),
      version: Number(row.version),
    } : null
  }
}
