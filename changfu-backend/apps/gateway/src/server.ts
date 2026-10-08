import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { safeLogger } from '../../../packages/observability/src/safeLogger.js'
import { loadTradingCatalog } from '../../../packages/catalog/src/tradingCatalog.js'
import {
  loadSubscriptionCatalog,
  seedSubscriptionCatalog,
} from '../../../packages/subscriptions/src/catalog.js'
import { MAX_ENVELOPE_BYTES } from '../../../packages/domain/src/contextEnvelope.js'
import {
  liveTradingGateDigest,
  readLiveTradingGates,
} from '../../../packages/domain/src/liveTradingGates.js'
import { verifyAccessToken, type AccessClaims } from '../../../packages/auth/src/accessToken.js'
import {
  AuthService,
  LoginRejectedError,
  PasswordChangeError,
  type DesktopLogin,
} from '../../../packages/auth/src/authService.js'
import { PostgresTradingLeaseRepository } from '../../../packages/persistence/src/postgresTradingLeaseRepository.js'
import {
  IdempotencyService,
  requestHash,
} from '../../../packages/idempotency/src/idempotencyService.js'
import {
  handleControlPlaneRoute,
  seedTradingCatalog,
} from './routes/controlPlane.js'
import { PostgresSubscriptionRepository } from '../../../packages/persistence/src/postgresSubscriptionRepository.js'
import { PostgresSubscriptionCatalogRepository } from '../../../packages/persistence/src/postgresSubscriptionCatalogRepository.js'
import { PaymentService } from '../../../packages/payments/src/paymentService.js'
import { createWechatPaymentProvider } from '../../../packages/payments/src/providers/wechat.js'
import { createAlipayPaymentProvider } from '../../../packages/payments/src/providers/alipay.js'
import { createDouyinPaymentProvider } from '../../../packages/payments/src/providers/douyin.js'
import { handleSubscriptionRoute } from './routes/subscriptions.js'
import { handlePaymentWebhookRoute } from './routes/paymentWebhooks.js'
import { handleProviderPoolRoute } from './routes/providerPools.js'
import { handleModelProviderConfigRoute } from './routes/modelProviderConfig.js'
import { handleSellPutResearchRoute } from './routes/sellPutResearch.js'
import { handleQuantitativeResearchRoute } from './routes/quantitativeResearch.js'
import { postgresPoolConfig } from '../../../packages/runtime/src/postgresPool.js'

const port = Number(process.env.CHANGFU_GATEWAY_PORT ?? 4310)
const host = process.env.CHANGFU_GATEWAY_HOST ?? '0.0.0.0'
const workerUrl = process.env.CHANGFU_DECISION_WORKER_URL ?? 'http://127.0.0.1:4311'
const accessPublicKeyPem = process.env.CHANGFU_ACCESS_PUBLIC_KEY_PEM?.replaceAll('\\n', '\n') ?? ''
const accessPrivateKeyPem = process.env.CHANGFU_ACCESS_PRIVATE_KEY_PEM?.replaceAll('\\n', '\n') ?? ''
const accessKeyId = process.env.CHANGFU_ACCESS_KEY_ID ?? 'changfu-access-v1'
const orderIntentPublicKeyPem = process.env.CHANGFU_ORDER_INTENT_PUBLIC_KEY_PEM
  ?.replaceAll('\\n', '\n') ?? ''
const orderIntentKeyId = process.env.CHANGFU_ORDER_INTENT_KEY_ID ?? ''
const orderIntentSigningKeys = orderIntentPublicKeyPem && orderIntentKeyId
  ? [{ keyId: orderIntentKeyId, publicKey: orderIntentPublicKeyPem }]
  : []
