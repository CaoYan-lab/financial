import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { sendJson, sendProblem } from '../../../../packages/http/src/problem.js'
import { parseObject, readBody } from '../../../../packages/http/src/router.js'
import {
  IdempotencyService,
  requestHash,
} from '../../../../packages/idempotency/src/idempotencyService.js'
import {
  ModelProviderConfigError,
  PostgresModelProviderConfigRepository,
  type ModelProviderProtocol,
} from '../../../../packages/model-provider/src/postgresModelProviderConfigRepository.js'

const maxBodyBytes = 16 * 1024

type Context = {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  requestId: string
  userId: string
  pool: Pool
  credentialKey: string
}

function normalizedEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.hash
      || url.search
    ) return null
    return url.toString()
  } catch {
    return null
  }
}

function parseInput(body: Record<string, unknown>): {
  displayName: string
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  apiKey: string | null
  enabled: boolean
} | null {
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  const protocol = body.protocol
  const endpoint = normalizedEndpoint(body.endpoint)
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : null
  if (
    displayName.length < 1 || displayName.length > 80
    || (
      protocol !== 'OPENAI_RESPONSES'
      && protocol !== 'OPENAI_CHAT_COMPLETIONS'
    )
    || !endpoint
    || model.length < 1 || model.length > 200
    || typeof body.enabled !== 'boolean'
    || (apiKey !== null && (apiKey.length < 8 || apiKey.length > 8192))
  ) return null
  return { displayName, protocol, endpoint, model, apiKey, enabled: body.enabled }
}

async function idempotentMutation(
  context: Context,
  operation: string,
  raw: Buffer,
  execute: () => Promise<unknown>,
): Promise<void> {
  const key = context.request.headers['idempotency-key']?.toString()
  if (!key || key.length < 16 || key.length > 128) {
    sendProblem(context.response, 400, 'IDEMPOTENCY_KEY_REQUIRED', context.requestId)
    return
  }
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
  const body = await execute()
  await service.complete({
    userId: context.userId,
    operation,
    key,
    requestHash: hash,
    response: { status: 200, body },
  })
  sendJson(context.response, 200, body)
}

export async function handleModelProviderConfigRoute(context: Context): Promise<boolean> {
  if (context.url.pathname !== '/v1/model-provider/config') return false
  const repository = new PostgresModelProviderConfigRepository(
    context.pool,
    context.credentialKey,
  )
  try {
    if (context.request.method === 'GET') {
      sendJson(context.response, 200, await repository.get(context.userId))
      return true
    }
    if (context.request.method === 'PUT') {
      const raw = await readBody(context.request, maxBodyBytes)
      const body = raw.length ? parseObject(raw) : {}
      const input = parseInput(body)
      if (!input) {
        sendProblem(context.response, 400, 'MODEL_PROVIDER_CONFIG_INVALID', context.requestId)
        return true
      }
      await idempotentMutation(context, 'model-provider-config:upsert', raw, () => (
        repository.upsert({ userId: context.userId, ...input })
      ))
      return true
    }
    if (context.request.method === 'DELETE') {
      const raw = await readBody(context.request, maxBodyBytes)
      if (raw.length > 0 && Object.keys(parseObject(raw)).length > 0) {
        sendProblem(context.response, 400, 'REQUEST_INVALID', context.requestId)
        return true
      }
      await idempotentMutation(context, 'model-provider-config:delete', raw, () => (
        repository.delete(context.userId)
      ))
      return true
    }
    return false
  } catch (error) {
    if (error instanceof ModelProviderConfigError) {
      const status = error.code === 'FLAGSHIP_SUBSCRIPTION_REQUIRED'
        ? 403
        : error.code === 'MODEL_API_KEY_REQUIRED'
          ? 400
          : 503
      sendProblem(context.response, status, error.code, context.requestId)
      return true
    }
    throw error
  }
}
