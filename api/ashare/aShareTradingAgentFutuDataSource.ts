import { runPythonBridge } from '../utils/runPythonBridge.js'
import { errorMessage, logger } from '../utils/logger.js'
import type { AShareRealtimeSnapshot } from './aShareRealtimeStore.js'
import type { AShareFutuStockContext, AShareMarketDataContext, AShareStockNewsContext } from './aShareTradingAgentTypes.js'
import type { AShareUniverseItem } from './types.js'

const DOUBAO_SEARCH_CUSTOM_URL = 'https://open.feedcoopapi.com/search_api/web_search'

type FutuStockNewsBridgeResponse = {
  ok: boolean
  source?: 'futu-news'
  status?: AShareStockNewsContext['status']
  articles?: AShareStockNewsContext['articles']
  warnings?: string[]
  error?: string
  generatedAt?: string
}

type FutuStockContextBridgeResponse = {
  ok: boolean
  source?: 'futu-openapi'
  status?: AShareFutuStockContext['status']
  generatedAt?: string
  futuCode?: string
  sections?: AShareFutuStockContext['sections']
  warnings?: string[]
  error?: string
}

export function buildAshareMarketDataContext(snapshot: AShareRealtimeSnapshot): AShareMarketDataContext {
  const partial = !snapshot.quote || snapshot.klineBars.length < 120 || snapshot.tickerPoints.length < 1
  return {
    source: 'futu-callback',
    status: partial ? 'PARTIAL' : 'OK',
    quote: snapshot.quote,
    recentKlineBars: snapshot.klineBars.slice(-120),
    recentTickerPoints: snapshot.tickerPoints.slice(-240),
    asks: snapshot.asks.slice(0, 5),
    bids: snapshot.bids.slice(0, 5),
    callbackStatus: snapshot.callbackStatus,
    updatedAt: snapshot.updatedAt,
  }
}

export async function fetchAshareFutuStockNewsContext(instrument: AShareUniverseItem): Promise<AShareStockNewsContext> {
  const generatedAt = new Date().toISOString()
  try {
    const bridge = await runPythonBridge<FutuStockNewsBridgeResponse>('futu_stock_news.py', {
      ticker: instrument.ticker,
      futuCode: instrument.futuCode,
      limit: Number(process.env.ASHARE_TRADING_AGENT_STOCK_NEWS_LIMIT ?? 20),
      lookbackHours: Number(process.env.ASHARE_TRADING_AGENT_STOCK_NEWS_LOOKBACK_HOURS ?? 48),
    })
    const data = bridge.data
    if (!bridge.ok || !data?.ok) {
      return fetchAshareStockNewsFromDoubao(instrument, generatedAt, data?.error || bridge.error || bridge.stderr || 'Futu stock news bridge unavailable.')
    }
    if (data.status === 'UNAVAILABLE' || !data.articles?.length) {
      return fetchAshareStockNewsFromDoubao(instrument, data.generatedAt ?? generatedAt, data.warnings?.join('; ') || 'Futu stock news unavailable.')
    }
    return {
      source: 'futu-news',
      status: data.status ?? (data.articles?.length ? 'OK' : 'UNAVAILABLE'),
      generatedAt: data.generatedAt ?? generatedAt,
      articles: data.articles ?? [],
      warnings: data.warnings ?? [],
    }
  } catch (error) {
    return fetchAshareStockNewsFromDoubao(instrument, generatedAt, error instanceof Error ? error.message : 'Futu stock news failed.')
  }
}

export async function fetchAshareFutuStockContext(instrument: AShareUniverseItem): Promise<AShareFutuStockContext> {
  const generatedAt = new Date().toISOString()
  try {
    const bridge = await runPythonBridge<FutuStockContextBridgeResponse>('futu_stock_context.py', {
      ticker: instrument.ticker,
      futuCode: instrument.futuCode,
      host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
      port: Number(process.env.FUTU_OPEND_PORT || 11111),
    })
    const data = bridge.data
    if (!bridge.ok || !data?.ok) {
      return unavailableFutuStockContext(instrument, generatedAt, data?.error || bridge.error || bridge.stderr || 'Futu stock context bridge unavailable.')
    }
    return {
      source: 'futu-openapi',
      status: data.status ?? 'UNAVAILABLE',
      generatedAt: data.generatedAt ?? generatedAt,
      futuCode: data.futuCode ?? instrument.futuCode,
      sections: data.sections ?? {},
      warnings: data.warnings ?? [],
    }
  } catch (error) {
    return unavailableFutuStockContext(instrument, generatedAt, error instanceof Error ? error.message : 'Futu stock context failed.')
  }
}

