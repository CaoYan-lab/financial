import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { Pool } from 'pg'
import { safeLogger } from '../../../packages/observability/src/safeLogger.js'
import { postgresPoolConfig } from '../../../packages/runtime/src/postgresPool.js'
import { PostgresAdminRepository } from '../../../packages/persistence/src/postgresAdminRepository.js'
import { PostgresAdminUserRepository } from '../../../packages/persistence/src/postgresAdminUserRepository.js'
import { PostgresSubscriptionCatalogRepository } from '../../../packages/persistence/src/postgresSubscriptionCatalogRepository.js'
import { PostgresAdminSubscriptionRepository } from '../../../packages/persistence/src/postgresAdminSubscriptionRepository.js'
import { PostgresOfficialModelConfigRepository } from '../../../packages/model-provider/src/postgresOfficialModelConfigRepository.js'
import {
  sendAdminJson,
  sendAdminProblem,
  type AdminRequestContext,
} from './http.js'
import { handleAdminAuthRoute } from './routes/auth.js'
import { handleAdminUsersRoute } from './routes/users.js'
import { handleAdminPlansRoute } from './routes/plans.js'
import { handleAdminUserSubscriptionsRoute } from './routes/userSubscriptions.js'
import { handleAdminOfficialModelRoute } from './routes/officialModel.js'

const port = Number(process.env.CHANGFU_ADMIN_PORT ?? 4320)
const host = process.env.CHANGFU_ADMIN_HOST ?? '0.0.0.0'
const databaseUrl = process.env.CHANGFU_ADMIN_DATABASE_URL ?? ''
const secureCookies = process.env.NODE_ENV === 'production'
  || process.env.CHANGFU_ADMIN_COOKIE_SECURE === 'true'
const allowedOrigin = process.env.CHANGFU_ADMIN_ORIGIN?.replace(/\/$/, '') ?? null
const modelCredentialKey = process.env.CHANGFU_MODEL_CREDENTIAL_KEY ?? ''
const adminWebRoot = process.env.CHANGFU_ADMIN_WEB_ROOT
  ?? join(process.cwd(), 'admin-web', 'dist')
const pool = databaseUrl
  ? new Pool(postgresPoolConfig(databaseUrl, {
      max: 5,
      applicationName: 'changfu-admin',
    }))
  : null
const adminRepository = pool ? new PostgresAdminRepository(pool) : null
const userRepository = pool && adminRepository
  ? new PostgresAdminUserRepository(pool, adminRepository)
  : null
const catalogRepository = pool
  ? new PostgresSubscriptionCatalogRepository(pool, adminRepository ?? undefined)
  : null
const subscriptionRepository = pool && adminRepository
  ? new PostgresAdminSubscriptionRepository(pool, adminRepository)
  : null
const officialModelRepository = pool && adminRepository
  ? new PostgresOfficialModelConfigRepository(pool, modelCredentialKey, adminRepository)
  : null

type RateWindow = { count: number; resetAt: number }
const loginAttempts = new Map<string, RateWindow>()
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function serveAdminWeb(
  path: string,
  response: AdminRequestContext['response'],
): Promise<boolean> {
  if (!existsSync(adminWebRoot) || path.startsWith('/api/')) return false
  const relative = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '')
  const requested = join(adminWebRoot, relative || 'index.html')
  const candidate = existsSync(requested) && extname(requested)
    ? requested
    : join(adminWebRoot, 'index.html')
  try {
    const body = await readFile(candidate)
    response.writeHead(200, {
      'content-type': contentTypes[extname(candidate)] ?? 'application/octet-stream',
      'cache-control': extname(candidate) === '.html'
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    })
    response.end(body)
    return true
  } catch {
    return false
  }
}

function sourceIp(request: AdminRequestContext['request']): string | null {
  const address = request.socket.remoteAddress
  return address && address.length <= 64 ? address : null
}

function loginRateLimited(key: string): boolean {
  const now = Date.now()
  const current = loginAttempts.get(key)
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1_000 })
    return false
  }
  current.count += 1
  return current.count > 20
}

if (adminRepository) {
  await adminRepository.seedInitialAdmin(process.env.CHANGFU_ADMIN_INITIAL_PASSWORD)
}

const server = createServer(async (request, response) => {
  const requestIdHeader = request.headers['x-request-id']?.toString()
  const requestId = requestIdHeader && /^[0-9a-f-]{36}$/i.test(requestIdHeader)
    ? requestIdHeader
    : randomUUID()
  const url = new URL(request.url ?? '/', 'http://localhost')

  if (request.method === 'GET' && url.pathname === '/api/v1/admin/health') {
    sendAdminJson(response, 200, {
      ok: true,
      service: 'changfu-admin',
      version: '0.1.0',
      configured: Boolean(pool),
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/admin/ready') {
    try {
      if (!pool) throw new Error('DATABASE_NOT_CONFIGURED')
      await pool.query('SELECT 1')
      sendAdminJson(response, 200, { ok: true, database: true })
    } catch {
      sendAdminJson(response, 503, { ok: false, database: false })
    }
    return
  }
  if (
    !adminRepository
    || !userRepository
    || !catalogRepository
    || !subscriptionRepository
    || !officialModelRepository
  ) {
    sendAdminProblem(response, 503, 'ADMIN_DATABASE_NOT_CONFIGURED', requestId)
    return
  }

  const ip = sourceIp(request)
  const context: AdminRequestContext = {
    request,
    response,
    url,
    requestId,
    sourceIp: ip,
    adminRepository,
    userRepository,
    catalogRepository,
    subscriptionRepository,
    officialModelRepository,
    secureCookies,
    allowedOrigin,
    loginRateLimited: username => loginRateLimited(
      `${ip ?? 'unknown'}:${username.trim().toLowerCase()}`,
    ),
  }
  try {
    if (await handleAdminAuthRoute(context)) return
    if (await handleAdminUsersRoute(context)) return
    if (await handleAdminPlansRoute(context)) return
    if (await handleAdminUserSubscriptionsRoute(context)) return
    if (await handleAdminOfficialModelRoute(context)) return
    if (request.method === 'GET' && await serveAdminWeb(url.pathname, response)) return
    sendAdminProblem(response, 404, 'ADMIN_ROUTE_NOT_FOUND', requestId)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : ''
    const requestStatus = errorMessage === 'REQUEST_TOO_LARGE'
      ? 413
      : error instanceof SyntaxError || errorMessage === 'REQUEST_INVALID' ? 400 : 500
    const errorCode = requestStatus === 413
      ? 'REQUEST_TOO_LARGE'
      : requestStatus === 400 ? 'REQUEST_INVALID' : 'ADMIN_INTERNAL_ERROR'
    const log = requestStatus >= 500 ? safeLogger.error : safeLogger.warn
    log('admin_request_failed', {
      requestId,
      path: url.pathname,
      method: request.method ?? 'UNKNOWN',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    sendAdminProblem(
      response,
      requestStatus,
      errorCode,
      requestId,
    )
  }
})

server.listen(port, host, () => {
  safeLogger.info('admin_listening', { host, port })
})

async function shutdown(): Promise<void> {
  server.close()
  await pool?.end()
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
