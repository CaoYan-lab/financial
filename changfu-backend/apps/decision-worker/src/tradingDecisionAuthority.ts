import type { Pool } from 'pg'
import {
  resolvePrompt,
  type DecisionRole,
  type TradingCatalog,
} from '../../../packages/catalog/src/tradingCatalog.js'
import type {
  BrokerProvider,
  ContextEnvelope,
} from '../../../packages/domain/src/contracts.js'
import type { TradingConfigData } from '../../../packages/persistence/src/postgresControlPlaneRepository.js'

export type AuthorizedCandidate = {
  candidateId: string
  symbol: string
  side: 'BUY' | 'SELL'
  status: 'PENDING' | 'WATCH'
  rank: number | null
  expiresAt: string
}

export type ResolvedTradingDecision = {
  role: DecisionRole
  provider: BrokerProvider
  brokerConnectionId: string
  catalogVersion: string
  configVersion: number
  researchPoolVersion: number
  executionMode: TradingConfigData['executionMode']
  confirmationMode: TradingConfigData['confirmationMode']
  candidateTtlSeconds: number
  strategyId: string
  riskPolicyId: string
  requestedSymbols: string[]
  candidates: AuthorizedCandidate[]
  accountIdHash?: string
  environment?: 'SIMULATE' | 'REAL'
  instrument?: {
    market: 'US' | 'HK'
    instrumentType: 'STOCK' | 'ETF'
  } | null
  hardGateEnabled?: boolean
  autoSubmitEnabled?: boolean
  submissionMode?: 'MANUAL_CONFIRM' | 'AUTO_EXECUTE'
  tradingSessionId?: string | null
  model: {
    id: string
    deploymentId: string
  }
  prompt: {
    id: string
    version: string
    body: string
  }
}

export class TradingAuthorityError extends Error {
  constructor(readonly code: string) {
    super('交易决策权威配置校验失败')
    this.name = 'TradingAuthorityError'
  }
}

export interface TradingDecisionAuthority {
  resolve(userId: string, context: ContextEnvelope): Promise<ResolvedTradingDecision | null>
}

function isTradingConfig(value: unknown): value is TradingConfigData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const config = value as Partial<TradingConfigData>
  const models = config.models
  return (
    typeof config.catalogVersion === 'string'
    && (config.executionMode === 'DIRECT' || config.executionMode === 'CANDIDATE_POOL')
    && (
      config.confirmationMode === 'MANUAL_CONFIRM'
      || config.confirmationMode === 'AUTO_EXECUTE_PREFERENCE'
    )
    && typeof models?.singleDecision === 'string'
    && typeof models.portfolioReview === 'string'
    && typeof models.managedOrderReview === 'string'
    && typeof config.strategyId === 'string'
    && typeof config.singlePromptId === 'string'
    && typeof config.portfolioPromptId === 'string'
    && typeof config.managedOrderPromptId === 'string'
    && Number.isInteger(config.candidateTtlSeconds)
    && Number(config.candidateTtlSeconds) >= 60
    && typeof config.riskPolicyId === 'string'
  )
}

function deploymentId(value: string): string {
  if (!value.startsWith('env:')) return value
  const resolved = process.env[value.slice('env:'.length)]
  if (!resolved) throw new TradingAuthorityError('MODEL_DEPLOYMENT_MISSING')
  return resolved
}

export class PostgresTradingDecisionAuthority implements TradingDecisionAuthority {
  constructor(
    private readonly pool: Pool,
    private readonly catalog: TradingCatalog,
    private readonly liveTradingGates: Readonly<Record<BrokerProvider, boolean>> = {
      FUTU: false,
      LONGBRIDGE: false,
    },
  ) {}

