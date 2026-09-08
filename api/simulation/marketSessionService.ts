import type { MarketSessionStatus, SimulationUniverseItem } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'

type MarketStateBridgeResponse = {
  ok: boolean
  states: MarketSessionStatus[]
  updatedAt: string
  error?: string
}

const CACHE_TTL_MS = 30_000
let cachedAt = 0
let cachedSessions: Record<string, MarketSessionStatus> = {}
let refreshInFlight: Promise<void> | undefined

export async function loadMarketSessions(tickers: string[]): Promise<Record<string, MarketSessionStatus>> {
  const requested = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))]
  const cacheComplete = requested.every((ticker) => Boolean(cachedSessions[ticker]))
  if (Date.now() - cachedAt < CACHE_TTL_MS && cacheComplete) return cachedSessions

  if (refreshInFlight) {
    await refreshInFlight
    const refreshedComplete = requested.every((ticker) => Boolean(cachedSessions[ticker]))
    if (refreshedComplete && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSessions
  }

  refreshInFlight = refreshMarketSessions(tickers, requested)
  try {
    await refreshInFlight
  } finally {
    refreshInFlight = undefined
  }
  return cachedSessions
}

async function refreshMarketSessions(tickers: string[], requested: string[]): Promise<void> {
  const bridge = await runPythonBridge<MarketStateBridgeResponse>('futu_market_state.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    tickers,
  })
  if (!bridge.ok || !bridge.data?.ok) {
    unavailableMarketSessions(requested)
    return
  }

  const returned = new Map(bridge.data.states.map((state) => [state.ticker.toUpperCase(), state]))
  const completeStates = requested.map((ticker) =>
    returned.get(ticker) ?? unavailableMarketSession(ticker))
  cachedAt = Date.now()
  cachedSessions = {
    ...cachedSessions,
    ...Object.fromEntries(completeStates.map((state) => [state.ticker.toUpperCase(), state])),
  }
}

export function latestMarketSessions(): Record<string, MarketSessionStatus> {
  return cachedSessions
}

export function attachMarketSessions(universe: SimulationUniverseItem[], sessions: Record<string, MarketSessionStatus>): SimulationUniverseItem[] {
  return universe.map((item) => ({
    ...item,
    marketSession: sessions[item.ticker.toUpperCase()],
  }))
}

function unavailableMarketSessions(tickers: string[]): Record<string, MarketSessionStatus> {
  const merged = {
    ...cachedSessions,
    ...Object.fromEntries(tickers.map((ticker) => [ticker, unavailableMarketSession(ticker)])),
  }
  cachedAt = Date.now()
  cachedSessions = merged
  return cachedSessions
}

function unavailableMarketSession(ticker: string): MarketSessionStatus {
  return {
    ticker: ticker.toUpperCase(),
    code: fallbackFutuCode(ticker),
    state: 'UNAVAILABLE',
    labelZh: '状态不可用',
    labelEn: 'Unavailable',
    tradable: false,
    allowsExtendedHours: false,
    updatedAt: new Date().toISOString(),
  }
}

function fallbackFutuCode(ticker: string): string {
  const upper = ticker.toUpperCase()
  if (/^\d{5}$/.test(upper)) return `HK.${upper}`
  return `US.${upper}`
}
