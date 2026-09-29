import {
  expiredSessionCookie,
  sessionCookie,
} from '../../../../packages/admin/src/session.js'
import { validateAdminPassword } from '../../../../packages/admin/src/password.js'
import {
  AdminAuthenticationError,
} from '../../../../packages/persistence/src/postgresAdminRepository.js'
import {
  readAdminJson,
  requireAdmin,
  sendAdminJson,
  sendAdminProblem,
  type AdminRequestContext,
} from '../http.js'

function credentials(body: Record<string, unknown>): {
  username: string
  password: string
} | null {
  if (
    typeof body.username !== 'string'
    || typeof body.password !== 'string'
    || body.username.length < 3
    || body.username.length > 80
    || body.password.length < 1
    || body.password.length > 256
  ) return null
  return { username: body.username, password: body.password }
}

export async function handleAdminAuthRoute(context: AdminRequestContext): Promise<boolean> {
  const path = context.url.pathname
  if (context.request.method === 'POST' && path === '/api/v1/admin/auth/login') {
    const input = credentials(await readAdminJson(context.request, 8 * 1024))
    if (!input) {
      sendAdminProblem(context.response, 400, 'ADMIN_LOGIN_REQUEST_INVALID', context.requestId)
      return true
    }
    if (context.loginRateLimited(input.username)) {
      sendAdminProblem(context.response, 429, 'ADMIN_LOGIN_RATE_LIMITED', context.requestId)
      return true
    }
    try {
      const result = await context.adminRepository.login({
        ...input,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      })
      sendAdminJson(context.response, 200, result.session, {
        'set-cookie': sessionCookie(result.token, context.secureCookies),
      })
    } catch (error) {
      if (error instanceof AdminAuthenticationError) {
        sendAdminProblem(context.response, 401, 'ADMIN_LOGIN_REJECTED', context.requestId)
        return true
      }
      throw error
    }
    return true
  }

  if (context.request.method === 'GET' && path === '/api/v1/admin/auth/session') {
    const authenticated = await requireAdmin(context, { allowPasswordChangeOnly: true })
    if (!authenticated) return true
    sendAdminJson(context.response, 200, {
      adminUserId: authenticated.admin.adminUserId,
      username: authenticated.admin.username,
      role: authenticated.admin.role,
      mustChangePassword: authenticated.admin.mustChangePassword,
    })
    return true
  }

  if (context.request.method === 'POST' && path === '/api/v1/admin/auth/password') {
    const authenticated = await requireAdmin(context, {
      mutation: true,
      allowPasswordChangeOnly: true,
    })
    if (!authenticated) return true
    const body = await readAdminJson(context.request, 8 * 1024)
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const nextPassword = typeof body.nextPassword === 'string' ? body.nextPassword : ''
    if (!currentPassword || !validateAdminPassword(nextPassword)) {
      sendAdminProblem(context.response, 400, 'ADMIN_PASSWORD_INVALID', context.requestId)
      return true
    }
    try {
      await context.adminRepository.changePassword({
        identity: authenticated.admin,
        currentPassword,
        nextPassword,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      })
      sendAdminJson(context.response, 200, { changed: true }, {
        'set-cookie': expiredSessionCookie(context.secureCookies),
      })
    } catch (error) {
      if (error instanceof AdminAuthenticationError) {
        sendAdminProblem(context.response, 401, error.code, context.requestId)
        return true
      }
      throw error
    }
    return true
  }

  if (context.request.method === 'POST' && path === '/api/v1/admin/auth/logout') {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    await context.adminRepository.logout(authenticated.admin.adminSessionId)
    sendAdminJson(context.response, 200, { loggedOut: true }, {
      'set-cookie': expiredSessionCookie(context.secureCookies),
    })
    return true
  }
  return false
}