function unavailableStockNews(generatedAt: string, reason: string): AShareStockNewsContext {
  return {
    source: 'futu-news',
    status: 'UNAVAILABLE',
    generatedAt,
    articles: [],
    warnings: [`stockNewsContext: UNAVAILABLE - ${reason}`],
  }
}

async function fetchAshareStockNewsFromDoubao(instrument: AShareUniverseItem, generatedAt: string, futuReason: string): Promise<AShareStockNewsContext> {
  const apiKey = process.env.DOUBAO_SEARCH_API_KEY || process.env.SEARCH_INFINITY_API_KEY
  if (!apiKey) return unavailableStockNews(generatedAt, `${futuReason}; Doubao fallback unavailable: DOUBAO_SEARCH_API_KEY/SEARCH_INFINITY_API_KEY missing.`)
  const query = `${instrument.name} ${instrument.futuCode} A股 公告 新闻 研报 财报 资金流`
  const result = await requestDoubaoStockSearch(query, apiKey)
  if (result.ok === false) return unavailableStockNews(generatedAt, `${futuReason}; Doubao fallback failed: ${result.error}`)
  return {
    source: 'futu-news',
    status: result.articles.length ? 'OK' : 'UNAVAILABLE',
    generatedAt,
    articles: result.articles.slice(0, Number(process.env.ASHARE_TRADING_AGENT_STOCK_NEWS_LIMIT ?? 20)),
    warnings: [
      `stockNewsContext: Futu news unavailable - ${futuReason}`,
      'stockNewsContext: using Doubao Search fallback for ticker-specific public news; priority below market facts and hard risk controls.',
    ],
  }
}

async function requestDoubaoStockSearch(query: string, apiKey: string): Promise<{ ok: true; articles: AShareStockNewsContext['articles'] } | { ok: false; error: string }> {
  const timeoutMs = Math.max(3_000, Number(process.env.DOUBAO_SEARCH_TIMEOUT_MS ?? 15_000))
  const count = Math.max(1, Math.min(50, Number(process.env.DOUBAO_SEARCH_COUNT ?? 5)))
  try {
    const response = await fetch(process.env.DOUBAO_SEARCH_CUSTOM_URL || DOUBAO_SEARCH_CUSTOM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Query: query,
        SearchType: 'web',
        Count: count,
        Filter: {
          NeedContent: process.env.DOUBAO_SEARCH_NEED_CONTENT === 'true',
          NeedUrl: true,
          AuthInfoLevel: Number(process.env.DOUBAO_SEARCH_AUTH_INFO_LEVEL ?? 0),
        },
        NeedSummary: process.env.DOUBAO_SEARCH_NEED_SUMMARY !== 'false',
        TimeRange: process.env.DOUBAO_SEARCH_TIME_RANGE || 'OneMonth',
        QueryControl: {
          QueryRewrite: process.env.DOUBAO_SEARCH_QUERY_REWRITE === 'true',
        },
        ContentFormats: process.env.DOUBAO_SEARCH_CONTENT_FORMATS || 'text',
        Industry: process.env.DOUBAO_SEARCH_INDUSTRY || 'finance',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) return { ok: false, error: typeof payload === 'object' ? JSON.stringify(payload) : response.statusText }
    const error = (payload as { ResponseMetadata?: { Error?: unknown } } | undefined)?.ResponseMetadata?.Error
    if (error) return { ok: false, error: JSON.stringify(error) }
    const rows = (payload as { Result?: { WebResults?: unknown[] } } | undefined)?.Result?.WebResults ?? []
    return { ok: true, articles: normalizeDoubaoStockNews(rows) }
  } catch (error) {
    logger.warn({ event: 'ashare.trading_agent.stock_news.doubao_search_failed', query, error: errorMessage(error) }, 'A-share stock news Doubao search failed')
    return { ok: false, error: errorMessage(error) }
  }
}

function normalizeDoubaoStockNews(rows: unknown[]): AShareStockNewsContext['articles'] {
  return rows
    .map((row) => row as Record<string, unknown>)
    .map((row) => ({
      title: String(row.Title ?? '').trim(),
      source: String(row.SiteName ?? 'Doubao Search'),
      publishedAt: typeof row.PublishTime === 'string' ? row.PublishTime : undefined,
      url: typeof row.Url === 'string' ? row.Url : undefined,
      summary: typeof row.Summary === 'string' ? row.Summary : typeof row.Snippet === 'string' ? row.Snippet : undefined,
    }))
    .filter((item) => item.title)
}

function unavailableFutuStockContext(instrument: AShareUniverseItem, generatedAt: string, reason: string): AShareFutuStockContext {
  return {
    source: 'futu-openapi',
    status: 'UNAVAILABLE',
    generatedAt,
    futuCode: instrument.futuCode,
    sections: {},
    warnings: [`futuStockContext: UNAVAILABLE - ${reason}`],
  }
}
