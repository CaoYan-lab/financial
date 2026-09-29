import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { BrokerProvider } from '../../domain/src/contracts.js'

export class LiveTradingConflictError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LiveTradingConflictError'
  }
}

export type ProviderGate = {
  provider: BrokerProvider
  hardGateEnabled: boolean
}

export type ExecutionSetting = ProviderGate & {
  autoSubmitEnabled: boolean
  version: number
  blockers: string[]
  updatedAt?: string
}

const activeOrderStates = [
  'PENDING_CONFIRMATION',
  'CLAIMED',
  'SUBMITTING',
  'SUBMITTED',
  'TRACKING',
  'PARTIALLY_FILLED',
  'CANCEL_REQUESTED',
  'CANCEL_PENDING',
  'CANCEL_UNCERTAIN',
  'UNKNOWN',
] as const

function safeSummary(value: unknown): void {
  const forbidden = /password|secret|token|authorization|private.?key|credential/i
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      if (forbidden.test(key)) throw new LiveTradingConflictError('UNSAFE_EXECUTION_SUMMARY')
      visit(nested)
    }
  }
  visit(value)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function summaryNumber(value: unknown, key: string, fallback: number): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const candidate = Number((value as Record<string, unknown>)[key])
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback
}

function signedIntentProjection(
  row: {
    intent_id: string
    provider: BrokerProvider
    broker_connection_id: string
    submission_mode: 'MANUAL_CONFIRM' | 'AUTO_EXECUTE'
    order_spec: unknown
    signature: string
    signing_key_id: string
    account_id_hash: string
    context_hash: string
    strategy_version: string
    trading_session_id: string | null
    research_pool_version: string
    trading_config_version: string
    risk_policy_version: string
    client_revalidation: unknown
    issued_at: Date
    expires_at: Date
  },
  userId: string,
  deviceId: string,
): unknown {
  return {
    schemaVersion: '2.0',
    intentId: row.intent_id,
    userId,
    deviceId,
    brokerConnectionId: row.broker_connection_id,
    provider: row.provider,
    accountIdHash: row.account_id_hash,
    contextHash: row.context_hash,
    strategyVersion: row.strategy_version,
    sessionId: row.trading_session_id,
    poolVersion: Number(row.research_pool_version),
    configVersion: Number(row.trading_config_version),
    riskPolicyVersion: row.risk_policy_version,
    executionMode: row.submission_mode,
    clientRevalidation: row.client_revalidation,
    order: row.order_spec,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    keyId: row.signing_key_id,
    signature: row.signature,
  }
}

async function lockOrderScope(
  client: PoolClient,
  input: { intentId: string; userId: string; deviceId: string },
): Promise<void> {
  const scope = await client.query<{
    broker_connection_id: string
    normalized_symbol: string
  }>(
    `SELECT broker_connection_id, normalized_symbol
       FROM changfu.pending_orders
      WHERE intent_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid`,
    [input.intentId, input.userId, input.deviceId],
  )
  const row = scope.rows[0]
  if (!row) throw new LiveTradingConflictError('ORDER_NOT_FOUND')
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`live-order:${input.userId}:${row.broker_connection_id}:${row.normalized_symbol}`],
  )
}

export class PostgresLiveTradingRepository {
  constructor(private readonly pool: Pool) {}

  async getExecutionSetting(
    userId: string,
    gate: ProviderGate,
  ): Promise<ExecutionSetting> {
    const [setting, eligibility] = await Promise.all([
      this.pool.query<{ auto_submit_enabled: boolean; version: string }>(
        `SELECT auto_submit_enabled, version
           FROM changfu.user_provider_execution_settings
          WHERE user_id = $1::bigint AND provider = $2`,
        [userId, gate.provider],
      ),
      this.providerEligibility(this.pool, userId, gate.provider),
    ])
    const row = setting.rows[0]
    return {
      ...gate,
      autoSubmitEnabled: row?.auto_submit_enabled ?? false,
      version: Number(row?.version ?? 0),
      blockers: [
        ...(!gate.hardGateEnabled ? ['PROVIDER_HARD_GATE_DISABLED'] : []),
        ...eligibility.blockers,
      ],
    }
  }

