import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import {
  QUANT_DIMENSION_LIMITS,
  QUANT_PROMPT_VERSION,
  QUANT_SCORING_VERSION,
  type QuantitativeEvidence,
  type QuantitativeObservation,
} from '../../../../packages/domain/src/quantitativeResearch.js'
import { fetchTopThirty } from '../../../../packages/domain/src/topThirtyUniverse.js'
import { sendJson, sendProblem } from '../../../../packages/http/src/problem.js'
import { parseObject, readBody } from '../../../../packages/http/src/router.js'
import { IdempotencyService, requestHash } from '../../../../packages/idempotency/src/idempotencyService.js'
import { safeLogger } from '../../../../packages/observability/src/safeLogger.js'
import {
  PostgresQuantitativeResearchRepository,
  QuantitativeResearchError,
  type QuantitativeProvider,
} from '../../../../packages/persistence/src/postgresQuantitativeResearchRepository.js'
import { FinraResearchClient } from '../../../../packages/research/src/finraResearchClient.js'
import { PostgresPublicSourceCache } from '../../../../packages/research/src/publicSourceCache.js'
import { SecResearchClient } from '../../../../packages/research/src/secResearchClient.js'
import { hasActiveSellPutEntitlement } from './sellPutResearch.js'

const maxBodyBytes = 1024 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const tickerPattern = /^[A-Z][A-Z0-9]*(?:\.[A-Z])?$/
const symbolPattern = /^(?:US\.[A-Z0-9.]+|[A-Z0-9.]+\.US)$/
const evidenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

type Context = {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  requestId: string
  userId: string
  pool: Pool
  workerUrl: string
  internalToken: string
  signal: AbortSignal
}

function provider(value: unknown): QuantitativeProvider | null {
  return value === 'FUTU' || value === 'LONGBRIDGE' ? value : null
}

export function quantitativeItemIdempotencyOperation(requestId: string): string {
  return `quantitative:item:${requestId}`
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

async function requireEntitlement(
  context: Context,
  selectedProvider: QuantitativeProvider,
): Promise<boolean> {
  if (await hasActiveSellPutEntitlement(context.pool, context.userId, selectedProvider)) {
    return true
  }
  sendProblem(
    context.response,
    403,
    'QUANTITATIVE_ENTITLEMENT_REQUIRED',
    context.requestId,
  )
  return false
}

export function parseQuantitativeObservation(
  value: unknown,
  expectedProvider: QuantitativeProvider,
  expectedRequestId: string,
): QuantitativeObservation | null {
  if (!isRecord(value)) return null
  const currentPrice = nullableNumber(value.currentPrice)
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.map(item => parseBrokerEvidence(item, expectedProvider))
    : null
  if (
    value.requestId !== expectedRequestId
    || !uuidPattern.test(expectedRequestId)
    || !Number.isInteger(value.rank)
    || Number(value.rank) < 1
    || Number(value.rank) > 30
    || typeof value.symbol !== 'string'
    || !symbolPattern.test(value.symbol)
    || typeof value.ticker !== 'string'
    || !tickerPattern.test(value.ticker)
    || typeof value.displayName !== 'string'
    || value.displayName.length < 1
    || value.displayName.length > 200
    || value.providerId !== expectedProvider
    || typeof value.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt))
    || currentPrice === undefined
    || !['FRESH', 'STALE', 'UNAVAILABLE'].includes(String(value.quoteFreshness))
    || !Number.isInteger(value.adjustedDailyBarCount)
    || Number(value.adjustedDailyBarCount) < 0
    || Number(value.adjustedDailyBarCount) > 10_000
    || evidence === null
    || evidence.length > 500
    || evidence.some(item => item === null)
    || !Array.isArray(value.dataGaps)
    || value.dataGaps.some(item => typeof item !== 'string' || item.length > 500)
  ) return null
  const expectedSymbol = expectedProvider === 'FUTU'
    ? `US.${value.ticker}`
    : `${value.ticker}.US`
  if (value.symbol !== expectedSymbol) return null
  return {
    requestId: expectedRequestId,
    rank: Number(value.rank),
    symbol: value.symbol,
    ticker: value.ticker,
    displayName: value.displayName,
    providerId: expectedProvider,
    capturedAt: value.capturedAt,
    currentPrice,
    quoteFreshness: value.quoteFreshness as QuantitativeObservation['quoteFreshness'],
    adjustedDailyBarCount: Number(value.adjustedDailyBarCount),
    evidence: evidence as QuantitativeEvidence[],
    dataGaps: value.dataGaps as string[],
  }
}

