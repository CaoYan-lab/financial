import {
  AdminSubscriptionError,
  type AdminBillingPeriod,
} from '../../../../packages/persistence/src/postgresAdminSubscriptionRepository.js'
import {
  readAdminJson,
  requireAdmin,
  sendAdminJson,
  sendAdminProblem,
  type AdminRequestContext,
} from '../http.js'

const basePath = /^\/api\/v1\/admin\/users\/(?<userId>[1-9][0-9]*)\/subscription$/
const grantsPath = /^\/api\/v1\/admin\/users\/(?<userId>[1-9][0-9]*)\/subscription-grants$/
const actionPath = /^\/api\/v1\/admin\/users\/(?<userId>[1-9][0-9]*)\/subscription\/(?<action>freeze|restore|cancel)$/
const slotsPath = /^\/api\/v1\/admin\/users\/(?<userId>[1-9][0-9]*)\/subscription\/slots$/
const historyPath = /^\/api\/v1\/admin\/users\/(?<userId>[1-9][0-9]*)\/subscription\/history$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const providerPattern = /^[A-Z][A-Z0-9_]{1,31}$/

function mutationBase(body: Record<string, unknown>): {
  expectedVersion: number
  reason: string
} | null {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (
    !Number.isInteger(body.expectedVersion)
    || Number(body.expectedVersion) < 0
    || reason.length < 3
    || reason.length > 1000
  ) return null
  return { expectedVersion: Number(body.expectedVersion), reason }
}

function providerIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.some(item => typeof item !== 'string' || !providerPattern.test(item))
  ) return null
  const result = value as string[]
  return new Set(result).size === result.length ? result : null
}

function grantInput(body: Record<string, unknown>): {
  expectedVersion: number
  reason: string
  planVersionId: string
  billingPeriod: AdminBillingPeriod
  startsAt: Date
  expiresAt: Date
  providerIds: string[]
  confirmImpact: boolean
} | null {
  const base = mutationBase(body)
  const providers = providerIds(body.providerIds)
  const billingPeriod = body.billingPeriod
  const startsAt = typeof body.startsAt === 'string' ? new Date(body.startsAt) : null
  const expiresAt = typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : null
  if (
    !base
    || typeof body.planVersionId !== 'string'
    || !uuidPattern.test(body.planVersionId)
    || (billingPeriod !== 'MONTHLY'
      && billingPeriod !== 'QUARTERLY'
      && billingPeriod !== 'YEARLY')
    || !startsAt || Number.isNaN(startsAt.getTime())
    || !expiresAt || Number.isNaN(expiresAt.getTime())
    || !providers
    || typeof body.confirmImpact !== 'boolean'
  ) return null
  return {
    ...base,
    planVersionId: body.planVersionId,
    billingPeriod,
    startsAt,
    expiresAt,
    providerIds: providers,
    confirmImpact: body.confirmImpact,
  }
}

export async function handleAdminUserSubscriptionsRoute(
  context: AdminRequestContext,
): Promise<boolean> {
  const path = context.url.pathname
  const direct = path.match(basePath)
  if (direct?.groups?.userId && context.request.method === 'GET') {
    if (!await requireAdmin(context)) return true
    const subscription = await context.subscriptionRepository.current(direct.groups.userId)
    sendAdminJson(context.response, 200, { subscription })
    return true
  }
  const history = path.match(historyPath)
  if (history?.groups?.userId && context.request.method === 'GET') {
    if (!await requireAdmin(context)) return true
    sendAdminJson(
      context.response,
      200,
      await context.subscriptionRepository.history(history.groups.userId),
    )
    return true
  }

  const grant = path.match(grantsPath) ?? direct
  if (
    grant?.groups?.userId
    && (
      (path.match(grantsPath) && context.request.method === 'POST')
      || (direct && context.request.method === 'PATCH')
    )
  ) {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const input = grantInput(await readAdminJson(context.request))
    if (!input) {
      sendAdminProblem(
        context.response,
        400,
        'SUBSCRIPTION_GRANT_INPUT_INVALID',
        context.requestId,
      )
      return true
    }
    return handleSubscriptionError(context, async () => {
      const subscription = await context.subscriptionRepository.grant({
        ...input,
        userId: grant.groups!.userId!,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      })
      sendAdminJson(context.response, direct ? 200 : 201, subscription)
    })
  }

  const action = path.match(actionPath)
  if (action?.groups?.userId && action.groups.action && context.request.method === 'POST') {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const input = mutationBase(await readAdminJson(context.request))
    if (!input) {
      sendAdminProblem(
        context.response,
        400,
        'SUBSCRIPTION_MUTATION_INPUT_INVALID',
        context.requestId,
      )
      return true
    }
    return handleSubscriptionError(context, async () => {
      sendAdminJson(context.response, 200, await context.subscriptionRepository.setStatus({
        ...input,
        userId: action.groups!.userId!,
        action: action.groups!.action as 'freeze' | 'restore' | 'cancel',
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }))
    })
  }

  const slots = path.match(slotsPath)
  if (slots?.groups?.userId && context.request.method === 'PUT') {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const body = await readAdminJson(context.request)
    const base = mutationBase(body)
    const providers = providerIds(body.providerIds)
    if (!base || !providers || typeof body.confirmImpact !== 'boolean') {
      sendAdminProblem(
        context.response,
        400,
        'SUBSCRIPTION_SLOTS_INPUT_INVALID',
        context.requestId,
      )
      return true
    }
    const confirmImpact = body.confirmImpact
    return handleSubscriptionError(context, async () => {
      sendAdminJson(context.response, 200, await context.subscriptionRepository.updateSlots({
        ...base,
        providerIds: providers,
        confirmImpact,
        userId: slots.groups!.userId!,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }))
    })
  }
  return false
}

async function handleSubscriptionError(
  context: AdminRequestContext,
  operation: () => Promise<void>,
): Promise<true> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof AdminSubscriptionError) {
      const status = error.code.endsWith('NOT_FOUND')
        ? 404
        : error.code.endsWith('CONFLICT')
          || error.code === 'SUBSCRIPTION_IMPACT_CONFIRMATION_REQUIRED'
          ? 409
          : 400
      sendAdminProblem(context.response, status, error.code, context.requestId)
      return true
    }
    throw error
  }
  return true
}
