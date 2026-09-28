import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import {
  publicTradingCatalog,
  type TradingCatalog,
} from '../../../../packages/catalog/src/tradingCatalog.js'
import { sendJson, sendProblem } from '../../../../packages/http/src/problem.js'
import { parseObject, readBody } from '../../../../packages/http/src/router.js'
import {
  IdempotencyService,
  requestHash,
} from '../../../../packages/idempotency/src/idempotencyService.js'
import {
  PostgresControlPlaneRepository,
  type TradingConfigData,
} from '../../../../packages/persistence/src/postgresControlPlaneRepository.js'

const maxControlBodyBytes = 128 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Context = {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  requestId: string
  userId: string
  deviceId: string
  pool: Pool
  catalog: TradingCatalog
}

function requiredText(value: unknown, maxLength = 128): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null
}

async function idempotentJson(
  context: Context,
  operation: string,
  execute: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const key = context.request.headers['idempotency-key']?.toString()
  if (!key || key.length < 16 || key.length > 128) {
    sendProblem(context.response, 400, 'IDEMPOTENCY_KEY_REQUIRED', context.requestId)
    return
  }
  const raw = await readBody(context.request, maxControlBodyBytes)
  const hash = requestHash(raw)
  const service = new IdempotencyService(context.pool)
  const replay = await service.begin({
    userId: context.userId,
    operation,
    key,
    requestHash: hash,
  })
  if (replay) {
    sendJson(context.response, replay.status, replay.body)
    return
  }
  const result = await execute(raw.length === 0 ? {} : parseObject(raw))
  await service.complete({
    userId: context.userId,
    operation,
    key,
    requestHash: hash,
    response: result,
  })
  sendJson(context.response, result.status, result.body)
}

function parseTradingConfig(
  body: Record<string, unknown>,
  catalog: TradingCatalog,
): { expectedVersion: number; config: TradingConfigData } | null {
  const models = body.models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return null
  const selected = models as Record<string, unknown>
  const config = {
    catalogVersion: requiredText(body.catalogVersion, 64),
    executionMode: body.executionMode,
    confirmationMode: body.confirmationMode,
    models: {
      singleDecision: requiredText(selected.singleDecision, 64),
      portfolioReview: requiredText(selected.portfolioReview, 64),
      managedOrderReview: requiredText(selected.managedOrderReview, 64),
    },
    strategyId: requiredText(body.strategyId, 64),
    singlePromptId: requiredText(body.singlePromptId, 64),
    portfolioPromptId: requiredText(body.portfolioPromptId, 64),
    managedOrderPromptId: requiredText(body.managedOrderPromptId, 64),
    scanIntervalSeconds: body.scanIntervalSeconds,
    portfolioReviewIntervalSeconds: body.portfolioReviewIntervalSeconds,
    candidateTtlSeconds: body.candidateTtlSeconds,
    maxConcurrency: body.maxConcurrency,
    disableUsOvernightEvaluation: body.disableUsOvernightEvaluation,
    riskPolicyId: requiredText(body.riskPolicyId, 64),
  }
  if (
    !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0
    || config.catalogVersion !== catalog.catalogVersion
    || (config.executionMode !== 'DIRECT' && config.executionMode !== 'CANDIDATE_POOL')
    || (config.confirmationMode !== 'MANUAL_CONFIRM'
      && config.confirmationMode !== 'AUTO_EXECUTE_PREFERENCE')
    || Object.values(config.models).some(value => !value)
    || !config.strategyId || !config.singlePromptId || !config.portfolioPromptId
    || !config.managedOrderPromptId || !config.riskPolicyId
    || !Number.isInteger(config.scanIntervalSeconds)
    || Number(config.scanIntervalSeconds) < 30
    || !Number.isInteger(config.portfolioReviewIntervalSeconds)
    || Number(config.portfolioReviewIntervalSeconds) < 30
    || !Number.isInteger(config.candidateTtlSeconds)
    || Number(config.candidateTtlSeconds) < 60
    || !Number.isInteger(config.maxConcurrency)
    || Number(config.maxConcurrency) < 1 || Number(config.maxConcurrency) > 20
    || typeof config.disableUsOvernightEvaluation !== 'boolean'
  ) return null

  const modelFor = (id: string | null, role: string) => catalog.models.some(
    model => model.id === id && model.roles.includes(role as never),
  )
  if (
    !modelFor(config.models.singleDecision, 'SINGLE_DECISION')
    || !modelFor(config.models.portfolioReview, 'PORTFOLIO_REVIEW')
    || !modelFor(config.models.managedOrderReview, 'MANAGED_ORDER_REVIEW')
    || !catalog.strategies.some(item => item.id === config.strategyId)
    || !catalog.prompts.some(item => item.id === config.singlePromptId && item.role === 'SINGLE_DECISION')
    || !catalog.prompts.some(item => item.id === config.portfolioPromptId && item.role === 'PORTFOLIO_REVIEW')
    || !catalog.prompts.some(item => item.id === config.managedOrderPromptId && item.role === 'MANAGED_ORDER_REVIEW')
    || !catalog.riskPolicies.some(item => item.id === config.riskPolicyId)
  ) return null
  return {
    expectedVersion: Number(body.expectedVersion),
    config: config as TradingConfigData,
  }
}

