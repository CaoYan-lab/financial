import type { MarketSessionStatus, SimulationUniverseItem } from '../../shared/types.js'
import { realtimeStore } from '../realtime/realtimeStore.js'
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

export async function loadMarketSessions(tickers: string[]): Promise<Record<string, MarketSessionStatus>> {
  if (Date.now() - cachedAt < CACHE_TTL_MS && Object.keys(cachedSessions).length) return cachedSessions

  const bridge = await runPythonBridge<MarketStateBridgeResponse>('futu_market_state.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    tickers,
  })
  if (!bridge.ok || !bridge.data?.ok) return fallbackMarketSessions(tickers)

  const validStates = bridge.data.states.filter((state) => state.state && state.state !== 'UNAVAILABLE')
  if (!validStates.length) return fallbackMarketSessions(tickers)

  cachedAt = Date.now()
  cachedSessions = Object.fromEntries(validStates.map((state) => [state.ticker.toUpperCase(), state]))
  return cachedSessions
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

function fallbackMarketSessions(tickers: string[]): Record<string, MarketSessionStatus> {
  const realtimeSessions = Object.fromEntries(
    tickers
      .map((ticker) => sessionFromRealtimeQuote(ticker))
      .filter((session): session is MarketSessionStatus => Boolean(session))
      .map((session) => [session.ticker.toUpperCase(), session]),
  )
  const merged = { ...cachedSessions, ...realtimeSessions }
  if (Object.keys(merged).length) {
    cachedAt = Date.now()
    cachedSessions = merged
  }
  return cachedSessions
}

function sessionFromRealtimeQuote(ticker: string): MarketSessionStatus | undefined {
  const quote = realtimeStore.snapshot(ticker).quote
  const state = quote?.marketState?.toUpperCase()
  if (!state || state === 'UNAVAILABLE') return undefined
  const label = marketLabel(state)
  return {
    ticker: ticker.toUpperCase(),
    code: quote?.code || fallbackFutuCode(ticker),
    state,
    labelZh: label.labelZh,
    labelEn: label.labelEn,
    tradable: label.tradable,
    allowsExtendedHours: label.allowsExtendedHours,
    updatedAt: quote?.updatedAt || new Date().toISOString(),
  }
}

function fallbackFutuCode(ticker: string): string {
  const upper = ticker.toUpperCase()
  if (/^\d{5}$/.test(upper)) return `HK.${upper}`
  return `US.${upper}`
}

function marketLabel(state: string): Pick<MarketSessionStatus, 'labelZh' | 'labelEn' | 'tradable' | 'allowsExtendedHours'> {
  if (state === 'PRE_MARKET_BEGIN' || state === 'PRE_MARKET_END') return { labelZh: '盘前', labelEn: 'Pre-market', tradable: true, allowsExtendedHours: true }
  if (state === 'MORNING' || state === 'AFTERNOON' || state === 'AUCTION' || state === 'TRADE_AT_LAST') return { labelZh: '盘中', labelEn: 'Regular', tradable: true, allowsExtendedHours: false }
  if (state === 'AFTER_HOURS_BEGIN' || state === 'AFTER_HOURS_END') return { labelZh: '盘后', labelEn: 'After-hours', tradable: true, allowsExtendedHours: true }
  if (state === 'OVERNIGHT' || state === 'NIGHT' || state === 'NIGHT_OPEN') return { labelZh: '夜盘', labelEn: 'Overnight', tradable: true, allowsExtendedHours: true }
  if (state === 'WAITING_OPEN' || state === 'REST') return { labelZh: '等待开盘', labelEn: 'Waiting open', tradable: false, allowsExtendedHours: false }
  if (state === 'CLOSED' || state === 'NONE') return { labelZh: '休市', labelEn: 'Closed', tradable: false, allowsExtendedHours: false }
  return { labelZh: state, labelEn: state, tradable: false, allowsExtendedHours: false }
}