const internalToken = process.env.CHANGFU_INTERNAL_TOKEN ?? ''
const databaseUrl = process.env.CHANGFU_DATABASE_URL ?? ''
const modelCredentialKey = process.env.CHANGFU_MODEL_CREDENTIAL_KEY ?? ''
const liveTradingGates = readLiveTradingGates()
const liveTradingGateHash = liveTradingGateDigest(liveTradingGates)
const maxRequestBytes = MAX_ENVELOPE_BYTES + 128 * 1024
const workerRequestTimeoutMs = 330_000
const pool = databaseUrl
  ? new Pool(postgresPoolConfig(databaseUrl, {
      max: 5,
      applicationName: 'changfu-gateway',
    }))
  : null
const tradingCatalogPaths = [
  new URL('../../../catalog/trading/catalog.v1.yaml', import.meta.url),
  new URL('../../../../catalog/trading/catalog.v1.yaml', import.meta.url),
].map(url => fileURLToPath(url))
const tradingCatalogPath = tradingCatalogPaths.find(existsSync)
if (!tradingCatalogPath) throw new Error('TRADING_CATALOG_NOT_FOUND')
const tradingCatalog = await loadTradingCatalog(tradingCatalogPath)
const subscriptionCatalogPaths = [
  new URL('../../../catalog/subscriptions/catalog.v1.json', import.meta.url),
  new URL('../../../../catalog/subscriptions/catalog.v1.json', import.meta.url),
].map(url => fileURLToPath(url))
const subscriptionCatalogPath = subscriptionCatalogPaths.find(existsSync)
if (!subscriptionCatalogPath) throw new Error('SUBSCRIPTION_CATALOG_NOT_FOUND')
const subscriptionCatalog = await loadSubscriptionCatalog(subscriptionCatalogPath)
const subscriptionRepository = pool
  ? new PostgresSubscriptionRepository(pool)
  : null
const subscriptionCatalogRepository = pool
  ? new PostgresSubscriptionCatalogRepository(pool)
  : null
const paymentService = subscriptionRepository
  ? new PaymentService(subscriptionRepository, [
      createWechatPaymentProvider(),
      createAlipayPaymentProvider(),
      createDouyinPaymentProvider(),
    ])
  : null
const authService = pool && accessPrivateKeyPem
  ? new AuthService(pool, {
      privateKeyPem: accessPrivateKeyPem,
      keyId: accessKeyId,
      issuer: 'changfu-gateway',
      audience: 'changfu-desktop',
    })
  : null

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function problem(response: ServerResponse, status: number, code: string, requestId: string): void {
  sendJson(response, status, {
    type: `https://changfu.local/problems/${code.toLowerCase()}`,
    title: '请求未完成',
    status,
    code,
    requestId,
  })
}

async function readSensitiveBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > maxRequestBytes) throw new Error('REQUEST_TOO_LARGE')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxRequestBytes) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice('Bearer '.length)
  return token.length > 0 ? token : null
}

function authenticate(request: IncomingMessage): AccessClaims | null {
  const token = bearerToken(request)
  if (!token || !accessPublicKeyPem) return null
  try {
    return verifyAccessToken(token, {
      publicKeyPem: accessPublicKeyPem,
      issuer: 'changfu-gateway',
      audience: 'changfu-desktop',
    })
  } catch {
    return null
  }
}

function idempotencyKey(request: IncomingMessage): string | null {
  const value = request.headers['idempotency-key']?.toString()
  return value && value.length >= 16 && value.length <= 128 ? value : null
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readSensitiveBody(request)
  const parsed = JSON.parse(body.toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('REQUEST_INVALID')
  }
  return parsed as Record<string, unknown>
}

function desktopLogin(input: Record<string, unknown>): DesktopLogin | null {
  const platform = input.platform
  if (
    typeof input.username !== 'string'
    || typeof input.password !== 'string'
    || typeof input.deviceId !== 'string'
    || typeof input.deviceFingerprint !== 'string'
    || typeof input.displayName !== 'string'
    || (platform !== 'MACOS' && platform !== 'WINDOWS')
    || typeof input.appVersion !== 'string'
    || typeof input.publicKey !== 'string'
    || input.username.length === 0
    || input.password.length === 0
    || input.deviceFingerprint.length < 16
    || input.displayName.length === 0
    || !input.publicKey.includes('BEGIN PUBLIC KEY')
  ) {
    return null
  }
  return {
    username: input.username,
    password: input.password,
    deviceId: input.deviceId,
    deviceFingerprint: input.deviceFingerprint,
    displayName: input.displayName,
    platform,
    appVersion: input.appVersion,
    publicKey: input.publicKey,
  }
}

