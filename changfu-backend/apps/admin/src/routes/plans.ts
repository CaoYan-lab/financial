import {
  AdminPlanError,
  type AdminPlanInput,
  type PlanCode,
} from '../../../../packages/persistence/src/postgresSubscriptionCatalogRepository.js'
import {
  readAdminJson,
  requireAdmin,
  sendAdminJson,
  sendAdminProblem,
  type AdminRequestContext,
} from '../http.js'

const planCodes = new Set<PlanCode>(['LITE', 'PRO', 'FLAGSHIP'])
const versionsPath = /^\/api\/v1\/admin\/plans\/(?<planCode>LITE|PRO|FLAGSHIP)\/versions$/
const versionPath = /^\/api\/v1\/admin\/plans\/(?<planCode>LITE|PRO|FLAGSHIP)\/versions\/(?<versionId>[0-9a-f-]+)$/
const actionPath = /^\/api\/v1\/admin\/plans\/(?<planCode>LITE|PRO|FLAGSHIP)\/versions\/(?<versionId>[0-9a-f-]+)\/(?<action>publish|retire)$/

function parsePlanInput(body: Record<string, unknown>): AdminPlanInput | null {
  const features = body.features
  const prices = body.prices
  if (
    typeof body.displayName !== 'string'
    || body.displayName.trim().length < 1
    || body.displayName.trim().length > 80
    || typeof body.effectiveFrom !== 'string'
    || !Date.parse(body.effectiveFrom)
    || !Number.isInteger(body.brokerSlotLimit)
    || Number(body.brokerSlotLimit) < 1
    || Number(body.brokerSlotLimit) > 100
    || (
      body.poolCapacityPerProvider !== null
      && (!Number.isInteger(body.poolCapacityPerProvider)
        || Number(body.poolCapacityPerProvider) < 1)
    )
    || (
      body.monthlyReplacementLimit !== null
      && (!Number.isInteger(body.monthlyReplacementLimit)
        || Number(body.monthlyReplacementLimit) < 0)
    )
    || !features || typeof features !== 'object' || Array.isArray(features)
    || !prices || !Array.isArray(prices) || prices.length !== 3
  ) return null
  const featureMap = features as Record<string, unknown>
  if (
    !Number.isInteger(featureMap.batchSize)
    || Number(featureMap.batchSize) < 1
    || Number(featureMap.batchSize) > 10_000
    || typeof featureMap.optionResearch !== 'boolean'
    || typeof featureMap.optionTrading !== 'boolean'
  ) return null
  const parsedPrices: AdminPlanInput['prices'] = []
  for (const price of prices) {
    if (!price || typeof price !== 'object' || Array.isArray(price)) return null
    const item = price as Record<string, unknown>
    if (
      (item.billingPeriod !== 'MONTHLY'
        && item.billingPeriod !== 'QUARTERLY'
        && item.billingPeriod !== 'YEARLY')
      || !Number.isInteger(item.amountMinor)
      || Number(item.amountMinor) < 1
    ) return null
    parsedPrices.push({
      billingPeriod: item.billingPeriod,
      amountMinor: Number(item.amountMinor),
    })
  }
  if (new Set(parsedPrices.map(item => item.billingPeriod)).size !== 3) return null
  const protection = featureMap.poolCapacityProtectionLimit
  if (
    protection !== undefined
    && (!Number.isInteger(protection) || Number(protection) < 1)
  ) return null
  return {
    displayName: body.displayName.trim(),
    effectiveFrom: body.effectiveFrom,
    brokerSlotLimit: Number(body.brokerSlotLimit),
    poolCapacityPerProvider: body.poolCapacityPerProvider === null
      ? null
      : Number(body.poolCapacityPerProvider),
    monthlyReplacementLimit: body.monthlyReplacementLimit === null
      ? null
      : Number(body.monthlyReplacementLimit),
    features: {
      batchSize: Number(featureMap.batchSize),
      optionResearch: featureMap.optionResearch,
      optionTrading: featureMap.optionTrading,
      ...(protection === undefined
        ? {}
        : { poolCapacityProtectionLimit: Number(protection) }),
    },
    prices: parsedPrices,
  }
}

export async function handleAdminPlansRoute(context: AdminRequestContext): Promise<boolean> {
  const path = context.url.pathname
  if (context.request.method === 'GET' && path === '/api/v1/admin/plans') {
    if (!await requireAdmin(context)) return true
    sendAdminJson(context.response, 200, await context.catalogRepository.list())
    return true
  }
  const versions = path.match(versionsPath)
  const planCode = versions?.groups?.planCode as PlanCode | undefined
  if (planCode && planCodes.has(planCode)) {
    if (context.request.method === 'GET') {
      if (!await requireAdmin(context)) return true
      sendAdminJson(context.response, 200, {
        items: await context.catalogRepository.versions(planCode),
      })
      return true
    }
    if (context.request.method === 'POST') {
      const authenticated = await requireAdmin(context, { mutation: true })
      if (!authenticated) return true
      return handlePlanError(context, async () => {
        const plan = await context.catalogRepository.createDraft({
          planCode,
          actorAdminUserId: authenticated.admin.adminUserId,
          requestId: context.requestId,
          sourceIp: context.sourceIp,
        })
        sendAdminJson(context.response, 201, plan)
      })
    }
  }
  const version = path.match(versionPath)
  if (
    context.request.method === 'PUT'
    && version?.groups?.planCode
    && version.groups.versionId
  ) {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const body = parsePlanInput(await readAdminJson(context.request))
    if (!body) {
      sendAdminProblem(context.response, 400, 'PLAN_INPUT_INVALID', context.requestId)
      return true
    }
    return handlePlanError(context, async () => {
      sendAdminJson(context.response, 200, await context.catalogRepository.updateDraft({
        ...body,
        planCode: version.groups!.planCode as PlanCode,
        planVersionId: version.groups!.versionId!,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }))
    })
  }
  const action = path.match(actionPath)
  if (
    context.request.method === 'POST'
    && action?.groups?.planCode
    && action.groups.versionId
    && action.groups.action
  ) {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    return handlePlanError(context, async () => {
      const input = {
        planCode: action.groups!.planCode as PlanCode,
        planVersionId: action.groups!.versionId!,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }
      if (action.groups!.action === 'publish') {
        await context.catalogRepository.publish(input)
      } else {
        await context.catalogRepository.retire(input)
      }
      sendAdminJson(context.response, 200, { updated: true })
    })
  }
  return false
}

async function handlePlanError(
  context: AdminRequestContext,
  operation: () => Promise<void>,
): Promise<true> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof AdminPlanError) {
      const status = error.code.endsWith('NOT_FOUND') ? 404 : 409
      sendAdminProblem(context.response, status, error.code, context.requestId)
      return true
    }
    throw error
  }
  return true
}