  async resolve(userId: string, context: ContextEnvelope): Promise<ResolvedTradingDecision | null> {
    if (context.purpose === 'CHAT' || context.purpose === 'REPORT') return null
    if (context.schemaVersion !== '2.0') {
      throw new TradingAuthorityError('TRADING_CONTEXT_VERSION_INVALID')
    }

    const authority = await this.pool.query<{
      provider: BrokerProvider
      config_provider: BrokerProvider
      config_version: string
      catalog_version: string
      config: unknown
      entitlement_status: string | null
      pool_version: string | null
      account_id_hash: string
      environment: 'SIMULATE' | 'REAL'
      auto_submit_enabled: boolean
    }>(
      `SELECT c.broker AS provider, t.provider AS config_provider,
              t.version AS config_version,
              t.catalog_version, t.config,
              s.status AS entitlement_status, p.version AS pool_version,
              c.account_id_hash, c.environment,
              COALESCE(setting.auto_submit_enabled, false) AS auto_submit_enabled
         FROM changfu.broker_connections c
         JOIN changfu.trading_configs t
           ON t.broker_connection_id = c.broker_connection_id
          AND t.user_id = c.user_id
         JOIN changfu.user_subscriptions s
           ON s.user_id = c.user_id
          AND s.status = 'ACTIVE'
          AND s.starts_at <= now()
          AND now() < s.expires_at
         JOIN changfu.subscription_broker_slots slot
           ON slot.subscription_id = s.subscription_id
          AND slot.user_id = s.user_id
          AND slot.provider_id = c.broker
          AND slot.status = 'ACTIVE'
         JOIN changfu.provider_research_pools p
           ON p.user_id = c.user_id
          AND p.provider_id = c.broker
          AND p.status = 'ACTIVE'
         LEFT JOIN changfu.user_provider_execution_settings setting
           ON setting.user_id = c.user_id
          AND setting.provider = c.broker
        WHERE c.broker_connection_id = $1::uuid
          AND c.user_id = $2::bigint
          AND c.status = 'ACTIVE'`,
      [context.brokerConnectionId, userId],
    )
    const row = authority.rows[0]
    if (!row) throw new TradingAuthorityError('BROKER_OR_CONFIG_NOT_FOUND')
    if (row.provider !== context.provider) {
      throw new TradingAuthorityError('BROKER_PROVIDER_MISMATCH')
    }
    if (row.config_provider !== row.provider || !isTradingConfig(row.config)) {
      throw new TradingAuthorityError('TRADING_CONFIG_INVALID')
    }
    const configVersion = Number(row.config_version)
    const poolVersion = Number(row.pool_version)
    if (configVersion !== context.tradingConfigVersion) {
      throw new TradingAuthorityError('TRADING_CONFIG_VERSION_MISMATCH')
    }
    if (
      row.catalog_version !== context.catalogVersion
      || row.catalog_version !== this.catalog.catalogVersion
    ) {
      throw new TradingAuthorityError('TRADING_CATALOG_VERSION_MISMATCH')
    }
    if (row.entitlement_status !== 'ACTIVE') {
      throw new TradingAuthorityError('RESEARCH_ENTITLEMENT_INACTIVE')
    }
    if (poolVersion !== context.researchPoolVersion) {
      throw new TradingAuthorityError('RESEARCH_POOL_VERSION_MISMATCH')
    }
    if (
      context.account.accountIdHash !== row.account_id_hash
      || context.account.environment !== row.environment
    ) {
      throw new TradingAuthorityError('BROKER_ACCOUNT_BINDING_MISMATCH')
    }

    const requestedSymbols = context.requestedSymbols ?? []
    if (context.purpose === 'SINGLE_DECISION' && requestedSymbols.length !== 1) {
      throw new TradingAuthorityError('SINGLE_DECISION_REQUIRES_ONE_SYMBOL')
    }
    const poolItems = await this.pool.query<{
      symbol: string
      market: 'US' | 'HK' | 'CN' | 'SG'
      instrument_type: 'STOCK' | 'ETF' | 'OPTION'
    }>(
      `SELECT canonical_symbol AS symbol, market, instrument_type
         FROM changfu.provider_research_pool_items
        WHERE user_id = $1::bigint AND provider_id = $2
          AND canonical_symbol = ANY($3::text[])
          AND status = 'ACTIVE'`,
      [userId, row.provider, requestedSymbols],
    )
    if (
      poolItems.rows.length !== requestedSymbols.length
      || !requestedSymbols.every(symbol => poolItems.rows.some(item => item.symbol === symbol))
    ) {
      throw new TradingAuthorityError('REQUESTED_SYMBOL_NOT_IN_RESEARCH_POOL')
    }

    const role = context.purpose
    const config = row.config
    if (poolItems.rows.some(item => item.instrument_type === 'OPTION')) {
      throw new TradingAuthorityError('INSTRUMENT_NOT_TRADABLE_IN_PHASE_2')
    }
    if (config.catalogVersion !== row.catalog_version) {
      throw new TradingAuthorityError('TRADING_CONFIG_CATALOG_MISMATCH')
    }
    const modelId = role === 'SINGLE_DECISION'
      ? config.models.singleDecision
      : role === 'PORTFOLIO_REVIEW'
        ? config.models.portfolioReview
        : config.models.managedOrderReview
    const promptId = role === 'SINGLE_DECISION'
      ? config.singlePromptId
      : role === 'PORTFOLIO_REVIEW'
        ? config.portfolioPromptId
        : config.managedOrderPromptId
    const model = this.catalog.models.find(item => item.id === modelId && item.roles.includes(role))
    if (!model) throw new TradingAuthorityError('MODEL_ROLE_NOT_AUTHORIZED')
    const prompt = resolvePrompt(this.catalog, promptId, role)
    const strategy = this.catalog.strategies.find(item => item.id === config.strategyId)
    if (
      !strategy
      || !strategy.providers.includes(row.provider)
      || poolItems.rows.some(item => (
        (item.market !== 'US' && item.market !== 'HK')
        || !strategy.markets.includes(item.market as 'US' | 'HK')
        || !strategy.instrumentTypes.includes(item.instrument_type as 'STOCK' | 'ETF')
      ))
    ) {
      throw new TradingAuthorityError('STRATEGY_SCOPE_NOT_AUTHORIZED')
    }
    if (!this.catalog.riskPolicies.some(item => item.id === config.riskPolicyId)) {
      throw new TradingAuthorityError('RISK_POLICY_NOT_AUTHORIZED')
    }

    const hardGateEnabled = this.liveTradingGates[row.provider]
    let tradingSessionId: string | null = null
    if (
      hardGateEnabled
      && row.environment === 'REAL'
      && config.confirmationMode === 'AUTO_EXECUTE_PREFERENCE'
      && row.auto_submit_enabled
      && context.tradingSessionId
    ) {
      const session = await this.pool.query<{ session_id: string }>(
        `SELECT session_id
           FROM changfu.trading_sessions
          WHERE session_id = $1::uuid
            AND broker_connection_id = $2::uuid
            AND user_id = $3::bigint
            AND device_id = $4::uuid
            AND mode = 'AUTO_EXECUTE'
            AND status = 'ACTIVE'
            AND config_version = $5
            AND risk_policy_version = $6
            AND expires_at > now()`,
        [
          context.tradingSessionId,
          context.brokerConnectionId,
          userId,
          context.deviceId,
          configVersion,
          config.riskPolicyId,
        ],
      )
      tradingSessionId = session.rows[0]?.session_id ?? null
    }

    if (role === 'PORTFOLIO_REVIEW') {
      await this.pool.query(
        `UPDATE changfu.candidate_pool_items
            SET status = 'EXPIRED', updated_at = now()
          WHERE user_id = $1::bigint
            AND broker_connection_id = $2::uuid
            AND status IN ('PENDING', 'WATCH')
            AND expires_at <= now()`,
        [userId, context.brokerConnectionId],
      )
    }
    const candidateRows = role === 'PORTFOLIO_REVIEW'
      ? await this.pool.query<{
          candidate_id: string
          symbol: string
          side: 'BUY' | 'SELL'
          status: 'PENDING' | 'WATCH'
          rank: number | null
          expires_at: Date
        }>(
          `SELECT candidate_id, symbol, side, status, rank, expires_at
             FROM changfu.candidate_pool_items
            WHERE user_id = $1::bigint
              AND broker_connection_id = $2::uuid
              AND pool_version = $3
              AND config_version = $4
              AND symbol = ANY($5::text[])
              AND status IN ('PENDING', 'WATCH')
              AND expires_at > now()
            ORDER BY rank NULLS LAST, created_at`,
          [userId, context.brokerConnectionId, poolVersion, configVersion, requestedSymbols],
        )
      : { rows: [] }

    return {
      role,
      provider: row.provider,
      brokerConnectionId: context.brokerConnectionId,
      catalogVersion: row.catalog_version,
      configVersion,
      researchPoolVersion: poolVersion,
      executionMode: config.executionMode,
      confirmationMode: config.confirmationMode,
      candidateTtlSeconds: config.candidateTtlSeconds,
      strategyId: config.strategyId,
      riskPolicyId: config.riskPolicyId,
      requestedSymbols,
      candidates: candidateRows.rows.map(item => ({
        candidateId: item.candidate_id,
        symbol: item.symbol,
        side: item.side,
        status: item.status,
        rank: item.rank,
        expiresAt: item.expires_at.toISOString(),
      })),
      accountIdHash: row.account_id_hash,
      environment: row.environment,
      instrument: poolItems.rows.length === 1
        ? {
            market: poolItems.rows[0]!.market as 'US' | 'HK',
            instrumentType: poolItems.rows[0]!.instrument_type as 'STOCK' | 'ETF',
          }
        : null,
      hardGateEnabled,
      autoSubmitEnabled: row.auto_submit_enabled,
      submissionMode: tradingSessionId ? 'AUTO_EXECUTE' : 'MANUAL_CONFIRM',
      tradingSessionId,
      model: {
        id: model.id,
        deploymentId: deploymentId(model.deploymentId),
      },
      prompt: {
        id: prompt.id,
        version: prompt.version,
        body: prompt.body,
      },
    }
  }
}
