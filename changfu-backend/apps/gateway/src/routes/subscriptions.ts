import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { sendJson, sendProblem } from '../../../../packages/http/src/problem.js'
import { parseObject, readBody } from '../../../../packages/http/src/router.js'
import {
  IdempotencyService,
  requestHash,
} from '../../../../packages/idempotency/src/idempotencyService.js'
import type { PaymentService } from '../../../../packages/payments/src/paymentService.js'
import type { PaymentChannel } from '../../../../packages/payments/src/paymentProvider.js'
import { PostgresSubscriptionRepository } from '../../../../packages/persistence/src/postgresSubscriptionRepository.js'
import {
  publicSubscriptionCatalog,
  type SubscriptionCatalog,
} from '../../../../packages/subscriptions/src/catalog.js'
import type { BillingPeriod } from '../../../../packages/subscriptions/src/billingClock.js'
import type { SubscriptionOrderType } from '../../../../packages/subscriptions/src/subscriptionService.js'

const maxBodyBytes = 128 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Context = {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  requestId: string
  userId: string
  pool: Pool
  catalog: SubscriptionCatalog
  paymentService: PaymentService
}

type ProviderSelection = {
  slotOrdinal: number
  providerId: string
}

function parseProviderSelections(value: unknown): ProviderSelection[] | null {
  if (!Array.isArray(value) || value.length < 1) return null
  const selections: ProviderSelection[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const item = entry as Record<string, unknown>
    if (
      !Number.isInteger(item.slotOrdinal)
      || Number(item.slotOrdinal) < 1
      || typeof item.providerId !== 'string'
      || !/^[A-Z][A-Z0-9_]{1,31}$/.test(item.providerId)
    ) return null
    selections.push({
      slotOrdinal: Number(item.slotOrdinal),
      providerId: item.providerId,
    })
  }
  selections.sort((left, right) => left.slotOrdinal - right.slotOrdinal)
  if (
    new Set(selections.map(item => item.slotOrdinal)).size !== selections.length
    || new Set(selections.map(item => item.providerId)).size !== selections.length
    || selections.some((item, index) => item.slotOrdinal !== index + 1)
  ) return null
  return selections
}

function parsePeriod(value: unknown): BillingPeriod | null {
  return value === 'MONTHLY' || value === 'QUARTERLY' || value === 'YEARLY'
    ? value
    : null
}

async function idempotentJson(
  context: Context,
  operation: string,
  execute: (
    body: Record<string, unknown>,
    idempotencyKey: string,
  ) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const key = context.request.headers['idempotency-key']?.toString()
  if (!key || key.length < 16 || key.length > 128) {
    sendProblem(context.response, 400, 'IDEMPOTENCY_KEY_REQUIRED', context.requestId)
    return
  }
  const raw = await readBody(context.request, maxBodyBytes)
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
  const result = await execute(raw.length ? parseObject(raw) : {}, key)
  await service.complete({
    userId: context.userId,
    operation,
    key,
    requestHash: hash,
    response: result,
  })
  sendJson(context.response, result.status, result.body)
}