const server = createServer(async (request, response) => {
  const requestId = request.headers['x-request-id']?.toString() ?? randomUUID()
  const url = new URL(request.url ?? '/', 'http://localhost')
  const requestController = new AbortController()
  request.once('aborted', () => requestController.abort())
  response.once('close', () => {
    if (!response.writableEnded) requestController.abort()
  })

  if (request.method === 'GET' && url.pathname === '/v1/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'changfu-gateway',
      version: '0.1.0',
      configured: Boolean(
        pool
        && accessPublicKeyPem
        && internalToken
        && modelCredentialKey
        && (
          (!liveTradingGates.FUTU && !liveTradingGates.LONGBRIDGE)
          || orderIntentSigningKeys.length > 0
        )
      ),
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/v1/ready') {
    const [databaseResult, workerResult] = await Promise.allSettled([
      pool ? pool.query('SELECT 1') : Promise.reject(new Error('DATABASE_NOT_CONFIGURED')),
      fetch(`${workerUrl}/internal/v1/health`, {
        signal: AbortSignal.any([
          requestController.signal,
          AbortSignal.timeout(5_000),
        ]),
      }).then(async result => {
        if (!result.ok) throw new Error('WORKER_NOT_READY')
        const body = await result.json() as {
          liveTradingGateHash?: unknown
          liveOrderSigningConfigured?: unknown
        }
        if (body.liveTradingGateHash !== liveTradingGateHash) {
          throw new Error('LIVE_TRADING_GATE_MISMATCH')
        }
        if (
          (liveTradingGates.FUTU || liveTradingGates.LONGBRIDGE)
          && (
            body.liveOrderSigningConfigured !== true
            || orderIntentSigningKeys.length === 0
          )
        ) {
          throw new Error('LIVE_TRADING_SIGNING_CONFIG_MISSING')
        }
      }),
    ])
    const database = databaseResult.status === 'fulfilled'
    const worker = workerResult.status === 'fulfilled'
    sendJson(response, database && worker ? 200 : 503, {
      ok: database && worker,
      database,
      worker,
      liveTradingGates,
      liveTradingGateHash,
    })
    return
  }

  if (request.method === 'POST' && url.pathname === '/v1/auth/login') {
    if (!authService) {
      problem(response, 503, 'SECURITY_CONFIG_MISSING', requestId)
      return
    }
    try {
      const input = desktopLogin(await readJsonBody(request))
      if (!input) {
        problem(response, 400, 'LOGIN_REQUEST_INVALID', requestId)
        return
      }
      sendJson(response, 200, await authService.login(input))
    } catch (error) {
      safeLogger.warn('desktop_login_rejected', {
        requestId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      problem(
        response,
        error instanceof LoginRejectedError ? 401 : 503,
        error instanceof LoginRejectedError ? 'LOGIN_REJECTED' : 'DATABASE_UNAVAILABLE',
        requestId,
      )
    }
    return
  }

  if (
    request.method === 'POST'
    && (url.pathname === '/v1/auth/refresh' || url.pathname === '/v1/auth/logout')
  ) {
    if (!authService) {
      problem(response, 503, 'SECURITY_CONFIG_MISSING', requestId)
      return
    }
    try {
      const body = await readJsonBody(request)
      if (typeof body.refreshToken !== 'string' || body.refreshToken.length < 40) {
        problem(response, 400, 'REFRESH_REQUEST_INVALID', requestId)
        return
      }
      if (url.pathname === '/v1/auth/logout') {
        await authService.logout(body.refreshToken)
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      } else {
        sendJson(response, 200, await authService.refresh(body.refreshToken))
      }
    } catch (error) {
      safeLogger.warn('desktop_refresh_rejected', {
        requestId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      problem(
        response,
        error instanceof LoginRejectedError ? 401 : 503,
        error instanceof LoginRejectedError ? 'REFRESH_REJECTED' : 'DATABASE_UNAVAILABLE',
        requestId,
      )
    }
    return
  }

  if (
    paymentService
    && await handlePaymentWebhookRoute({
      request,
      response,
      url,
      requestId,
      paymentService,
    })
  ) return

  if (!accessPublicKeyPem || !pool || !authService) {
    problem(response, 503, 'SECURITY_CONFIG_MISSING', requestId)
    return
  }
  const claims = authenticate(request)
  if (!claims) {
    problem(response, 401, 'AUTH_REQUIRED', requestId)
    return
  }
  const userId = claims.sub
  const deviceId = claims.device_id
  let mustChangePassword: boolean
  try {
    const profile = await pool.query<{
      active: boolean
      must_change_password: boolean
      sessions_valid_after: Date
    }>(
      `SELECT active, must_change_password, sessions_valid_after
         FROM multiuser.user_profiles
        WHERE user_id = $1::bigint`,
      [userId],
    )
    const row = profile.rows[0]
    if (!row?.active) {
      problem(response, 401, 'AUTH_REQUIRED', requestId)
      return
    }
    if (claims.iat < Math.floor(row.sessions_valid_after.getTime() / 1_000)) {
      problem(response, 401, 'AUTH_REQUIRED', requestId)
      return
    }
    mustChangePassword = row.must_change_password
  } catch (error) {
    safeLogger.error('gateway_user_profile_query_failed', {
      requestId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    problem(response, 503, 'DATABASE_UNAVAILABLE', requestId)
    return
  }

  if (request.method === 'POST' && url.pathname === '/v1/auth/password') {
    const key = idempotencyKey(request)
    if (!key) {
      problem(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', requestId)
      return
    }
    try {
      const body = await readJsonBody(request)
      if (
        (body.currentPassword !== undefined && typeof body.currentPassword !== 'string')
        || typeof body.nextPassword !== 'string'
      ) {
        problem(response, 400, 'PASSWORD_REQUEST_INVALID', requestId)
        return
      }
      await authService.changePassword({
        userId,
        deviceId,
        nextPassword: body.nextPassword,
        ...(typeof body.currentPassword === 'string'
          ? { currentPassword: body.currentPassword }
          : {}),
      })
      sendJson(response, 200, { changed: true })
    } catch (error) {
      if (error instanceof PasswordChangeError) {
        problem(response, 400, error.code, requestId)
      } else {
        safeLogger.error('desktop_password_change_failed', {
          requestId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        })
        problem(response, 503, 'DATABASE_UNAVAILABLE', requestId)
      }
    }
    return
  }

  if (mustChangePassword) {
    problem(response, 428, 'PASSWORD_CHANGE_REQUIRED', requestId)
    return
  }

  if (request.method === 'GET' && url.pathname === '/v1/ads/active') {
    const placement = url.searchParams.get('placement')
    if (placement !== 'startup' && placement !== 'overlay') {
      problem(response, 400, 'PLACEMENT_INVALID', requestId)
      return
    }
    try {
      const result = await pool.query<{
        campaign_id: string
        enabled: boolean
        duration_seconds: number
        local_asset_id: string
        version: number
      }>(
        `SELECT campaign_id, enabled, duration_seconds, local_asset_id, version
           FROM changfu.ad_configs
          WHERE placement = $1
            AND enabled = true
            AND (starts_at IS NULL OR starts_at <= now())
            AND (ends_at IS NULL OR ends_at > now())
          ORDER BY priority DESC, version DESC
          LIMIT 1`,
        [placement],
      )
      const ad = result.rows[0]
      sendJson(response, 200, ad
        ? {
            serverTime: new Date().toISOString(),
            enabled: true,
            placement,
            durationSeconds: ad.duration_seconds,
            campaignId: ad.campaign_id,
            version: ad.version,
            localAssetId: ad.local_asset_id,
          }
        : {
            serverTime: new Date().toISOString(),
            enabled: false,
            placement,
            durationSeconds: 1,
            campaignId: null,
            version: 1,
            localAssetId: null,
          })
    } catch (error) {
      safeLogger.error('gateway_ad_query_failed', {
        requestId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      problem(response, 503, 'DATABASE_UNAVAILABLE', requestId)
    }
    return
  }

  const key = idempotencyKey(request)
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '') && !key) {
    problem(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', requestId)
    return
  }

  try {
    if (await handleModelProviderConfigRoute({
      request,
      response,
      url,
      requestId,
      userId,
      pool,
      credentialKey: modelCredentialKey,
    })) return

    if (paymentService && subscriptionCatalogRepository && await handleSubscriptionRoute({
      request,
      response,
      url,
      requestId,
      userId,
      pool,
      catalogRepository: subscriptionCatalogRepository,
      paymentService,
    })) return

    if (subscriptionCatalogRepository && await handleProviderPoolRoute({
      request,
      response,
      url,
      requestId,
      userId,
      pool,
      catalogRepository: subscriptionCatalogRepository,
    })) return

    if (await handleSellPutResearchRoute({
      request,
      response,
      url,
      requestId,
      userId,
      pool,
      workerUrl,
      internalToken,
      signal: requestController.signal,
    })) return

    if (await handleQuantitativeResearchRoute({
      request,
      response,
      url,
      requestId,
      userId,
      pool,
      workerUrl,
      internalToken,
      signal: requestController.signal,
    })) return

    if (await handleControlPlaneRoute({
      request,
      response,
      url,
      requestId,
      userId,
      deviceId,
      pool,
      catalog: tradingCatalog,
      liveTradingGates,
      orderIntentSigningKeys,
    })) return

    if (request.method === 'POST' && url.pathname === '/v1/broker-connections/futu') {
      const body = await readJsonBody(request)
      if (
        typeof body.accountIdHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(body.accountIdHash)
        || (body.environment !== 'SIMULATE' && body.environment !== 'REAL')
        || typeof body.displayName !== 'string'
        || body.displayName.length === 0
        || body.displayName.length > 120
      ) {
        problem(response, 400, 'BROKER_CONNECTION_INVALID', requestId)
        return
      }
      const result = await pool.query<{
        broker_connection_id: string
        environment: string
        status: string
      }>(
        `INSERT INTO changfu.broker_connections (
           broker_connection_id, user_id, broker, display_name,
           account_id_hash, environment, status
         ) VALUES ($1::uuid, $2::bigint, 'FUTU', $3, $4, $5, 'ACTIVE')
         ON CONFLICT (user_id, broker, account_id_hash, environment) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               status = 'ACTIVE',
               updated_at = now()
         RETURNING broker_connection_id, environment, status`,
        [randomUUID(), userId, body.displayName, body.accountIdHash, body.environment],
      )
      sendJson(response, 200, {
        brokerConnectionId: result.rows[0]!.broker_connection_id,
        environment: result.rows[0]!.environment,
        status: result.rows[0]!.status,
      })
      return
    }

    if (
      request.method === 'POST'
      && (url.pathname === '/v1/trading-lease/acquire' || url.pathname === '/v1/trading-lease/renew')
    ) {
      const body = await readJsonBody(request)
      if (body.deviceId !== deviceId || typeof body.brokerConnectionId !== 'string') {
        problem(response, 403, 'DEVICE_MISMATCH', requestId)
        return
      }
      const lease = await new PostgresTradingLeaseRepository(pool).acquire({
        userId,
        deviceId,
        brokerConnectionId: body.brokerConnectionId,
      })
      sendJson(response, 200, {
        leaseId: lease.leaseId,
        deviceId: lease.deviceId,
        brokerConnectionId: lease.brokerConnectionId,
        expiresAt: lease.expiresAt.toISOString(),
        version: lease.version,
      })
      return
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/model/runs') {
      problem(response, 404, 'NOT_FOUND', requestId)
      return
    }
    if (!internalToken) {
      problem(response, 503, 'SECURITY_CONFIG_MISSING', requestId)
      return
    }

    const body = await readSensitiveBody(request)
    const idempotency = new IdempotencyService(pool)
    const bodyHash = requestHash(body)
    const replay = await idempotency.begin({
      userId,
      operation: 'model-runs:create',
      key: key!,
      requestHash: bodyHash,
    })
    if (replay) {
      response.writeHead(replay.status, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
        'x-request-id': requestId,
      })
      response.end(typeof replay.body === 'string' ? replay.body : JSON.stringify(replay.body))
      return
    }
    safeLogger.info('gateway_model_run_forwarded', {
      requestId,
      byteLength: body.length,
    })
    const upstream = await fetch(`${workerUrl}/internal/v1/model/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-request-id': requestId,
        'x-idempotency-key': key!,
        'x-changfu-user-id': userId,
        'x-changfu-device-id': deviceId,
        authorization: `Bearer ${internalToken}`,
      },
      body,
      signal: AbortSignal.any([
        requestController.signal,
        AbortSignal.timeout(workerRequestTimeoutMs),
      ]),
    })

    const upstreamBody = Buffer.from(await upstream.arrayBuffer())
    await idempotency.complete({
      userId,
      operation: 'model-runs:create',
      key: key!,
      requestHash: bodyHash,
      response: {
        status: upstream.status,
        body: upstreamBody.toString('utf8'),
      },
    })
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/problem+json',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    })
    response.end(upstreamBody)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'REQUEST_TOO_LARGE'
    const invalid = error instanceof SyntaxError || (error instanceof Error && error.message === 'REQUEST_INVALID')
    const conflict = error instanceof Error
      && (
        error.name === 'TradingLeaseConflictError'
        || error.name === 'OrderClaimConflictError'
        || error.name === 'IdempotencyConflictError'
        || error.name === 'ControlPlaneConflictError'
        || error.name === 'SubscriptionRepositoryError'
        || error.name === 'SubscriptionRuleError'
        || error.name === 'ProviderPoolError'
        || error.name === 'SellPutResearchError'
        || error.name === 'QuantitativeResearchError'
        || error.name === 'LiveTradingConflictError'
      )
    const status = tooLarge ? 413 : invalid ? 400 : conflict ? 409 : 503
    const errorCode = tooLarge
      ? 'REQUEST_TOO_LARGE'
      : invalid
        ? 'REQUEST_INVALID'
        : conflict
          ? 'STATE_CONFLICT'
          : 'UPSTREAM_UNAVAILABLE'
    safeLogger.error('gateway_request_failed', {
      requestId,
      errorCode,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    if (!response.headersSent) {
      problem(response, status, errorCode, requestId)
    } else {
      response.destroy()
    }
  }
})

if (pool) {
  await seedTradingCatalog(pool, tradingCatalog)
  await seedSubscriptionCatalog(pool, subscriptionCatalog)
}

server.listen(port, host, () => {
  safeLogger.info('gateway_started', { host, port })
})

let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  safeLogger.info('gateway_shutdown_started', { signal })
  server.closeIdleConnections()
  await Promise.race([
    new Promise<void>(resolve => server.close(() => resolve())),
    new Promise<void>(resolve => {
      setTimeout(() => {
        server.closeAllConnections()
        resolve()
      }, 10_000).unref()
    }),
  ])
  await pool?.end()
  safeLogger.info('gateway_shutdown_completed', { signal })
}

process.once('SIGTERM', signal => void shutdown(signal))
process.once('SIGINT', signal => void shutdown(signal))
