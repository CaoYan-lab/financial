import { AdminUserError } from '../../../../packages/persistence/src/postgresAdminUserRepository.js'
import {
  readAdminJson,
  requireAdmin,
  sendAdminJson,
  sendAdminProblem,
  type AdminRequestContext,
} from '../http.js'

const usernamePattern = /^[a-zA-Z0-9._-]{3,80}$/
const userPath = /^\/api\/v1\/admin\/users\/(?<userId>[1-9][0-9]*)$/
const actionPath = /^\/api\/v1\/admin\/users\/(?<userId>[1-9][0-9]*)\/(?<action>reset-password|disable|enable)$/

function userFields(body: Record<string, unknown>, partial: boolean): {
  username?: string
  displayName?: string
  temporaryPassword?: string
} | null {
  const username = typeof body.username === 'string' ? body.username.trim() : undefined
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : undefined
  const temporaryPassword = typeof body.temporaryPassword === 'string'
    ? body.temporaryPassword
    : undefined
  if (
    (!partial && (!username || !displayName || !temporaryPassword))
    || (username !== undefined && !usernamePattern.test(username))
    || (displayName !== undefined && (displayName.length < 1 || displayName.length > 120))
    || (temporaryPassword !== undefined && temporaryPassword.length > 256)
  ) return null
  return {
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(temporaryPassword === undefined ? {} : { temporaryPassword }),
  }
}

export async function handleAdminUsersRoute(context: AdminRequestContext): Promise<boolean> {
  const path = context.url.pathname
  if (context.request.method === 'GET' && path === '/api/v1/admin/users') {
    const authenticated = await requireAdmin(context)
    if (!authenticated) return true
    const query = (context.url.searchParams.get('query') ?? '').trim().slice(0, 100)
    const statusValue = context.url.searchParams.get('status') ?? 'all'
    const status = statusValue === 'active' || statusValue === 'disabled' ? statusValue : 'all'
    const page = Math.max(1, Number(context.url.searchParams.get('page') ?? 1) || 1)
    const pageSize = Math.min(
      100,
      Math.max(1, Number(context.url.searchParams.get('pageSize') ?? 25) || 25),
    )
    const result = await context.userRepository.list({
      query,
      status,
      page,
      pageSize,
    })
    sendAdminJson(context.response, 200, { ...result, page, pageSize })
    return true
  }

  if (context.request.method === 'POST' && path === '/api/v1/admin/users') {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const input = userFields(await readAdminJson(context.request), false)
    if (!input?.username || !input.displayName || !input.temporaryPassword) {
      sendAdminProblem(context.response, 400, 'USER_INPUT_INVALID', context.requestId)
      return true
    }
    return handleUserError(context, async () => {
      const user = await context.userRepository.create({
        username: input.username!,
        displayName: input.displayName!,
        temporaryPassword: input.temporaryPassword!,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      })
      sendAdminJson(context.response, 201, user)
    })
  }

  const direct = path.match(userPath)
  if (direct?.groups?.userId && context.request.method === 'GET') {
    const authenticated = await requireAdmin(context)
    if (!authenticated) return true
    const [user, subscription] = await Promise.all([
      context.userRepository.detail(direct.groups.userId),
      context.subscriptionRepository.current(direct.groups.userId),
    ])
    if (!user) sendAdminProblem(context.response, 404, 'USER_NOT_FOUND', context.requestId)
    else sendAdminJson(context.response, 200, { ...user, subscription })
    return true
  }

  if (direct?.groups?.userId && context.request.method === 'PATCH') {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const input = userFields(await readAdminJson(context.request), true)
    if (!input || (input.username === undefined && input.displayName === undefined)) {
      sendAdminProblem(context.response, 400, 'USER_INPUT_INVALID', context.requestId)
      return true
    }
    return handleUserError(context, async () => {
      sendAdminJson(context.response, 200, await context.userRepository.update({
        userId: direct.groups!.userId!,
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }))
    })
  }

  const action = path.match(actionPath)
  if (action?.groups?.userId && action.groups.action && context.request.method === 'POST') {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    return handleUserError(context, async () => {
      if (action.groups!.action === 'reset-password') {
        const body = await readAdminJson(context.request)
        if (typeof body.temporaryPassword !== 'string') {
          sendAdminProblem(context.response, 400, 'USER_PASSWORD_INVALID', context.requestId)
          return
        }
        await context.userRepository.resetPassword({
          userId: action.groups!.userId!,
          temporaryPassword: body.temporaryPassword,
          actorAdminUserId: authenticated.admin.adminUserId,
          requestId: context.requestId,
          sourceIp: context.sourceIp,
        })
      } else {
        await context.userRepository.setActive({
          userId: action.groups!.userId!,
          active: action.groups!.action === 'enable',
          actorAdminUserId: authenticated.admin.adminUserId,
          requestId: context.requestId,
          sourceIp: context.sourceIp,
        })
      }
      sendAdminJson(context.response, 200, { updated: true })
    })
  }
  return false
}

async function handleUserError(
  context: AdminRequestContext,
  operation: () => Promise<void>,
): Promise<true> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof AdminUserError) {
      const status = error.code === 'USER_NOT_FOUND'
        ? 404
        : error.code === 'USERNAME_ALREADY_EXISTS' ? 409 : 400
      sendAdminProblem(context.response, status, error.code, context.requestId)
      return true
    }
    throw error
  }
  return true
}
