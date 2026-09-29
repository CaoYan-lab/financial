import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PostgresAdminRepository } from '../../../packages/persistence/src/postgresAdminRepository.js'
import type { PostgresAdminUserRepository } from '../../../packages/persistence/src/postgresAdminUserRepository.js'
import type { PostgresSubscriptionCatalogRepository } from '../../../packages/persistence/src/postgresSubscriptionCatalogRepository.js'
import type { PostgresAdminSubscriptionRepository } from '../../../packages/persistence/src/postgresAdminSubscriptionRepository.js'
import type {
  PostgresOfficialModelConfigRepository,
} from '../../../packages/model-provider/src/postgresOfficialModelConfigRepository.js'
import {
  adminSessionCookie,
  hashOpaqueToken,
  parseCookies,
} from '../../../packages/admin/src/session.js'

export type AdminRequestContext = {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  requestId: string
  sourceIp: string | null
  adminRepository: PostgresAdminRepository
  userRepository: PostgresAdminUserRepository
  catalogRepository: PostgresSubscriptionCatalogRepository
  subscriptionRepository: PostgresAdminSubscriptionRepository
  officialModelRepository: PostgresOfficialModelConfigRepository
  secureCookies: boolean
  allowedOrigin: string | null
  loginRateLimited: (username: string) => boolean
}

export type AuthenticatedAdminContext = AdminRequestContext & {
  admin: NonNullable<Awaited<ReturnType<PostgresAdminRepository['authenticate']>>>
}

export function sendAdminJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    ...headers,
  })
  response.end(JSON.stringify(body))
}

export function sendAdminProblem(
  response: ServerResponse,
  status: number,
  code: string,
  requestId: string,
): void {
  sendAdminJson(response, status, {
    type: `https://changfu.local/problems/${code.toLowerCase()}`,
    title: '请求未完成',
    status,
    code,
    requestId,
  }, {
    'content-type': 'application/problem+json; charset=utf-8',
  })
}

export async function readAdminJson(
  request: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
    throw new Error('REQUEST_TOO_LARGE')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maxBytes) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(value)
  }
  if (size === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('REQUEST_INVALID')
  }
  return value as Record<string, unknown>
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer)
  )
}

export function originAllowed(context: AdminRequestContext): boolean {
  const origin = context.request.headers.origin
  if (!origin) return false
  if (context.allowedOrigin) return origin === context.allowedOrigin
  const forwardedHost = context.request.headers['x-forwarded-host']?.toString()
  const host = forwardedHost ?? context.request.headers.host
  if (!host) return false
  const protocol = context.request.headers['x-forwarded-proto']?.toString()
    ?? (context.secureCookies ? 'https' : 'http')
  return origin === `${protocol}://${host}`
}

export async function requireAdmin(
  context: AdminRequestContext,
  options: { mutation?: boolean; allowPasswordChangeOnly?: boolean } = {},
): Promise<AuthenticatedAdminContext | null> {
  const token = parseCookies(context.request.headers.cookie).get(adminSessionCookie)
  if (!token) {
    sendAdminProblem(context.response, 401, 'ADMIN_AUTHENTICATION_REQUIRED', context.requestId)
    return null
  }
  const admin = await context.adminRepository.authenticate(token)
  if (!admin) {
    sendAdminProblem(context.response, 401, 'ADMIN_SESSION_INVALID', context.requestId)
    return null
  }
  if (admin.mustChangePassword && !options.allowPasswordChangeOnly) {
    sendAdminProblem(context.response, 403, 'ADMIN_PASSWORD_CHANGE_REQUIRED', context.requestId)
    return null
  }
  if (options.mutation) {
    const csrf = context.request.headers['x-csrf-token']?.toString() ?? ''
    if (!originAllowed(context) || !csrf || !sameHash(hashOpaqueToken(csrf), admin.csrfTokenHash)) {
      sendAdminProblem(context.response, 403, 'ADMIN_CSRF_REJECTED', context.requestId)
      return null
    }
    const idempotencyKey = context.request.headers['idempotency-key']?.toString() ?? ''
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      sendAdminProblem(context.response, 400, 'IDEMPOTENCY_KEY_REQUIRED', context.requestId)
      return null
    }
    const claimed = await context.adminRepository.claimMutation({
      adminUserId: admin.adminUserId,
      operation: `${context.request.method ?? 'UNKNOWN'} ${context.url.pathname}`,
      idempotencyKey,
      requestId: context.requestId,
    })
    if (!claimed) {
      sendAdminProblem(context.response, 409, 'ADMIN_MUTATION_ALREADY_SUBMITTED', context.requestId)
      return null
    }
  }
  return { ...context, admin }
}