export async function seedTradingCatalog(pool: Pool, catalog: TradingCatalog): Promise<void> {
  const hash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
  const result = await pool.query(
    `INSERT INTO changfu.trading_catalog_versions (
       catalog_version, content_hash, published_at
     ) VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (catalog_version) DO UPDATE
       SET content_hash = EXCLUDED.content_hash, published_at = EXCLUDED.published_at
     WHERE changfu.trading_catalog_versions.content_hash = EXCLUDED.content_hash
     RETURNING catalog_version`,
    [catalog.catalogVersion, hash, catalog.publishedAt],
  )
  if (result.rowCount !== 1) {
    throw new Error('CATALOG_VERSION_HASH_CONFLICT')
  }
}

export async function handleControlPlaneRoute(context: Context): Promise<boolean> {
  const { request, response, url, requestId, userId, deviceId, catalog } = context
  const repository = new PostgresControlPlaneRepository(context.pool)

  if (request.method === 'GET' && url.pathname === '/v1/broker-connections') {
    sendJson(response, 200, { items: await repository.listBrokerConnections(userId) })
    return true
  }
  if (request.method === 'POST' && url.pathname === '/v1/broker-connections') {
    await idempotentJson(context, 'broker-connections:create', async body => {
      const provider = body.provider
      const environment = body.environment
      const accountIdHash = requiredText(body.accountIdHash, 64)
      const displayName = requiredText(body.displayName, 120)
      if (
        (provider !== 'FUTU' && provider !== 'LONGBRIDGE')
        || (environment !== 'SIMULATE' && environment !== 'REAL')
        || !accountIdHash || !/^[a-f0-9]{64}$/.test(accountIdHash)
        || !displayName
      ) return { status: 400, body: { code: 'BROKER_CONNECTION_INVALID', requestId } }
      return {
        status: 200,
        body: await repository.upsertBrokerConnection({
          userId, provider, environment, accountIdHash, displayName,
        }),
      }
    })
    return true
  }
  const brokerPatch = url.pathname.match(/^\/v1\/broker-connections\/(?<id>[0-9a-f-]+)$/i)
  if (request.method === 'PATCH' && brokerPatch?.groups?.id) {
    await idempotentJson(context, `broker-connections:update:${brokerPatch.groups.id}`, async body => {
      const displayName = body.displayName === undefined ? undefined : requiredText(body.displayName, 120)
      const status = body.status
      if (
        (body.displayName !== undefined && !displayName)
        || (status !== undefined && status !== 'ACTIVE' && status !== 'DISABLED' && status !== 'DELETED')
      ) return { status: 400, body: { code: 'BROKER_CONNECTION_INVALID', requestId } }
      return {
        status: 200,
        body: await repository.updateBrokerConnection({
          userId,
          brokerConnectionId: brokerPatch.groups!.id!,
          ...(displayName ? { displayName } : {}),
          ...(status ? { status } : {}),
        }),
      }
    })
    return true
  }
  if (request.method === 'GET' && url.pathname === '/v1/research/entitlement') {
    const data = await repository.getResearchPool(userId) as { entitlement: unknown }
    sendJson(response, 200, data.entitlement)
    return true
  }
  if (request.method === 'GET' && url.pathname === '/v1/research/pool') {
    sendJson(response, 200, await repository.getResearchPool(userId))
    return true
  }
  if (request.method === 'POST' && url.pathname === '/v1/research/pool/items') {
    await idempotentJson(context, 'research-pool:add', async body => {
      const symbol = requiredText(body.symbol, 32)
      if (
        !symbol
        || (body.market !== 'US' && body.market !== 'HK')
        || (body.instrumentType !== 'STOCK' && body.instrumentType !== 'ETF')
      ) return { status: 400, body: { code: 'RESEARCH_POOL_ITEM_INVALID', requestId } }
      return {
        status: 201,
        body: await repository.addResearchPoolItem({
          userId,
          symbol,
          market: body.market,
          instrumentType: body.instrumentType,
        }),
      }
    })
    return true
  }
  const poolDelete = url.pathname.match(/^\/v1\/research\/pool\/items\/(?<symbol>[^/]+)$/)
  if (request.method === 'DELETE' && poolDelete?.groups?.symbol) {
    await idempotentJson(context, `research-pool:delete:${poolDelete.groups.symbol}`, async () => ({
      status: 200,
      body: await repository.removeResearchPoolItem(
        userId,
        decodeURIComponent(poolDelete.groups!.symbol!),
      ),
    }))
    return true
  }
  if (request.method === 'POST' && url.pathname === '/v1/research/pool/replacements') {
    await idempotentJson(context, 'research-pool:replace', async body => {
      const oldSymbol = requiredText(body.oldSymbol, 32)
      const symbol = requiredText(body.symbol, 32)
      if (
        !oldSymbol || !symbol
        || (body.market !== 'US' && body.market !== 'HK')
        || (body.instrumentType !== 'STOCK' && body.instrumentType !== 'ETF')
      ) return { status: 400, body: { code: 'RESEARCH_POOL_REPLACEMENT_INVALID', requestId } }
      return {
        status: 200,
        body: await repository.replaceResearchPoolItem({
          userId,
          oldSymbol,
          symbol,
          market: body.market,
          instrumentType: body.instrumentType,
        }),
      }
    })
    return true
  }
  if (request.method === 'GET' && url.pathname === '/v1/trading/catalog') {
    const brokerConnectionId = url.searchParams.get('brokerConnectionId')
    if (!brokerConnectionId || !uuidPattern.test(brokerConnectionId)) {
      sendProblem(response, 400, 'BROKER_CONNECTION_INVALID', requestId)
      return true
    }
    const owned = (await repository.listBrokerConnections(userId)) as Array<{ brokerConnectionId: string }>
    if (!owned.some(item => item.brokerConnectionId === brokerConnectionId)) {
      sendProblem(response, 404, 'BROKER_CONNECTION_NOT_FOUND', requestId)
      return true
    }
    sendJson(response, 200, publicTradingCatalog(catalog))
    return true
  }
  if (request.method === 'GET' && url.pathname === '/v1/trading/config') {
    const brokerConnectionId = url.searchParams.get('brokerConnectionId')
    if (!brokerConnectionId || !uuidPattern.test(brokerConnectionId)) {
      sendProblem(response, 400, 'BROKER_CONNECTION_INVALID', requestId)
      return true
    }
    const config = await repository.getTradingConfig(userId, brokerConnectionId)
    if (!config) sendProblem(response, 404, 'TRADING_CONFIG_NOT_FOUND', requestId)
    else sendJson(response, 200, config)
    return true
  }
  const configPut = url.pathname.match(/^\/v1\/trading\/config\/(?<id>[0-9a-f-]+)$/i)
  if (request.method === 'PUT' && configPut?.groups?.id) {
    await idempotentJson(context, `trading-config:put:${configPut.groups.id}`, async body => {
      const parsed = parseTradingConfig(body, catalog)
      if (!parsed) return { status: 400, body: { code: 'TRADING_CONFIG_INVALID', requestId } }
      return {
        status: 200,
        body: await repository.putTradingConfig({
          userId,
          brokerConnectionId: configPut.groups!.id!,
          ...parsed,
        }),
      }
    })
    return true
  }
  if (request.method === 'POST' && url.pathname === '/v1/trading-sessions/activate') {
    await idempotentJson(context, 'trading-sessions:activate', async body => {
      const brokerConnectionId = requiredText(body.brokerConnectionId, 64)
      const riskPolicyVersion = requiredText(body.riskPolicyVersion, 64)
      const confirmationDigest = requiredText(body.confirmationDigest, 64)
      const appSessionId = requiredText(body.appSessionId, 64)
      if (
        !brokerConnectionId || !uuidPattern.test(brokerConnectionId)
        || body.deviceId !== deviceId
        || !Number.isInteger(body.configVersion) || Number(body.configVersion) < 1
        || !riskPolicyVersion || !confirmationDigest
        || !/^[a-f0-9]{64}$/.test(confirmationDigest)
        || !appSessionId || !uuidPattern.test(appSessionId)
      ) return { status: 400, body: { code: 'TRADING_SESSION_INVALID', requestId } }
      return {
        status: 201,
        body: await repository.activateTradingSession({
          userId,
          deviceId,
          brokerConnectionId,
          configVersion: Number(body.configVersion),
          riskPolicyVersion,
          confirmationDigest,
          appSessionId,
        }),
      }
    })
    return true
  }
  const sessionAction = url.pathname.match(
    /^\/v1\/trading-sessions\/(?<id>[0-9a-f-]+)\/(?<action>renew|deactivate)$/i,
  )
  if (request.method === 'POST' && sessionAction?.groups?.id && sessionAction.groups.action) {
    await idempotentJson(
      context,
      `trading-sessions:${sessionAction.groups.action}:${sessionAction.groups.id}`,
      async () => {
        if (sessionAction.groups!.action === 'renew') {
          return {
            status: 200,
            body: await repository.renewTradingSession({
              userId, deviceId, sessionId: sessionAction.groups!.id!,
            }),
          }
        }
        await repository.deactivateTradingSession({
          userId, deviceId, sessionId: sessionAction.groups!.id!,
        })
        return { status: 200, body: { deactivated: true } }
      },
    )
    return true
  }
  if (request.method === 'GET' && url.pathname === '/v1/trading-sessions/current') {
    const brokerConnectionId = url.searchParams.get('brokerConnectionId')
    if (!brokerConnectionId || !uuidPattern.test(brokerConnectionId)) {
      sendProblem(response, 400, 'BROKER_CONNECTION_INVALID', requestId)
      return true
    }
    sendJson(response, 200, {
      session: await repository.getCurrentTradingSession(userId, brokerConnectionId),
    })
    return true
  }
  if (
    request.method === 'GET'
    && (
      url.pathname === '/v1/model/runs'
      || url.pathname === '/v1/signals'
      || url.pathname === '/v1/candidates'
    )
  ) {
    const brokerConnectionId = url.searchParams.get('brokerConnectionId')
    const requestedLimit = Number(url.searchParams.get('limit') ?? 50)
    const requestedOffset = Number(url.searchParams.get('offset') ?? 0)
    if (
      !brokerConnectionId
      || !uuidPattern.test(brokerConnectionId)
      || !Number.isInteger(requestedLimit)
      || requestedLimit < 1
      || requestedLimit > 200
      || !Number.isInteger(requestedOffset)
      || requestedOffset < 0
    ) {
      sendProblem(response, 400, 'QUERY_INVALID', requestId)
      return true
    }
    if (url.pathname === '/v1/model/runs') {
      const page = await repository.listModelRuns(
        userId,
        brokerConnectionId,
        requestedLimit,
        requestedOffset,
      )
      sendJson(response, 200, {
        ...page,
        limit: requestedLimit,
        offset: requestedOffset,
      })
      return true
    }
    const items = url.pathname === '/v1/signals'
        ? await repository.listSignals(userId, brokerConnectionId, requestedLimit)
        : await repository.listCandidates(userId, brokerConnectionId, requestedLimit)
    sendJson(response, 200, { items })
    return true
  }
  const modelRunGet = url.pathname.match(/^\/v1\/model\/runs\/(?<id>[0-9a-f-]+)$/i)
  if (request.method === 'GET' && modelRunGet?.groups?.id) {
    const run = await repository.getModelRun(userId, modelRunGet.groups.id)
    if (!run) sendProblem(response, 404, 'MODEL_RUN_NOT_FOUND', requestId)
    else sendJson(response, 200, run)
    return true
  }
  return false
}