export async function handleQuantitativeResearchRoute(context: Context): Promise<boolean> {
  const { request, response, url, requestId, userId } = context
  const repository = new PostgresQuantitativeResearchRepository(context.pool)

  if (request.method === 'GET' && url.pathname === '/v1/quantitative/prompt') {
    sendJson(response, 200, {
      title: 'Top30 五层证据量化选股',
      promptVersion: QUANT_PROMPT_VERSION,
      scoringVersion: QUANT_SCORING_VERSION,
      dimensions: QUANT_DIMENSION_LIMITS,
      output: '只生成研究报告与 Top5，不写入交易候选池或订单',
    })
    return true
  }

  const poolMatch = url.pathname.match(
    /^\/v1\/quantitative\/pools\/(?<provider>FUTU|LONGBRIDGE)$/,
  )
  if (request.method === 'GET' && poolMatch?.groups?.provider) {
    const selectedProvider = poolMatch.groups.provider as QuantitativeProvider
    const result = await repository.getPool(userId, selectedProvider)
    if (result) sendJson(response, 200, result)
    else sendProblem(response, 404, 'QUANTITATIVE_POOL_NOT_FOUND', requestId)
    return true
  }

  const syncMatch = url.pathname.match(
    /^\/v1\/quantitative\/pools\/(?<provider>FUTU|LONGBRIDGE)\/sync-top30$/,
  )
  if (request.method === 'POST' && syncMatch?.groups?.provider) {
    const selectedProvider = syncMatch.groups.provider as QuantitativeProvider
    if (!await requireEntitlement(context, selectedProvider)) return true
    await idempotentJson(
      context,
      `quantitative:pool:sync-top30:${selectedProvider}`,
      async () => {
        const universe = await fetchTopThirty()
        if (universe.fallback) {
          return {
            status: 503,
            body: { code: 'QUANTITATIVE_UNIVERSE_UNAVAILABLE', requestId },
          }
        }
        return {
          status: 200,
          body: await repository.syncTopThirty({
            userId,
            providerId: selectedProvider,
            companies: universe.companies,
            source: universe.source,
            sourceAccessedAt: universe.accessedAt,
          }),
        }
      },
    )
    return true
  }

  if (request.method === 'POST' && url.pathname === '/v1/quantitative/runs') {
    await idempotentJson(context, 'quantitative:runs:start', async body => {
      const selectedProvider = provider(body.providerId)
      if (
        !selectedProvider
        || !Number.isInteger(body.poolVersion)
        || Number(body.poolVersion) < 1
        || (
          body.modelProfile !== undefined
          && !['fast', 'deep', 'risk'].includes(String(body.modelProfile))
        )
      ) {
        return { status: 400, body: { code: 'QUANTITATIVE_RUN_INVALID', requestId } }
      }
      if (!await hasActiveSellPutEntitlement(context.pool, userId, selectedProvider)) {
        return {
          status: 403,
          body: { code: 'QUANTITATIVE_ENTITLEMENT_REQUIRED', requestId },
        }
      }
      return {
        status: 201,
        body: await repository.startRun({
          userId,
          providerId: selectedProvider,
          poolVersion: Number(body.poolVersion),
          modelProfile: typeof body.modelProfile === 'string'
            ? body.modelProfile
            : 'deep',
        }),
      }
    })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/v1/quantitative/runs/active') {
    const selectedProvider = provider(url.searchParams.get('provider'))
    if (!selectedProvider) {
      sendProblem(response, 400, 'QUANTITATIVE_PROVIDER_INVALID', requestId)
      return true
    }
    const run = await repository.activeRun(userId, selectedProvider)
    if (run) sendJson(response, 200, run)
    else sendProblem(response, 404, 'QUANTITATIVE_ACTIVE_RUN_NOT_FOUND', requestId)
    return true
  }

  const statusMatch = url.pathname.match(
    /^\/v1\/quantitative\/runs\/(?<run>[0-9a-f-]+)\/status$/i,
  )
  if (request.method === 'GET' && statusMatch?.groups?.run) {
    const selectedProvider = provider(url.searchParams.get('provider'))
    if (!selectedProvider || !uuidPattern.test(statusMatch.groups.run)) {
      sendProblem(response, 400, 'QUANTITATIVE_RUN_QUERY_INVALID', requestId)
      return true
    }
    const run = await repository.getReport(
      userId,
      selectedProvider,
      statusMatch.groups.run,
    )
    if (run) sendJson(response, 200, run)
    else sendProblem(response, 404, 'QUANTITATIVE_RUN_NOT_FOUND', requestId)
    return true
  }

  const cancelMatch = url.pathname.match(
    /^\/v1\/quantitative\/runs\/(?<run>[0-9a-f-]+)\/cancel$/i,
  )
  if (request.method === 'POST' && cancelMatch?.groups?.run) {
    const runId = cancelMatch.groups.run
    if (!uuidPattern.test(runId)) {
      sendProblem(response, 400, 'QUANTITATIVE_RUN_INVALID', requestId)
      return true
    }
    await idempotentJson(context, `quantitative:run:cancel:${runId}`, async body => {
      const selectedProvider = provider(body.providerId)
      if (!selectedProvider) {
        return { status: 400, body: { code: 'QUANTITATIVE_PROVIDER_INVALID', requestId } }
      }
      return {
        status: 200,
        body: await repository.cancelRun({
          userId,
          providerId: selectedProvider,
          runId,
        }),
      }
    })
    return true
  }

  const itemMatch = url.pathname.match(
    /^\/v1\/quantitative\/runs\/(?<run>[0-9a-f-]+)\/items\/(?<request>[0-9a-f-]+)$/i,
  )
  if (
    request.method === 'POST'
    && itemMatch?.groups?.run
    && itemMatch.groups.request
  ) {
    const runId = itemMatch.groups.run
    const itemRequestId = itemMatch.groups.request
    if (!uuidPattern.test(runId) || !uuidPattern.test(itemRequestId)) {
      sendProblem(response, 400, 'QUANTITATIVE_ITEM_INVALID', requestId)
      return true
    }
    await idempotentJson(
      context,
      quantitativeItemIdempotencyOperation(itemRequestId),
      async body => {
        const selectedProvider = provider(body.providerId)
        if (!selectedProvider) {
          return { status: 400, body: { code: 'QUANTITATIVE_PROVIDER_INVALID', requestId } }
        }
        const brokerObservation = parseQuantitativeObservation(
          body.observation,
          selectedProvider,
          itemRequestId,
        )
        if (!brokerObservation) {
          return { status: 400, body: { code: 'QUANTITATIVE_OBSERVATION_INVALID', requestId } }
        }
        const modelProfile = await repository.runModelProfile({
          userId,
          providerId: selectedProvider,
          runId,
          requestId: itemRequestId,
          symbol: brokerObservation.symbol,
          ticker: brokerObservation.ticker,
          rank: brokerObservation.rank,
        })
        const enriched = await enrichWithOfficialEvidence(context.pool, brokerObservation)
        let scoreResult: unknown
        let rejectionReason: string | undefined
        try {
          const upstream = await fetch(`${context.workerUrl}/internal/v1/quantitative/score`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${context.internalToken}`,
              'content-type': 'application/json',
              'x-request-id': itemRequestId,
              'x-changfu-user-id': userId,
            },
            signal: AbortSignal.any([
              context.signal,
              AbortSignal.timeout(330_000),
            ]),
            body: JSON.stringify({ observation: enriched, modelProfile }),
          })
          const result = await upstream.json() as {
            scoreResult?: unknown
            code?: unknown
          }
          if (!upstream.ok || result.scoreResult === undefined) {
            rejectionReason = typeof result.code === 'string'
              ? result.code
              : `MODEL_HTTP_${upstream.status}`
          } else {
            scoreResult = result.scoreResult
          }
        } catch (error) {
          rejectionReason = error instanceof Error ? error.name : 'MODEL_REQUEST_FAILED'
        }
        return {
          status: 200,
          body: await repository.submitItem({
            userId,
            providerId: selectedProvider,
            runId,
            requestId: itemRequestId,
            observation: enriched,
            ...(rejectionReason
              ? { rejectionReason }
              : { scoreResult }),
          }),
        }
      },
    )
    return true
  }

  const finalizeMatch = url.pathname.match(
    /^\/v1\/quantitative\/runs\/(?<run>[0-9a-f-]+)\/finalize$/i,
  )
  if (request.method === 'POST' && finalizeMatch?.groups?.run) {
    const runId = finalizeMatch.groups.run
    if (!uuidPattern.test(runId)) {
      sendProblem(response, 400, 'QUANTITATIVE_RUN_INVALID', requestId)
      return true
    }
    await idempotentJson(context, `quantitative:run:finalize:${runId}`, async body => {
      const selectedProvider = provider(body.providerId)
      if (!selectedProvider) {
        return { status: 400, body: { code: 'QUANTITATIVE_PROVIDER_INVALID', requestId } }
      }
      return {
        status: 200,
        body: await repository.finalizeRun({
          userId,
          providerId: selectedProvider,
          runId,
        }),
      }
    })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/v1/quantitative/reports/latest') {
    const selectedProvider = provider(url.searchParams.get('provider'))
    if (!selectedProvider) {
      sendProblem(response, 400, 'QUANTITATIVE_PROVIDER_INVALID', requestId)
      return true
    }
    const report = await repository.latestReport(userId, selectedProvider)
    if (report) sendJson(response, 200, report)
    else sendProblem(response, 404, 'QUANTITATIVE_REPORT_NOT_FOUND', requestId)
    return true
  }

  if (request.method === 'GET' && url.pathname === '/v1/quantitative/reports/history') {
    const selectedProvider = provider(url.searchParams.get('provider'))
    const page = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 10)
    if (
      !selectedProvider
      || !Number.isInteger(page)
      || page < 1
      || !Number.isInteger(pageSize)
      || pageSize < 1
      || pageSize > 50
    ) {
      sendProblem(response, 400, 'QUANTITATIVE_QUERY_INVALID', requestId)
      return true
    }
    sendJson(response, 200, await repository.reportHistory({
      userId,
      providerId: selectedProvider,
      page,
      pageSize,
    }))
    return true
  }

  if (request.method === 'GET' && url.pathname === '/v1/quantitative/reports/compare') {
    const leftProvider = provider(url.searchParams.get('leftProvider'))
    const rightProvider = provider(url.searchParams.get('rightProvider'))
    const leftRunId = url.searchParams.get('leftRunId')
    const rightRunId = url.searchParams.get('rightRunId')
    if (
      !leftProvider
      || !rightProvider
      || leftProvider === rightProvider
      || !leftRunId
      || !rightRunId
      || !uuidPattern.test(leftRunId)
      || !uuidPattern.test(rightRunId)
    ) {
      sendProblem(response, 400, 'QUANTITATIVE_COMPARE_INVALID', requestId)
      return true
    }
    sendJson(response, 200, await repository.compareReports({
      userId,
      leftProviderId: leftProvider,
      leftRunId,
      rightProviderId: rightProvider,
      rightRunId,
    }))
    return true
  }

  const compareMatch = url.pathname.match(
    /^\/v1\/quantitative\/reports\/(?<run>[0-9a-f-]+)\/compare$/i,
  )
  if (request.method === 'GET' && compareMatch?.groups?.run) {
    const leftProvider = provider(url.searchParams.get('provider'))
    const rightProvider = provider(url.searchParams.get('otherProvider'))
    const rightRunId = url.searchParams.get('otherRunId')
    if (
      !leftProvider
      || !rightProvider
      || leftProvider === rightProvider
      || !uuidPattern.test(compareMatch.groups.run)
      || !rightRunId
      || !uuidPattern.test(rightRunId)
    ) {
      sendProblem(response, 400, 'QUANTITATIVE_COMPARE_INVALID', requestId)
      return true
    }
    sendJson(response, 200, await repository.compareReports({
      userId,
      leftProviderId: leftProvider,
      leftRunId: compareMatch.groups.run,
      rightProviderId: rightProvider,
      rightRunId,
    }))
    return true
  }

  const reportMatch = url.pathname.match(
    /^\/v1\/quantitative\/reports\/(?<run>[0-9a-f-]+)$/i,
  )
  if (request.method === 'GET' && reportMatch?.groups?.run) {
    const selectedProvider = provider(url.searchParams.get('provider'))
    if (!selectedProvider || !uuidPattern.test(reportMatch.groups.run)) {
      sendProblem(response, 400, 'QUANTITATIVE_REPORT_QUERY_INVALID', requestId)
      return true
    }
    const report = await repository.getReport(
      userId,
      selectedProvider,
      reportMatch.groups.run,
    )
    if (report) sendJson(response, 200, report)
    else sendProblem(response, 404, 'QUANTITATIVE_REPORT_NOT_FOUND', requestId)
    return true
  }
  return false
}

async function enrichWithOfficialEvidence(
  pool: Pool,
  observation: QuantitativeObservation,
): Promise<QuantitativeObservation> {
  const capturedAt = new Date(observation.capturedAt)
  const cache = new PostgresPublicSourceCache(pool, event => {
    safeLogger.info('quantitative_public_source_cache', event)
  })
  const [sec, finra] = await Promise.all([
    new SecResearchClient(cache).companyResearch(observation.ticker, capturedAt),
    new FinraResearchClient(cache).shortVolume(observation.ticker, capturedAt),
  ])
  const officialEvidence: QuantitativeEvidence[] = []
  for (const [name, fact] of Object.entries(sec.facts)) {
    if (!fact) continue
    officialEvidence.push({
      id: `sec:fact:${name}:${fact.accession}`,
      layer: 'fundamentals',
      source: 'SEC',
      title: `${name} ${fact.form}`,
      capturedAt: sec.capturedAt,
      asOf: fact.periodEnd,
      value: fact.value,
      metadata: {
        concept: fact.concept,
        unit: fact.unit,
        filedAt: fact.filedAt,
        accession: fact.accession,
        periodStart: fact.periodStart,
        fiscalYear: fact.fiscalYear,
        fiscalPeriod: fact.fiscalPeriod,
      },
    })
  }
  for (const event of sec.events) {
    officialEvidence.push({
      id: `sec:filing:${event.accession}`,
      layer: 'filings',
      source: 'SEC',
      title: event.form,
      capturedAt: sec.capturedAt,
      asOf: event.filedAt,
      value: event.sourceUrl,
      metadata: {
        acceptedAt: event.acceptedAt,
        periodEnd: event.periodEnd,
        primaryDocument: event.primaryDocument,
      },
    })
  }
  if (finra.latest) {
    officialEvidence.push({
      id: `finra:short-volume:${finra.latest.date}:${observation.ticker}`,
      layer: 'shortActivity',
      source: 'FINRA',
      title: 'FINRA 日度卖空成交',
      capturedAt: finra.capturedAt,
      asOf: finra.latest.date,
      value: finra.latest.shortVolumeRatio,
      metadata: {
        shortVolume: finra.latest.shortVolume,
        totalVolume: finra.latest.totalVolume,
        mean20: finra.mean20,
        mean60: finra.mean60,
        zScore60: finra.zScore60,
        change5Day: finra.change5Day,
        denominator: finra.denominator,
      },
    })
  }
  return {
    ...observation,
    evidence: [...observation.evidence, ...officialEvidence],
    dataGaps: [...new Set([
      ...observation.dataGaps,
      ...sec.dataGaps,
      ...finra.dataGaps,
    ])],
  }
}

function parseBrokerEvidence(
  value: unknown,
  expectedProvider: QuantitativeProvider,
): QuantitativeEvidence | null {
  if (!isRecord(value)) return null
  const validLayer = [
    'fundamentals',
    'filings',
    'shortActivity',
    'priceTrend',
    'macroFit',
  ].includes(String(value.layer))
  const metadata = value.metadata === undefined
    ? undefined
    : parseMetadata(value.metadata)
  if (
    typeof value.id !== 'string'
    || !evidenceIdPattern.test(value.id)
    || !validLayer
    || value.source !== expectedProvider
    || typeof value.title !== 'string'
    || value.title.length < 1
    || value.title.length > 300
    || typeof value.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt))
    || (value.asOf !== null && typeof value.asOf !== 'string')
    || !isPrimitive(value.value)
    || metadata === null
  ) return null
  return {
    id: value.id,
    layer: value.layer as QuantitativeEvidence['layer'],
    source: expectedProvider,
    title: value.title,
    capturedAt: value.capturedAt,
    asOf: value.asOf as string | null,
    value: value.value,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function parseMetadata(
  value: unknown,
): Record<string, string | number | boolean | null> | null {
  if (!isRecord(value) || Object.keys(value).length > 50) return null
  const result: Record<string, string | number | boolean | null> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 100 || !isPrimitive(item)) return null
    result[key] = item
  }
  return result
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function quantitativeRouteErrorStatus(error: unknown): {
  status: number
  code: string
} {
  if (!(error instanceof QuantitativeResearchError)) {
    return { status: 503, code: 'QUANTITATIVE_RESEARCH_UNAVAILABLE' }
  }
  if (error.code.endsWith('_NOT_FOUND')) return { status: 404, code: error.code }
  if (error.code.includes('CONFLICT') || error.code.includes('ACTIVE')) {
    return { status: 409, code: error.code }
  }
  return { status: 400, code: error.code }
}
