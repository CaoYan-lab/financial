import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { sendJson, sendProblem } from '../../../../packages/http/src/problem.js'
import { parseObject, readBody } from '../../../../packages/http/src/router.js'
import {
  IdempotencyService,
  requestHash,
} from '../../../../packages/idempotency/src/idempotencyService.js'
import {
  PostgresProviderPoolRepository,
  type ProviderPoolItemInput,
} from '../../../../packages/persistence/src/postgresProviderPoolRepository.js'
import type {
  PostgresSubscriptionCatalogRepository,
} from '../../../../packages/persistence/src/postgresSubscriptionCatalogRepository.js'

const maxBodyBytes = 128 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const providerPattern = /^[A-Z][A-Z0-9_]{1,31}$/

type Context = {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  requestId: string
  userId: string
  pool: Pool
  catalogRepository: PostgresSubscriptionCatalogRepository
}

export function normalizeProviderPoolSymbol(value: string): string {
  let normalized = value.trim().toUpperCase()
  while (/^(US|HK|CN|SG)\.\1\./.test(normalized)) {
    normalized = normalized.replace(/^(US|HK|CN|SG)\.\1\./, '$1.')
  }
  return normalized
}

function sendEtagJson(
  response: ServerResponse,
  status: number,
  etag: string,
  body?: unknown,
): void {
  response.writeHead(status, {
    etag,
    'cache-control': 'private, no-cache',
    ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
  })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

function parseItem(body: Record<string, unknown>): ProviderPoolItemInput | null {
  const nullableText = (value: unknown, max: number): string | null | undefined => (
    value === null ? null : typeof value === 'string' && value.length <= max ? value : undefined
  )
  const rawProviderSymbol = nullableText(body.providerSymbol, 128)
  const rawCanonicalSymbol = nullableText(body.canonicalSymbol, 128)
  const displayName = nullableText(body.displayName, 200)
  const underlyingSymbol = nullableText(body.underlyingSymbol, 128)
  const expiryDate = nullableText(body.expiryDate, 10)
  const strikePrice = nullableText(body.strikePrice, 80)
  const contractMultiplier = nullableText(body.contractMultiplier, 80)
  const sourceVerifiedAt = nullableText(body.sourceVerifiedAt, 40)
  if (
    !rawProviderSymbol || !rawCanonicalSymbol || !displayName || !sourceVerifiedAt
    || (body.market !== 'US' && body.market !== 'HK'
      && body.market !== 'CN' && body.market !== 'SG')
    || (body.instrumentType !== 'STOCK' && body.instrumentType !== 'ETF'
      && body.instrumentType !== 'OPTION')
    || (body.optionType !== null && body.optionType !== 'CALL' && body.optionType !== 'PUT')
    || underlyingSymbol === undefined || expiryDate === undefined
    || strikePrice === undefined || contractMultiplier === undefined
    || typeof body.currency !== 'string'
  ) return null
  const providerSymbol = normalizeProviderPoolSymbol(rawProviderSymbol)
  const canonicalSymbol = normalizeProviderPoolSymbol(rawCanonicalSymbol)
  return {
    providerSymbol,
    canonicalSymbol,
    displayName,
    market: body.market,
    instrumentType: body.instrumentType,
    optionType: body.optionType,
    underlyingSymbol: underlyingSymbol === null
      ? null
      : normalizeProviderPoolSymbol(underlyingSymbol),
    expiryDate,
    strikePrice,
    currency: body.currency,
    contractMultiplier,
    sourceVerifiedAt,
  }
}

async function idempotentJson(
  context: Context,
  operation: string,
  execute: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
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
  const result = await execute(raw.length ? parseObject(raw) : {})
  await service.complete({
    userId: context.userId,
    operation,
    key,
    requestHash: hash,
    response: result,
  })
  sendJson(context.response, result.status, result.body)
}

export async function handleProviderPoolRoute(context: Context): Promise<boolean> {
  const { request, response, url, requestId, userId } = context
  if (!url.pathname.startsWith('/v1/research/pools')) return false
  const repository = new PostgresProviderPoolRepository(
    context.pool,
    await context.catalogRepository.activeCatalog(),
  )

  if (request.method === 'GET' && url.pathname === '/v1/research/pools') {
    const result = await repository.listPools(userId)
    if (request.headers['if-none-match'] === result.etag) {
      sendEtagJson(response, 304, result.etag)
    } else {
      sendEtagJson(response, 200, result.etag, { items: result.items })
    }
    return true
  }
  const poolMatch = url.pathname.match(
    /^\/v1\/research\/pools\/(?<provider>[A-Z][A-Z0-9_]{1,31})$/,
  )
  if (request.method === 'GET' && poolMatch?.groups?.provider) {
    const limit = Number(url.searchParams.get('limit') ?? 100)
    const result = await repository.getPool({
      userId,
      providerId: poolMatch.groups.provider,
      cursor: url.searchParams.get('cursor'),
      limit,
    })
    if (request.headers['if-none-match'] === result.etag) {
      sendEtagJson(response, 304, result.etag)
    } else {
      sendEtagJson(response, 200, result.etag, result.data)
    }
    return true
  }
  const addMatch = url.pathname.match(
    /^\/v1\/research\/pools\/(?<provider>[A-Z][A-Z0-9_]{1,31})\/items$/,
  )
  if (request.method === 'POST' && addMatch?.groups?.provider) {
    await idempotentJson(
      context,
      `provider-pools:add:${addMatch.groups.provider}`,
      async body => {
        const item = parseItem(body)
        if (!item) {
          return { status: 400, body: { code: 'PROVIDER_POOL_ITEM_INVALID', requestId } }
        }
        return {
          status: 201,
          body: await repository.addItem({
            userId,
            providerId: addMatch.groups!.provider!,
            item,
          }),
        }
      },
    )
    return true
  }
  const deleteMatch = url.pathname.match(
    /^\/v1\/research\/pools\/(?<provider>[A-Z][A-Z0-9_]{1,31})\/items\/(?<item>[0-9a-f-]+)$/i,
  )
  if (
    request.method === 'DELETE'
    && deleteMatch?.groups?.provider
    && deleteMatch.groups.item
  ) {
    if (
      !providerPattern.test(deleteMatch.groups.provider)
      || !uuidPattern.test(deleteMatch.groups.item)
    ) {
      sendProblem(response, 400, 'PROVIDER_POOL_PATH_INVALID', requestId)
      return true
    }
    await idempotentJson(
      context,
      `provider-pools:delete:${deleteMatch.groups.provider}:${deleteMatch.groups.item}`,
      async () => ({
        status: 200,
        body: await repository.removeItem({
          userId,
          providerId: deleteMatch.groups!.provider!,
          itemId: deleteMatch.groups!.item!,
        }),
      }),
    )
    return true
  }
  return false
}