export async function handleSubscriptionRoute(context: Context): Promise<boolean> {
  const { request, response, url, requestId, userId, catalog, paymentService } = context
  const repository = new PostgresSubscriptionRepository(context.pool, catalog)

  if (request.method === 'GET' && url.pathname === '/v1/subscription/catalog') {
    sendJson(response, 200, publicSubscriptionCatalog(catalog, paymentService.availability()))
    return true
  }
  if (request.method === 'GET' && url.pathname === '/v1/subscription/current') {
    sendJson(response, 200, { subscription: await repository.getCurrent(userId) })
    return true
  }
  if (request.method === 'POST' && url.pathname === '/v1/subscription/orders') {
    await idempotentJson(context, 'subscription-orders:create', async (body, key) => {
      const orderType = body.orderType as SubscriptionOrderType
      const planVersionId = typeof body.planVersionId === 'string' ? body.planVersionId : null
      const billingPeriod = parsePeriod(body.billingPeriod)
      const selections = parseProviderSelections(body.providerSelections)
      if (
        !['NEW', 'RENEW', 'UPGRADE'].includes(orderType)
        || !planVersionId || !uuidPattern.test(planVersionId)
        || !billingPeriod || !selections
      ) return { status: 400, body: { code: 'SUBSCRIPTION_ORDER_INVALID', requestId } }
      return {
        status: 201,
        body: await repository.createOrder({
          userId,
          orderType,
          planVersionId,
          billingPeriod,
          providerIds: selections.map(item => item.providerId),
          idempotencyKey: key,
        }),
      }
    })
    return true
  }
  const orderMatch = url.pathname.match(
    /^\/v1\/subscription\/orders\/(?<id>[0-9a-f-]+)$/i,
  )
  if (request.method === 'GET' && orderMatch?.groups?.id) {
    const order = await repository.getOrder(userId, orderMatch.groups.id)
    if (!order) sendProblem(response, 404, 'SUBSCRIPTION_ORDER_NOT_FOUND', requestId)
    else sendJson(response, 200, order)
    return true
  }
  const paymentMatch = url.pathname.match(
    /^\/v1\/subscription\/orders\/(?<id>[0-9a-f-]+)\/payment$/i,
  )
  if (request.method === 'POST' && paymentMatch?.groups?.id) {
    await idempotentJson(
      context,
      `subscription-orders:payment:${paymentMatch.groups.id}`,
      async body => {
        const channel = body.channel as PaymentChannel
        if (!['WECHAT', 'ALIPAY', 'DOUYIN'].includes(channel)) {
          return { status: 400, body: { code: 'PAYMENT_CHANNEL_INVALID', requestId } }
        }
        return {
          status: 200,
          body: await paymentService.startPayment({
            userId,
            orderId: paymentMatch.groups!.id!,
            channel,
          }),
        }
      },
    )
    return true
  }
  if (request.method === 'POST' && url.pathname === '/v1/subscription/changes') {
    await idempotentJson(context, 'subscription-changes:create', async body => {
      const planVersionId = typeof body.planVersionId === 'string' ? body.planVersionId : null
      const billingPeriod = parsePeriod(body.billingPeriod)
      const retainedProviderIds = body.retainedProviderIds
      if (
        !planVersionId || !uuidPattern.test(planVersionId)
        || !billingPeriod
        || !Array.isArray(retainedProviderIds)
        || retainedProviderIds.some(item => typeof item !== 'string')
        || !Number.isInteger(body.expectedVersion)
        || Number(body.expectedVersion) < 1
      ) return { status: 400, body: { code: 'SUBSCRIPTION_CHANGE_INVALID', requestId } }
      return {
        status: 200,
        body: await repository.scheduleChange({
          userId,
          planVersionId,
          billingPeriod,
          retainedProviderIds: retainedProviderIds as string[],
          expectedVersion: Number(body.expectedVersion),
        }),
      }
    })
    return true
  }
  const slotMatch = url.pathname.match(
    /^\/v1\/subscription\/broker-slots\/(?<id>[0-9a-f-]+)$/i,
  )
  if (request.method === 'PUT' && slotMatch?.groups?.id) {
    await idempotentJson(
      context,
      `subscription-slots:update:${slotMatch.groups.id}`,
      async body => {
        const providerId = typeof body.providerId === 'string' ? body.providerId : null
        if (
          !providerId
          || !/^[A-Z][A-Z0-9_]{1,31}$/.test(providerId)
          || !Number.isInteger(body.expectedVersion)
          || Number(body.expectedVersion) < 1
        ) return { status: 400, body: { code: 'BROKER_SLOT_UPDATE_INVALID', requestId } }
        return {
          status: 200,
          body: await repository.bindSlot({
            userId,
            slotId: slotMatch.groups!.id!,
            providerId,
            expectedVersion: Number(body.expectedVersion),
          }),
        }
      },
    )
    return true
  }
  return false
}