  async updateExecutionSetting(input: {
    userId: string
    gate: ProviderGate
    autoSubmitEnabled: boolean
    expectedVersion: number
  }): Promise<ExecutionSetting> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query<{ auto_submit_enabled: boolean; version: string }>(
        `SELECT auto_submit_enabled, version
           FROM changfu.user_provider_execution_settings
          WHERE user_id = $1::bigint AND provider = $2
          FOR UPDATE`,
        [input.userId, input.gate.provider],
      )
      const actualVersion = Number(current.rows[0]?.version ?? 0)
      if (actualVersion !== input.expectedVersion) {
        throw new LiveTradingConflictError('EXECUTION_SETTING_VERSION_CONFLICT')
      }
      const eligibility = await this.providerEligibility(
        client,
        input.userId,
        input.gate.provider,
      )
      const blockers = [
        ...(!input.gate.hardGateEnabled ? ['PROVIDER_HARD_GATE_DISABLED'] : []),
        ...eligibility.blockers,
      ]
      if (input.autoSubmitEnabled && blockers.length > 0) {
        throw new LiveTradingConflictError(blockers[0]!)
      }
      const version = actualVersion + 1
      const saved = await client.query<{ updated_at: Date }>(
        `INSERT INTO changfu.user_provider_execution_settings (
           user_id, provider, auto_submit_enabled, version
         ) VALUES ($1::bigint, $2, $3, $4)
         ON CONFLICT (user_id, provider) DO UPDATE
           SET auto_submit_enabled = EXCLUDED.auto_submit_enabled,
               version = EXCLUDED.version,
               updated_at = now()
         RETURNING updated_at`,
        [input.userId, input.gate.provider, input.autoSubmitEnabled, version],
      )
      await client.query('COMMIT')
      return {
        ...input.gate,
        autoSubmitEnabled: input.autoSubmitEnabled,
        version,
        blockers,
        updatedAt: saved.rows[0]!.updated_at.toISOString(),
      } as ExecutionSetting
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listPendingOrders(
    userId: string,
    deviceId: string,
    brokerConnectionId: string,
  ): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT p.intent_id AS "intentId", p.signal_id AS "signalId",
              p.user_id::text AS "userId", p.device_id::text AS "deviceId",
              p.broker_connection_id AS "brokerConnectionId", p.provider,
              p.account_id_hash AS "accountIdHash", p.context_hash AS "contextHash",
              p.symbol, p.side, p.position_effect AS "positionEffect",
              p.submission_mode AS "submissionMode", p.order_spec AS "order",
              p.state, p.signature, p.signing_key_id AS "keyId", p.version,
              p.strategy_version AS "strategyVersion",
              p.trading_session_id AS "sessionId",
              p.research_pool_version AS "poolVersion",
              p.trading_config_version AS "configVersion",
              p.risk_policy_version AS "riskPolicyVersion",
              p.client_revalidation AS "clientRevalidation",
              p.issued_at AS "issuedAt", p.expires_at AS "expiresAt",
              p.signal_valid_until AS "signalValidUntil",
              p.claim_expires_at AS "claimExpiresAt",
              p.cancel_reason_code AS "cancelReasonCode", p.updated_at AS "updatedAt",
              (
                SELECT execution.broker_order_id
                  FROM changfu.order_executions execution
                 WHERE execution.intent_id = p.intent_id
                   AND execution.broker_order_id IS NOT NULL
                 ORDER BY execution.created_at DESC
                 LIMIT 1
              ) AS "brokerOrderId",
              (
                SELECT execution.execution_id
                  FROM changfu.order_executions execution
                 WHERE execution.intent_id = p.intent_id
                   AND execution.status = 'SUBMITTING'
                 ORDER BY execution.created_at DESC
                 LIMIT 1
              ) AS "executionId",
              (
                SELECT execution.submitted_at
                  FROM changfu.order_executions execution
                 WHERE execution.intent_id = p.intent_id
                   AND execution.submitted_at IS NOT NULL
                 ORDER BY execution.created_at DESC
                 LIMIT 1
              ) AS "submittedAt"
         FROM changfu.pending_orders p
         JOIN changfu.broker_connections c
           ON c.broker_connection_id = p.broker_connection_id
        WHERE p.user_id = $1::bigint
          AND p.device_id = $2::uuid
          AND p.broker_connection_id = $3::uuid
          AND c.user_id = p.user_id
          AND p.state = ANY($4::varchar[])
        ORDER BY p.issued_at`,
      [userId, deviceId, brokerConnectionId, activeOrderStates],
    )
    return result.rows.map(row => ({ ...row, version: Number(row.version) }))
  }

  async claimOrder(input: {
    intentId: string
    userId: string
    deviceId: string
    expectedVersion: number
    gate: ProviderGate
    now?: Date
  }): Promise<{ claimToken: string; expiresAt: string; version: number }> {
    if (!input.gate.hardGateEnabled) {
      throw new LiveTradingConflictError('PROVIDER_HARD_GATE_DISABLED')
    }
    const now = input.now ?? new Date()
    const claimToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(now.getTime() + 60_000)
    const result = await this.pool.query<{ version: string }>(
      `UPDATE changfu.pending_orders p
          SET state = 'CLAIMED', claim_token_hash = $6,
              claim_expires_at = $7::timestamptz, claimed_at = $8::timestamptz,
              version = p.version + 1, updated_at = $8::timestamptz
         FROM changfu.broker_connections c, changfu.trading_leases l
        WHERE p.intent_id = $1::uuid
          AND p.user_id = $2::bigint
          AND p.device_id = $3::uuid
          AND p.version = $4::bigint
          AND p.provider = $5
          AND p.state = 'PENDING_CONFIRMATION'
          AND p.expires_at > $8::timestamptz
          AND p.signal_valid_until > $8::timestamptz
          AND c.broker_connection_id = p.broker_connection_id
          AND c.user_id = p.user_id
          AND c.broker = p.provider
          AND c.environment = 'REAL'
          AND c.status = 'ACTIVE'
          AND l.broker_connection_id = p.broker_connection_id
          AND l.user_id = p.user_id
          AND l.device_id = p.device_id
          AND l.expires_at > $8::timestamptz
          AND EXISTS (
            SELECT 1
              FROM changfu.subscription_broker_slots slot
              JOIN changfu.user_subscriptions subscription
                ON subscription.subscription_id = slot.subscription_id
             WHERE slot.user_id = p.user_id
               AND slot.provider_id = p.provider
               AND slot.status = 'ACTIVE'
               AND subscription.status = 'ACTIVE'
               AND subscription.starts_at <= $8::timestamptz
               AND subscription.expires_at > $8::timestamptz
          )
          AND (
            p.submission_mode = 'MANUAL_CONFIRM'
            OR (
              p.submission_mode = 'AUTO_EXECUTE'
              AND EXISTS (
                SELECT 1
                  FROM changfu.user_provider_execution_settings setting
                 WHERE setting.user_id = p.user_id
                   AND setting.provider = p.provider
                   AND setting.auto_submit_enabled = true
              )
              AND EXISTS (
                SELECT 1
                  FROM changfu.trading_sessions session
                 WHERE session.session_id = p.trading_session_id
                   AND session.broker_connection_id = p.broker_connection_id
                   AND session.user_id = p.user_id
                   AND session.device_id = p.device_id
                   AND session.mode = 'AUTO_EXECUTE'
                   AND session.status = 'ACTIVE'
                   AND session.expires_at > $8::timestamptz
              )
            )
          )
       RETURNING p.version`,
      [
        input.intentId,
        input.userId,
        input.deviceId,
        input.expectedVersion,
        input.gate.provider,
        hashToken(claimToken),
        expiresAt,
        now,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new LiveTradingConflictError('ORDER_CLAIM_PRECONDITION_FAILED')
    return { claimToken, expiresAt: expiresAt.toISOString(), version: Number(row.version) }
  }

  async beginSubmission(input: {
    intentId: string
    userId: string
    deviceId: string
    claimToken: string
    idempotencyKey: string
    brokerRequestHash: string
    gate: ProviderGate
    now?: Date
  }): Promise<{ executionId: string; intent: unknown }> {
    if (!input.gate.hardGateEnabled) {
      throw new LiveTradingConflictError('PROVIDER_HARD_GATE_DISABLED')
    }
    const now = input.now ?? new Date()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const replay = await client.query<{
        execution_id: string
        intent_id: string
        broker_request_hash: string
        provider: BrokerProvider
        broker_connection_id: string
        submission_mode: 'MANUAL_CONFIRM' | 'AUTO_EXECUTE'
        order_spec: unknown
        signature: string
        signing_key_id: string
        account_id_hash: string
        context_hash: string
        strategy_version: string
        trading_session_id: string | null
        research_pool_version: string
        trading_config_version: string
        risk_policy_version: string
        client_revalidation: unknown
        issued_at: Date
        expires_at: Date
      }>(
        `SELECT execution.execution_id, execution.intent_id, execution.broker_request_hash,
                pending.provider, pending.broker_connection_id, pending.submission_mode,
                pending.order_spec, pending.signature, pending.signing_key_id,
                pending.account_id_hash, pending.context_hash, pending.strategy_version,
                pending.trading_session_id, pending.research_pool_version,
                pending.trading_config_version, pending.risk_policy_version,
                pending.client_revalidation, pending.issued_at, pending.expires_at
           FROM changfu.order_executions execution
           JOIN changfu.pending_orders pending ON pending.intent_id = execution.intent_id
          WHERE execution.user_id = $1::bigint
            AND execution.device_id = $2::uuid
            AND execution.idempotency_key = $3`,
        [input.userId, input.deviceId, input.idempotencyKey],
      )
      const previous = replay.rows[0]
      if (previous) {
        if (
          previous.intent_id !== input.intentId
          || previous.broker_request_hash !== input.brokerRequestHash
          || previous.provider !== input.gate.provider
        ) {
          throw new LiveTradingConflictError('SUBMISSION_IDEMPOTENCY_CONFLICT')
        }
        await client.query('COMMIT')
        return {
          executionId: previous.execution_id,
          intent: signedIntentProjection(previous, input.userId, input.deviceId),
        }
      }
      await lockOrderScope(client, input)
      const pending = await client.query<{
        intent_id: string
        provider: BrokerProvider
        broker_connection_id: string
        submission_mode: 'MANUAL_CONFIRM' | 'AUTO_EXECUTE'
        trading_session_id: string | null
        order_spec: unknown
        signature: string
        signing_key_id: string
        account_id_hash: string
        context_hash: string
        strategy_version: string
        research_pool_version: string
        trading_config_version: string
        risk_policy_version: string
        client_revalidation: unknown
        issued_at: Date
        expires_at: Date
      }>(
        `SELECT p.intent_id, p.provider, p.broker_connection_id, p.submission_mode,
                p.trading_session_id, p.order_spec, p.signature, p.signing_key_id,
                p.account_id_hash, p.context_hash, p.strategy_version,
                p.research_pool_version, p.trading_config_version,
                p.risk_policy_version, p.client_revalidation, p.issued_at, p.expires_at
           FROM changfu.pending_orders p
           JOIN changfu.broker_connections c
             ON c.broker_connection_id = p.broker_connection_id
           JOIN changfu.trading_leases l
             ON l.broker_connection_id = p.broker_connection_id
          WHERE p.intent_id = $1::uuid
            AND p.user_id = $2::bigint
            AND p.device_id = $3::uuid
            AND p.provider = $4
            AND p.claim_token_hash = $5
            AND p.claim_expires_at > $6::timestamptz
            AND p.expires_at > $6::timestamptz
            AND p.signal_valid_until > $6::timestamptz
            AND p.state = 'CLAIMED'
            AND c.user_id = p.user_id
            AND c.broker = p.provider
            AND c.environment = 'REAL'
            AND c.status = 'ACTIVE'
            AND l.user_id = p.user_id
            AND l.device_id = p.device_id
            AND l.expires_at > $6::timestamptz
            AND EXISTS (
              SELECT 1
                FROM changfu.subscription_broker_slots slot
                JOIN changfu.user_subscriptions subscription
                  ON subscription.subscription_id = slot.subscription_id
               WHERE slot.user_id = p.user_id
                 AND slot.provider_id = p.provider
                 AND slot.status = 'ACTIVE'
                 AND subscription.status = 'ACTIVE'
                 AND subscription.starts_at <= $6::timestamptz
                 AND subscription.expires_at > $6::timestamptz
            )
            AND (
              p.submission_mode = 'MANUAL_CONFIRM'
              OR EXISTS (
                SELECT 1
                  FROM changfu.user_provider_execution_settings setting
                 WHERE setting.user_id = p.user_id
                   AND setting.provider = p.provider
                   AND setting.auto_submit_enabled = true
              )
            )
          FOR UPDATE OF p`,
        [
          input.intentId,
          input.userId,
          input.deviceId,
          input.gate.provider,
          hashToken(input.claimToken),
          now,
        ],
      )
      const intent = pending.rows[0]
      if (!intent) throw new LiveTradingConflictError('SUBMISSION_PRECONDITION_FAILED')
      if (intent.submission_mode === 'AUTO_EXECUTE') {
        const session = await client.query(
          `SELECT 1 FROM changfu.trading_sessions
            WHERE session_id = $1::uuid
              AND broker_connection_id = $2::uuid
              AND user_id = $3::bigint
              AND device_id = $4::uuid
              AND mode = 'AUTO_EXECUTE'
              AND status = 'ACTIVE'
              AND expires_at > $5::timestamptz`,
          [
            intent.trading_session_id,
            intent.broker_connection_id,
            input.userId,
            input.deviceId,
            now,
          ],
        )
        if (!session.rowCount) throw new LiveTradingConflictError('AUTO_SESSION_REQUIRED')
      }
      const executionId = randomUUID()
      await client.query(
        `INSERT INTO changfu.order_executions (
           execution_id, intent_id, user_id, device_id, idempotency_key,
           broker_request_hash, provider, broker_connection_id, status, requested_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6, $7, $8::uuid,
           'SUBMITTING', $9::timestamptz
         )`,
        [
          executionId,
          input.intentId,
          input.userId,
          input.deviceId,
          input.idempotencyKey,
          input.brokerRequestHash,
          intent.provider,
          intent.broker_connection_id,
          now,
        ],
      )
      await client.query(
        `UPDATE changfu.pending_orders
            SET state = 'SUBMITTING', version = version + 1, updated_at = $4::timestamptz
          WHERE intent_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid`,
        [input.intentId, input.userId, input.deviceId, now],
      )
      await client.query('COMMIT')
      return {
        executionId,
        intent: signedIntentProjection(intent, input.userId, input.deviceId),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async recordExecutionResult(input: {
    executionId: string
    userId: string
    deviceId: string
    status: 'SUBMITTED' | 'FAILED' | 'UNKNOWN'
    brokerOrderId?: string | null
    resultCode?: string | null
    responseSummary?: unknown
    now?: Date
  }): Promise<void> {
    safeSummary(input.responseSummary)
    const now = input.now ?? new Date()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const execution = await client.query<{ intent_id: string }>(
        `UPDATE changfu.order_executions
            SET status = $4, broker_order_id = $5, result_code = $6,
                response_summary = $7::jsonb,
                submitted_at = CASE WHEN $4 = 'SUBMITTED' THEN $8::timestamptz ELSE submitted_at END,
                completed_at = CASE WHEN $4 = 'FAILED' THEN $8::timestamptz ELSE completed_at END,
                updated_at = $8::timestamptz
          WHERE execution_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid
            AND status = 'SUBMITTING'
         RETURNING intent_id`,
        [
          input.executionId,
          input.userId,
          input.deviceId,
          input.status,
          input.brokerOrderId ?? null,
          input.resultCode ?? null,
          JSON.stringify(input.responseSummary ?? {}),
          now,
        ],
      )
      const row = execution.rows[0]
      if (!row) throw new LiveTradingConflictError('EXECUTION_RESULT_CONFLICT')
      const pending = await client.query<{
        provider: BrokerProvider
        broker_connection_id: string
        quantity: string
      }>(
        `UPDATE changfu.pending_orders
            SET state = $4, version = version + 1, updated_at = $5::timestamptz
          WHERE intent_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid
            AND state = 'SUBMITTING'
         RETURNING provider, broker_connection_id, order_spec ->> 'quantity' AS quantity`,
        [row.intent_id, input.userId, input.deviceId, input.status, now],
      )
      const order = pending.rows[0]
      if (!order) throw new LiveTradingConflictError('ORDER_EXECUTION_PROJECTION_CONFLICT')
      const quantity = Number(order.quantity)
      await client.query(
        `INSERT INTO changfu.order_events (
           event_id, intent_id, user_id, broker_order_id, event_type,
           quantity, filled_quantity, average_price, reason_code, occurred_at,
           provider, broker_connection_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::bigint, $4, $5,
           $6, $7, $8, $9, $10::timestamptz, $11, $12::uuid
         )`,
        [
          randomUUID(),
          row.intent_id,
          input.userId,
          input.brokerOrderId ?? null,
          input.status,
          Number.isFinite(quantity) ? quantity : 0,
          summaryNumber(input.responseSummary, 'filledQuantity', 0),
          summaryNumber(input.responseSummary, 'averagePrice', 0) || null,
          input.resultCode ?? null,
          now,
          order.provider,
          order.broker_connection_id,
        ],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async rejectOrder(input: {
    intentId: string
    userId: string
    deviceId: string
    reasonCode: string
  }): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockOrderScope(client, input)
      const result = await client.query(
        `UPDATE changfu.pending_orders pending
            SET state = 'REJECTED', cancel_reason_code = $4,
                claim_token_hash = NULL, claim_expires_at = NULL,
                version = pending.version + 1, updated_at = now()
           FROM changfu.trading_leases lease, changfu.broker_connections connection
          WHERE pending.intent_id = $1::uuid
            AND pending.user_id = $2::bigint
            AND pending.device_id = $3::uuid
            AND pending.state IN ('PENDING_CONFIRMATION', 'CLAIMED')
            AND lease.broker_connection_id = pending.broker_connection_id
            AND lease.user_id = pending.user_id
            AND lease.device_id = pending.device_id
            AND lease.expires_at > now()
            AND connection.broker_connection_id = pending.broker_connection_id
            AND connection.user_id = pending.user_id
            AND connection.broker = pending.provider
            AND connection.environment = 'REAL'
            AND connection.status = 'ACTIVE'`,
        [input.intentId, input.userId, input.deviceId, input.reasonCode],
      )
      if (result.rowCount !== 1) throw new LiveTradingConflictError('ORDER_REJECT_CONFLICT')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async requestCancel(input: {
    intentId: string
    userId: string
    deviceId: string
    reasonCode: string
    idempotencyKey: string
  }): Promise<{ actionId: string }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockOrderScope(client, input)
      const pending = await client.query<{
        provider: BrokerProvider
        broker_connection_id: string
        state: string
      }>(
        `SELECT pending.provider, pending.broker_connection_id, pending.state
           FROM changfu.pending_orders pending
           JOIN changfu.trading_leases lease
             ON lease.broker_connection_id = pending.broker_connection_id
            AND lease.user_id = pending.user_id
            AND lease.device_id = pending.device_id
            AND lease.expires_at > now()
           JOIN changfu.broker_connections connection
             ON connection.broker_connection_id = pending.broker_connection_id
            AND connection.user_id = pending.user_id
            AND connection.broker = pending.provider
            AND connection.environment = 'REAL'
            AND connection.status = 'ACTIVE'
          WHERE pending.intent_id = $1::uuid
            AND pending.user_id = $2::bigint
            AND pending.device_id = $3::uuid
            AND pending.state IN (
              'SUBMITTED', 'TRACKING', 'PARTIALLY_FILLED', 'UNKNOWN',
              'CANCEL_REQUESTED', 'CANCEL_PENDING', 'CANCEL_UNCERTAIN'
            )
          FOR UPDATE OF pending`,
        [input.intentId, input.userId, input.deviceId],
      )
      const row = pending.rows[0]
      if (!row) throw new LiveTradingConflictError('ORDER_CANCEL_PRECONDITION_FAILED')
      if (!row.state.startsWith('CANCEL_')) {
        await client.query(
          `UPDATE changfu.pending_orders
              SET state = 'CANCEL_REQUESTED', cancel_reason_code = $4,
                  last_cancel_requested_at = now(),
                  version = version + 1, updated_at = now()
            WHERE intent_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid`,
          [input.intentId, input.userId, input.deviceId, input.reasonCode],
        )
      }
      const replay = await client.query<{ action_id: string; intent_id: string }>(
        `SELECT action_id, intent_id
           FROM changfu.order_actions
          WHERE user_id = $1::bigint AND idempotency_key = $2`,
        [input.userId, input.idempotencyKey],
      )
      if (replay.rows[0] && replay.rows[0].intent_id !== input.intentId) {
        throw new LiveTradingConflictError('ORDER_ACTION_IDEMPOTENCY_CONFLICT')
      }
      const actionId = replay.rows[0]?.action_id ?? randomUUID()
      const inserted = await client.query<{ action_id: string }>(
        `INSERT INTO changfu.order_actions (
           action_id, intent_id, user_id, device_id, provider, broker_connection_id,
           action_type, reason_code, idempotency_key, state
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6::uuid,
                   'CANCEL', $7, $8, 'PENDING')
         ON CONFLICT DO NOTHING
         RETURNING action_id`,
        [
          actionId,
          input.intentId,
          input.userId,
          input.deviceId,
          row.provider,
          row.broker_connection_id,
          input.reasonCode,
          input.idempotencyKey,
        ],
      )
      const persistedActionId = inserted.rows[0]?.action_id ?? (
        await client.query<{ action_id: string }>(
          `SELECT action_id
             FROM changfu.order_actions
            WHERE intent_id = $1::uuid AND action_type = 'CANCEL'`,
          [input.intentId],
        )
      ).rows[0]?.action_id
      if (!persistedActionId) {
        throw new LiveTradingConflictError('ORDER_ACTION_IDEMPOTENCY_CONFLICT')
      }
      await client.query('COMMIT')
      return { actionId: persistedActionId }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listOrderActions(
    userId: string,
    deviceId: string,
    brokerConnectionId: string,
  ): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT action_id AS "actionId", intent_id AS "intentId", provider,
              broker_connection_id AS "brokerConnectionId", action_type AS "actionType",
              reason_code AS "reasonCode", state, version, created_at AS "createdAt",
              updated_at AS "updatedAt"
         FROM changfu.order_actions
        WHERE user_id = $1::bigint AND device_id = $2::uuid
          AND broker_connection_id = $3::uuid
          AND state IN ('PENDING', 'CLAIMED', 'EXECUTING', 'UNKNOWN')
        ORDER BY created_at`,
      [userId, deviceId, brokerConnectionId],
    )
    return result.rows.map(row => ({ ...row, version: Number(row.version) }))
  }

  async claimOrderAction(input: {
    actionId: string
    userId: string
    deviceId: string
    expectedVersion: number
    now?: Date
  }): Promise<{ claimToken: string; expiresAt: string; version: number }> {
    const now = input.now ?? new Date()
    const claimToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(now.getTime() + 60_000)
    const result = await this.pool.query<{ version: string }>(
      `UPDATE changfu.order_actions action
          SET state = 'CLAIMED', claim_token_hash = $5,
              claim_expires_at = $6::timestamptz,
              version = action.version + 1, updated_at = $7::timestamptz
         FROM changfu.trading_leases lease, changfu.broker_connections connection
        WHERE action.action_id = $1::uuid
          AND action.user_id = $2::bigint
          AND action.device_id = $3::uuid
          AND action.version = $4::bigint
          AND (
            action.state = 'PENDING'
            OR (
              action.state IN ('EXECUTING', 'UNKNOWN')
              AND (
                action.claim_expires_at IS NULL
                OR action.claim_expires_at <= $7::timestamptz
              )
            )
          )
          AND lease.broker_connection_id = action.broker_connection_id
          AND lease.user_id = action.user_id
          AND lease.device_id = action.device_id
          AND lease.expires_at > $7::timestamptz
          AND connection.broker_connection_id = action.broker_connection_id
          AND connection.user_id = action.user_id
          AND connection.broker = action.provider
          AND connection.environment = 'REAL'
          AND connection.status = 'ACTIVE'
       RETURNING action.version`,
      [
        input.actionId,
        input.userId,
        input.deviceId,
        input.expectedVersion,
        hashToken(claimToken),
        expiresAt,
        now,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new LiveTradingConflictError('ORDER_ACTION_CLAIM_CONFLICT')
    return { claimToken, expiresAt: expiresAt.toISOString(), version: Number(row.version) }
  }

  async recordOrderActionResult(input: {
    actionId: string
    userId: string
    deviceId: string
    claimToken: string
    status: 'CANCELLED' | 'CANCEL_PENDING' | 'CANCEL_UNCERTAIN' | 'FILLED' | 'FAILED'
    resultSummary?: unknown
  }): Promise<void> {
    safeSummary(input.resultSummary)
    const actionState = input.status === 'CANCELLED' || input.status === 'FILLED'
      ? 'COMPLETED'
      : input.status === 'CANCEL_UNCERTAIN' || input.status === 'FAILED'
        ? 'UNKNOWN'
        : 'EXECUTING'
    const pendingState = input.status === 'FAILED' ? 'CANCEL_UNCERTAIN' : input.status
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const action = await client.query<{ intent_id: string }>(
        `UPDATE changfu.order_actions
            SET state = $5, result_summary = $6::jsonb,
                version = version + 1, updated_at = now()
          WHERE action_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid
            AND claim_token_hash = $4
            AND state IN ('CLAIMED', 'EXECUTING', 'UNKNOWN')
         RETURNING intent_id`,
        [
          input.actionId,
          input.userId,
          input.deviceId,
          hashToken(input.claimToken),
          actionState,
          JSON.stringify(input.resultSummary ?? {}),
        ],
      )
      const row = action.rows[0]
      if (!row) throw new LiveTradingConflictError('ORDER_ACTION_RESULT_CONFLICT')
      const pending = await client.query<{
        provider: BrokerProvider
        broker_connection_id: string
        quantity: string
        broker_order_id: string | null
      }>(
        `UPDATE changfu.pending_orders AS pending
            SET state = $4,
                cancel_uncertain_since = CASE
                  WHEN $4 = 'CANCEL_UNCERTAIN' AND cancel_uncertain_since IS NULL
                    THEN now()
                  ELSE cancel_uncertain_since
                END,
                reconcile_deadline = CASE
                  WHEN $4 = 'CANCEL_UNCERTAIN' THEN now() + interval '10 minutes'
                  ELSE NULL
                END,
                version = version + 1, updated_at = now()
          WHERE intent_id = $1::uuid AND user_id = $2::bigint AND device_id = $3::uuid
            AND state IN ('CANCEL_REQUESTED', 'CANCEL_PENDING', 'CANCEL_UNCERTAIN')
         RETURNING provider, broker_connection_id, order_spec ->> 'quantity' AS quantity,
                   (
                     SELECT execution.broker_order_id
                       FROM changfu.order_executions execution
                      WHERE execution.intent_id = pending.intent_id
                      ORDER BY execution.created_at DESC
                      LIMIT 1
                   ) AS broker_order_id`,
        [row.intent_id, input.userId, input.deviceId, pendingState],
      )
      const order = pending.rows[0]
      if (!order) {
        const terminal = await client.query<{
          provider: BrokerProvider
          broker_connection_id: string
          quantity: string
          broker_order_id: string | null
        }>(
          `SELECT pending.provider, pending.broker_connection_id,
                  pending.order_spec ->> 'quantity' AS quantity,
                  (
                    SELECT execution.broker_order_id
                      FROM changfu.order_executions execution
                     WHERE execution.intent_id = pending.intent_id
                     ORDER BY execution.created_at DESC
                     LIMIT 1
                  ) AS broker_order_id
             FROM changfu.pending_orders pending
            WHERE pending.intent_id = $1::uuid
              AND pending.user_id = $2::bigint
              AND pending.device_id = $3::uuid
              AND pending.state IN ('FILLED', 'CANCELLED')`,
          [row.intent_id, input.userId, input.deviceId],
        )
        if (!terminal.rows[0]) {
          throw new LiveTradingConflictError('ORDER_ACTION_PROJECTION_CONFLICT')
        }
        await client.query('COMMIT')
        return
      }
      const quantity = Number(order.quantity)
      await client.query(
        `INSERT INTO changfu.order_events (
           event_id, intent_id, user_id, broker_order_id, event_type,
           quantity, filled_quantity, average_price, reason_code, occurred_at,
           provider, broker_connection_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::bigint, $4, $5,
           $6, $7, $8, $9, now(), $10, $11::uuid
         )`,
        [
          randomUUID(),
          row.intent_id,
          input.userId,
          order.broker_order_id,
          pendingState,
          Number.isFinite(quantity) ? quantity : 0,
          summaryNumber(input.resultSummary, 'filledQuantity', 0),
          summaryNumber(input.resultSummary, 'averagePrice', 0) || null,
          input.status === 'FAILED' ? 'CANCEL_EXECUTION_FAILED' : null,
          order.provider,
          order.broker_connection_id,
        ],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async providerEligibility(
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    userId: string,
    provider: BrokerProvider,
  ): Promise<{ blockers: string[] }> {
    const result = await queryable.query<{
      subscription_active: boolean
      slot_active: boolean
      real_connection_active: boolean
    }>(
      `SELECT
         EXISTS (
           SELECT 1
             FROM changfu.user_subscriptions subscription
            WHERE subscription.user_id = $1::bigint
              AND subscription.status = 'ACTIVE'
              AND subscription.starts_at <= now()
              AND subscription.expires_at > now()
         ) AS subscription_active,
         EXISTS (
           SELECT 1
             FROM changfu.subscription_broker_slots slot
             JOIN changfu.user_subscriptions subscription
               ON subscription.subscription_id = slot.subscription_id
            WHERE slot.user_id = $1::bigint
              AND slot.provider_id = $2
              AND slot.status = 'ACTIVE'
              AND subscription.status = 'ACTIVE'
              AND subscription.starts_at <= now()
              AND subscription.expires_at > now()
         ) AS slot_active,
         EXISTS (
           SELECT 1
             FROM changfu.broker_connections connection
            WHERE connection.user_id = $1::bigint
              AND connection.broker = $2
              AND connection.environment = 'REAL'
              AND connection.status = 'ACTIVE'
         ) AS real_connection_active`,
      [userId, provider],
    )
    const row = result.rows[0]
    return {
      blockers: [
        ...(!row?.subscription_active ? ['SUBSCRIPTION_INACTIVE'] : []),
        ...(!row?.slot_active ? ['PROVIDER_SLOT_INACTIVE'] : []),
        ...(!row?.real_connection_active ? ['REAL_CONNECTION_REQUIRED'] : []),
      ],
    }
  }
}
