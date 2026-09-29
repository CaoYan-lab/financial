import { assertSafeModelEndpoint } from '../../../../packages/model-provider/src/endpointSecurity.js'
import { requestModelText } from '../../../../packages/model-provider/src/modelHttpClient.js'
import {
  OfficialModelConfigError,
} from '../../../../packages/model-provider/src/postgresOfficialModelConfigRepository.js'
import type {
  ModelProviderProtocol,
} from '../../../../packages/model-provider/src/postgresModelProviderConfigRepository.js'
import {
  readAdminJson,
  requireAdmin,
  sendAdminJson,
  sendAdminProblem,
  type AdminRequestContext,
} from '../http.js'

const basePath = '/api/v1/admin/official-model'
const versionsPath = `${basePath}/versions`
const versionPath = /^\/api\/v1\/admin\/official-model\/versions\/(?<versionId>[0-9a-f-]+)$/
const actionPath = /^\/api\/v1\/admin\/official-model\/versions\/(?<versionId>[0-9a-f-]+)\/(?<action>test|activate|retire|rollback)$/

function modelInput(body: Record<string, unknown>, apiKeyRequired: boolean): {
  displayName: string
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  apiKey: string | null
} | null {
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  const protocol = body.protocol
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : null
  let endpoint: string
  try {
    const parsed = new URL(typeof body.endpoint === 'string' ? body.endpoint : '')
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null
    endpoint = parsed.toString()
  } catch {
    return null
  }
  if (
    displayName.length < 1 || displayName.length > 80
    || (protocol !== 'OPENAI_RESPONSES' && protocol !== 'OPENAI_CHAT_COMPLETIONS')
    || model.length < 1 || model.length > 200
    || (apiKeyRequired && !apiKey)
    || (apiKey !== null && (apiKey.length < 8 || apiKey.length > 8192))
  ) return null
  return { displayName, protocol, endpoint, model, apiKey }
}

export async function handleAdminOfficialModelRoute(
  context: AdminRequestContext,
): Promise<boolean> {
  const path = context.url.pathname
  if (context.request.method === 'GET' && path === basePath) {
    if (!await requireAdmin(context)) return true
    sendAdminJson(context.response, 200, await context.officialModelRepository.list())
    return true
  }
  if (context.request.method === 'POST' && path === versionsPath) {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const parsed = modelInput(await readAdminJson(context.request, 16 * 1024), true)
    if (!parsed?.apiKey) {
      sendAdminProblem(context.response, 400, 'OFFICIAL_MODEL_INPUT_INVALID', context.requestId)
      return true
    }
    return handleOfficialModelError(context, async () => {
      await assertSafeModelEndpoint(parsed.endpoint)
      sendAdminJson(context.response, 201, await context.officialModelRepository.createDraft({
        ...parsed,
        apiKey: parsed.apiKey!,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }))
    })
  }
  const version = path.match(versionPath)
  if (context.request.method === 'PUT' && version?.groups?.versionId) {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    const parsed = modelInput(await readAdminJson(context.request, 16 * 1024), false)
    if (!parsed) {
      sendAdminProblem(context.response, 400, 'OFFICIAL_MODEL_INPUT_INVALID', context.requestId)
      return true
    }
    return handleOfficialModelError(context, async () => {
      await assertSafeModelEndpoint(parsed.endpoint)
      sendAdminJson(context.response, 200, await context.officialModelRepository.updateDraft({
        configVersionId: version.groups!.versionId!,
        ...parsed,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }))
    })
  }
  const action = path.match(actionPath)
  if (
    context.request.method === 'POST'
    && action?.groups?.versionId
    && action.groups.action
  ) {
    const authenticated = await requireAdmin(context, { mutation: true })
    if (!authenticated) return true
    return handleOfficialModelError(context, async () => {
      const input = {
        configVersionId: action.groups!.versionId!,
        actorAdminUserId: authenticated.admin.adminUserId,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      }
      if (action.groups!.action === 'test') {
        const config = await context.officialModelRepository.effective(input.configVersionId)
        if (!config) throw new OfficialModelConfigError('OFFICIAL_MODEL_CONFIG_NOT_FOUND')
        let errorCode: string | null = null
        try {
          await assertSafeModelEndpoint(config.endpoint)
          const output = await requestModelText({
            config,
            system: '你是长富Pro连通性检查器，只返回 OK。',
            user: '返回 OK',
            timeoutMs: 15_000,
            maxResponseBytes: 128 * 1024,
          })
          if (!output.trim()) throw new Error('MODEL_RESPONSE_INVALID')
        } catch (error) {
          const message = error instanceof Error ? error.message : 'MODEL_TEST_FAILED'
          errorCode = /^[A-Z0-9_]+$/.test(message) ? message : 'MODEL_TEST_FAILED'
        }
        const saved = await context.officialModelRepository.recordTest({
          ...input,
          succeeded: errorCode === null,
          errorCode,
        })
        sendAdminJson(context.response, 200, {
          succeeded: errorCode === null,
          config: saved,
        })
        return
      }
      if (action.groups!.action === 'activate') {
        await context.officialModelRepository.activate(input)
      } else if (action.groups!.action === 'retire') {
        await context.officialModelRepository.retire(input)
      } else {
        sendAdminJson(
          context.response,
          201,
          await context.officialModelRepository.createRollbackDraft(input),
        )
        return
      }
      sendAdminJson(context.response, 200, { updated: true })
    })
  }
  return false
}

async function handleOfficialModelError(
  context: AdminRequestContext,
  operation: () => Promise<void>,
): Promise<true> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof OfficialModelConfigError) {
      const status = error.code.endsWith('NOT_FOUND') ? 404
        : error.code.endsWith('MISSING') ? 503 : 409
      sendAdminProblem(context.response, status, error.code, context.requestId)
      return true
    }
    if (error instanceof Error && error.message === 'MODEL_ENDPOINT_NOT_ALLOWED') {
      sendAdminProblem(context.response, 400, error.message, context.requestId)
      return true
    }
    throw error
  }
  return true
}
