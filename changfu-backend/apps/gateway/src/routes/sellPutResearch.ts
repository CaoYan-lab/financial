import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  analyzeSellPutReport,
  SELL_PUT_PROMPT_VERSION,
  type SellPutObservation,
} from '../../../../packages/domain/src/sellPutResearch.js'
import { fetchSellPutTopThirty } from '../../../../packages/domain/src/sellPutUniverse.js'
import { SELL_PUT_PROMPT_TITLE } from '../../../../packages/domain/src/sellPutPrompt.js'
import { sendJson, sendProblem } from '../../../../packages/http/src/problem.js'
import { parseObject, readBody } from '../../../../packages/http/src/router.js'
import { IdempotencyService, requestHash } from '../../../../packages/idempotency/src/idempotencyService.js'
import {
  PostgresSellPutResearchRepository,
  SellPutResearchError,
  type SellPutProvider,
} from '../../../../packages/persistence/src/postgresSellPutResearchRepository.js'

const maxBodyBytes = 512 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const symbolPattern = /^(?:(US|HK)\.[A-Z0-9._-]{1,40}|[A-Z0-9._-]{1,40}\.(US|HK))$/

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

function provider(value: unknown): SellPutProvider | null {
  return value === 'FUTU' || value === 'LONGBRIDGE' ? value : null
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalFiniteOrNull(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseObservation(value: unknown): SellPutObservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (
    typeof row.requestId !== 'string' || !uuidPattern.test(row.requestId)
    || !Number.isInteger(row.rank) || Number(row.rank) < 1 || Number(row.rank) > 30
    || typeof row.symbol !== 'string' || !symbolPattern.test(row.symbol)
    || typeof row.displayName !== 'string' || row.displayName.length < 1 || row.displayName.length > 200
    || typeof row.country !== 'string' || row.country.length < 1 || row.country.length > 100
    || typeof row.capturedAt !== 'string' || !Number.isFinite(Date.parse(row.capturedAt))
    || optionalFiniteOrNull(row.currentPrice) === undefined
    || optionalFiniteOrNull(row.marketCap) === undefined
    || optionalFiniteOrNull(row.peRatio) === undefined
    || optionalFiniteOrNull(row.rsi14) === undefined
    || optionalFiniteOrNull(row.ma50) === undefined
    || optionalFiniteOrNull(row.ma200) === undefined
    || optionalFiniteOrNull(row.ivRank) === undefined
    || optionalFiniteOrNull(row.iv30) === undefined
    || (row.nextEarningsDate !== undefined
      && row.nextEarningsDate !== null
      && typeof row.nextEarningsDate !== 'string')
    || (row.sevenDayNews !== undefined && (
      !Array.isArray(row.sevenDayNews)
      || row.sevenDayNews.some(item => typeof item !== 'string' || item.length > 500)
    ))
    || optionalFiniteOrNull(row.trend20d) === undefined
    || optionalFiniteOrNull(row.trend60d) === undefined
    || optionalFiniteOrNull(row.trend120d) === undefined
    || optionalFiniteOrNull(row.distanceTo52wHigh) === undefined
    || optionalFiniteOrNull(row.distanceTo52wLow) === undefined
    || optionalFiniteOrNull(row.realizedVol30d) === undefined
    || optionalFiniteOrNull(row.change30dPercent) === undefined
    || !Array.isArray(row.dataGaps)
    || row.dataGaps.some(item => typeof item !== 'string' || item.length > 200)
  ) return null

  let option: SellPutObservation['option'] = null
  if (row.option !== null && row.option !== undefined) {
    if (typeof row.option !== 'object' || Array.isArray(row.option)) return null
    const source = row.option as Record<string, unknown>
    const optionalNumericKeys = [
      'bid', 'ask', 'lastPrice', 'delta',
      'impliedVolatility', 'volume', 'openInterest',
    ] as const
    if (
      typeof source.code !== 'string' || source.code.length > 128
      || typeof source.expiryDate !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(source.expiryDate)
      || finiteOrNull(source.strikePrice) === undefined
      || finiteOrNull(source.contractMultiplier) === undefined
      || optionalNumericKeys.some(key => optionalFiniteOrNull(source[key]) === undefined)
    ) return null
    option = {
      code: source.code,
      expiryDate: source.expiryDate,
      strikePrice: source.strikePrice as number,
      bid: optionalFiniteOrNull(source.bid)!,
      ask: optionalFiniteOrNull(source.ask)!,
      lastPrice: optionalFiniteOrNull(source.lastPrice)!,
      delta: optionalFiniteOrNull(source.delta)!,
      impliedVolatility: optionalFiniteOrNull(source.impliedVolatility)!,
      volume: optionalFiniteOrNull(source.volume)!,
      openInterest: optionalFiniteOrNull(source.openInterest)!,
      contractMultiplier: source.contractMultiplier as number,
    }
  }
  return {
    requestId: row.requestId,
    rank: Number(row.rank),
    symbol: row.symbol,
    displayName: row.displayName,
    country: row.country,
    capturedAt: row.capturedAt,
    currentPrice: optionalFiniteOrNull(row.currentPrice)!,
    marketCap: optionalFiniteOrNull(row.marketCap)!,
    peRatio: optionalFiniteOrNull(row.peRatio)!,
    rsi14: optionalFiniteOrNull(row.rsi14)!,
    ma50: optionalFiniteOrNull(row.ma50)!,
    ma200: optionalFiniteOrNull(row.ma200)!,
    ivRank: optionalFiniteOrNull(row.ivRank)!,
    iv30: optionalFiniteOrNull(row.iv30)!,
    nextEarningsDate: typeof row.nextEarningsDate === 'string' ? row.nextEarningsDate : null,
    sevenDayNews: Array.isArray(row.sevenDayNews) ? row.sevenDayNews as string[] : [],
    trend20d: optionalFiniteOrNull(row.trend20d)!,
    trend60d: optionalFiniteOrNull(row.trend60d)!,
    trend120d: optionalFiniteOrNull(row.trend120d)!,
    distanceTo52wHigh: optionalFiniteOrNull(row.distanceTo52wHigh)!,
    distanceTo52wLow: optionalFiniteOrNull(row.distanceTo52wLow)!,
    realizedVol30d: optionalFiniteOrNull(row.realizedVol30d)!,
    change30dPercent: optionalFiniteOrNull(row.change30dPercent)!,
    option,
    dataGaps: row.dataGaps as string[],
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

export async function handleSellPutResearchRoute(context: Context): Promise<boolean> {
  const { request, response, url, requestId, userId } = context
  const repository = new PostgresSellPutResearchRepository(context.pool)

  if (request.method === 'GET' && url.pathname === '/v1/sell-put/prompt') {
    sendJson(response, 200, {
      title: SELL_PUT_PROMPT_TITLE,
      promptVersion: SELL_PUT_PROMPT_VERSION,
      modelProfile: 'RISK_REVIEW',
      sections: [
        '全球市值 Top30 与股权类别合并',
        '基本面、RSI、均线与 20/60/120 日趋势',
        'IV30、实现波动率、Delta 与期权流动性',
        'Top 5 机会、Bottom 5 风险与 Wheel 退出条件',
      ],
      missingDataPolicy: '期权链或希腊值、流动性字段不完整时只返回数据缺口，不生成候选',
    })
    return true
  }

  const poolMatch = url.pathname.match(/^\/v1\/sell-put\/pools\/(?<provider>FUTU|LONGBRIDGE)$/)
  if (request.method === 'GET' && poolMatch?.groups?.provider) {
    sendJson(response, 200, await repository.getPool(
      userId,
      poolMatch.groups.provider as SellPutProvider,
    ))
    return true
  }

  const syncPoolMatch = url.pathname.match(
    /^\/v1\/sell-put\/pools\/(?<provider>FUTU|LONGBRIDGE)\/sync-top30$/,
  )
  if (request.method === 'POST' && syncPoolMatch?.groups?.provider) {
    const selectedProvider = syncPoolMatch.groups.provider as SellPutProvider
    await idempotentJson(context, `sell-put:pool:sync-top30:${selectedProvider}`, async () => {
      const universe = await fetchSellPutTopThirty()
      return {
        status: 200,
        body: await repository.syncTopThirty({
          userId,
          providerId: selectedProvider,
          companies: universe.companies,
          source: universe.source,
          sourceAccessedAt: universe.accessedAt,
          fallback: universe.fallback,
        }),
      }
    })
    return true
  }

  const addMatch = url.pathname.match(
    /^\/v1\/sell-put\/pools\/(?<provider>FUTU|LONGBRIDGE)\/items$/,
  )
  if (request.method === 'POST' && addMatch?.groups?.provider) {
    await idempotentJson(context, `sell-put:pool:add:${addMatch.groups.provider}`, async body => {
      const normalizedSymbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : ''
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
      if (
        !symbolPattern.test(normalizedSymbol)
        || displayName.length < 1 || displayName.length > 200
        || (body.market !== 'US' && body.market !== 'HK')
      ) return { status: 400, body: { code: 'SELL_PUT_POOL_ITEM_INVALID', requestId } }
      return {
        status: 201,
        body: await repository.addPoolItem({
          userId,
          providerId: addMatch.groups!.provider as SellPutProvider,
          symbol: normalizedSymbol,
          displayName,
          market: body.market,
        }),
      }
    })
    return true
  }

  const deleteMatch = url.pathname.match(
    /^\/v1\/sell-put\/pools\/(?<provider>FUTU|LONGBRIDGE)\/items\/(?<item>[0-9a-f-]+)$/i,
  )
  if (request.method === 'DELETE' && deleteMatch?.groups?.provider && deleteMatch.groups.item) {
    if (!uuidPattern.test(deleteMatch.groups.item)) {
      sendProblem(response, 400, 'SELL_PUT_POOL_ITEM_INVALID', requestId)
      return true
    }
    await idempotentJson(
      context,
      `sell-put:pool:remove:${deleteMatch.groups.provider}:${deleteMatch.groups.item}`,
      async () => ({
        status: 200,
        body: await repository.removePoolItem({
          userId,
          providerId: deleteMatch.groups!.provider as SellPutProvider,
          itemId: deleteMatch.groups!.item!,
        }),
      }),
    )
    return true
  }

  if (request.method === 'POST' && url.pathname === '/v1/sell-put/reports') {
    await idempotentJson(context, 'sell-put:reports:create', async body => {
      const selectedProvider = provider(body.providerId)
      const observations = Array.isArray(body.observations)
        ? body.observations.map(parseObservation)
        : []
      if (
        !selectedProvider
        || !Number.isInteger(body.poolVersion) || Number(body.poolVersion) < 1
        || body.reportWindowDays !== 30
        || observations.length < 1
        || observations.some(item => item === null)
        || new Set(observations.map(item => item!.symbol)).size !== observations.length
      ) return { status: 400, body: { code: 'SELL_PUT_REPORT_INVALID', requestId } }
      const typedObservations = observations as SellPutObservation[]
      if (typedObservations.length !== 30) {
        return { status: 400, body: { code: 'SELL_PUT_TOP30_REQUIRED', requestId } }
      }
      const runId = randomUUID()
      const baseline = analyzeSellPutReport(typedObservations)
      let markdown = [
        '# Top30 Mega-Cap Cash-Secured Put 30D 规则审计报告',
        '',
        '> 长富Pro 综合分析暂时不可用，以下为确定性规则结果。所有缺失的期权链、希腊值和流动性字段均保留为数据缺口，未据此生成候选。',
        '',
        baseline.markdown,
      ].join('\n')
      let generationMode: 'MODEL' | 'DETERMINISTIC_FALLBACK' = 'DETERMINISTIC_FALLBACK'
      let modelErrorCode: string | null = null
      try {
        const upstream = await fetch(`${context.workerUrl}/internal/v1/sell-put/report`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${context.internalToken}`,
            'content-type': 'application/json',
            'x-request-id': requestId,
            'x-changfu-user-id': userId,
          },
          signal: AbortSignal.any([
            context.signal,
            AbortSignal.timeout(330_000),
          ]),
          body: JSON.stringify({
            runId,
            providerId: selectedProvider,
            generatedAt: baseline.generatedAt,
            observations: typedObservations,
            deterministicBaseline: baseline,
          }),
        })
        if (upstream.ok) {
          const generated = await upstream.json() as { markdown?: unknown }
          if (typeof generated.markdown === 'string' && generated.markdown.trim().length > 0) {
            markdown = generated.markdown
            generationMode = 'MODEL'
          } else {
            modelErrorCode = 'MODEL_RESPONSE_INVALID'
          }
        } else {
          modelErrorCode = `MODEL_HTTP_${upstream.status}`
        }
      } catch (error) {
        modelErrorCode = error instanceof Error ? error.name : 'MODEL_REQUEST_FAILED'
      }
      return {
        status: 201,
        body: await repository.createReport({
          userId,
          providerId: selectedProvider,
          poolVersion: Number(body.poolVersion),
          observations: typedObservations,
          runId,
          markdown,
          generationMode,
          modelErrorCode,
        }),
      }
    })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/v1/sell-put/reports/latest') {
    const selectedProvider = provider(url.searchParams.get('provider'))
    if (!selectedProvider) {
      sendProblem(response, 400, 'SELL_PUT_PROVIDER_INVALID', requestId)
      return true
    }
    const report = await repository.latestReport(userId, selectedProvider)
    if (!report) sendProblem(response, 404, 'SELL_PUT_REPORT_NOT_FOUND', requestId)
    else sendJson(response, 200, report)
    return true
  }

  if (request.method === 'GET' && url.pathname === '/v1/sell-put/reports/history') {
    const selectedProvider = provider(url.searchParams.get('provider'))
    const page = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 10)
    if (
      !selectedProvider || !Number.isInteger(page) || page < 1
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50
    ) {
      sendProblem(response, 400, 'SELL_PUT_QUERY_INVALID', requestId)
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

  const reportMatch = url.pathname.match(/^\/v1\/sell-put\/reports\/(?<run>[0-9a-f-]+)$/i)
  if (request.method === 'GET' && reportMatch?.groups?.run) {
    const selectedProvider = provider(url.searchParams.get('provider'))
    if (!uuidPattern.test(reportMatch.groups.run) || !selectedProvider) {
      sendProblem(response, 400, 'SELL_PUT_REPORT_QUERY_INVALID', requestId)
      return true
    }
    const report = await repository.getReport(userId, selectedProvider, reportMatch.groups.run)
    if (!report) sendProblem(response, 404, 'SELL_PUT_REPORT_NOT_FOUND', requestId)
    else sendJson(response, 200, report)
    return true
  }
  return false
}
