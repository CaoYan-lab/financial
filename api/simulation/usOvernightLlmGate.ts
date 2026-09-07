import { llmUniverseItem } from './simulationUniverse.js'

const HONG_KONG_CLOSED_LLM_GATE_TICKERS = new Set(['07709', '07747', '09660'])

export function shouldSkipUsOvernightLlm(input: {
  ticker: string
  marketState?: string
  disableUsOvernightLlm?: boolean
  now?: Date
}): boolean {
  if (input.disableUsOvernightLlm === false) return false
  if (!isUsTicker(input.ticker)) return false
  if (isOvernightState(input.marketState)) return true
  const clockState = inferUsMarketState(input.now ?? new Date())
  if (!isOvernightState(clockState)) return false
  const state = normalizeMarketState(input.marketState)
  return !state || state === 'UNAVAILABLE'
}

export function shouldSkipUsClosedLlm(input: {
  ticker: string
  marketState?: string
  now?: Date
}): boolean {
  if (!isUsTicker(input.ticker)) return false
  const state = normalizeMarketState(input.marketState)
  if (isClosedState(state)) return true
  return (!state || state === 'UNAVAILABLE') && inferUsMarketState(input.now ?? new Date()) === 'CLOSED'
}

export function usOvernightLlmSkippedReason(marketState?: string): string {
  return `美股夜盘 LLM 请求已关闭，当前市场状态 ${String(marketState || 'unavailable')}，本轮让出并发给港股。`
}

export function usClosedLlmSkippedReason(marketState?: string): string {
  return `美股当前处于周末、节假日或休市状态（${String(marketState || '不可用')}），本轮不发送 LLM 请求。`
}

export function llmMarketSessionSkipReason(input: {
  ticker: string
  marketState?: string
  disableUsOvernightLlm?: boolean
  now?: Date
}): string | undefined {
  const marketState = input.marketState ?? inferLlmGateMarketState(input.ticker, input.now)
  if (shouldSkipUsClosedLlm({ ...input, marketState })) return usClosedLlmSkippedReason(marketState)
  if (shouldSkipUsOvernightLlm({ ...input, marketState })) return usOvernightLlmSkippedReason(marketState)
  if (shouldSkipHongKongClosedLlm({ ...input, marketState })) return hongKongClosedLlmSkippedReason(marketState)
  return undefined
}

export function orderSessionForMarketState(marketState?: string): 'RTH' | 'ETH' | undefined {
  const state = normalizeMarketState(marketState)
  if (state === 'MORNING' || state === 'AFTERNOON' || state === 'AUCTION' || state === 'TRADE_AT_LAST' || state === 'RTH') return 'RTH'
  if (state === 'PRE_MARKET_BEGIN' || state === 'PRE_MARKET_END' || state === 'AFTER_HOURS_BEGIN' || state === 'AFTER_HOURS_END') return 'ETH'
  return undefined
}

export function orderSubmissionSessionFailureReason(input: {
  ticker: string
  marketState?: string
  orderSession: string
  now?: Date
}): string | undefined {
  const state = input.marketState ?? inferLlmGateMarketState(input.ticker, input.now)
  if (shouldSkipUsClosedLlm({ ticker: input.ticker, marketState: state, now: input.now })) {
    return `当前为美股周末、节假日或休市状态（${String(state || '不可用')}），禁止提交真实订单。`
  }
  const normalized = normalizeMarketState(state)
  if (isOvernightState(normalized)) return '美股夜盘仅允许策略研究，当前版本禁止提交真实订单。'
  const currentOrderSession = orderSessionForMarketState(normalized)
  if (!currentOrderSession) return `当前市场状态 ${String(state || '不可用')} 不支持提交真实订单。`
  if (currentOrderSession !== input.orderSession) {
    return `订单时段为 ${input.orderSession}，当前市场时段要求 ${currentOrderSession}，请重新生成订单。`
  }
  return undefined
}

export function shouldSkipHongKongClosedLlm(input: {
  ticker: string
  marketState?: string
  now?: Date
}): boolean {
  if (!isHongKongClosedGateTicker(input.ticker)) return false
  if (isClosedHongKongState(input.marketState)) return true
  const clockState = inferHongKongMarketState(input.now ?? new Date())
  return isClosedHongKongState(clockState) && !isOpenHongKongState(input.marketState)
}

export function hongKongClosedLlmSkippedReason(marketState?: string): string {
  return `港股休市后 LLM 请求已关闭，当前市场状态 ${String(marketState || 'unavailable')}，本轮不评估 07709 / 07747 / 09660。`
}

function isUsTicker(ticker: string): boolean {
  const normalized = normalizeGateTicker(ticker)
  const item = llmUniverseItem(normalized)
  if (item?.market) return item.market === 'US'
  return !/^\d{5}$/.test(normalized)
}

function isOvernightState(marketState?: string): boolean {
  const state = normalizeMarketState(marketState)
  return state === 'OVERNIGHT' || state === 'NIGHT' || state === 'NIGHT_OPEN'
}

function isClosedState(marketState?: string): boolean {
  const state = normalizeMarketState(marketState)
  return state === 'CLOSED' || state === 'NONE' || state === 'REST'
}

function isHongKongClosedGateTicker(ticker: string): boolean {
  return HONG_KONG_CLOSED_LLM_GATE_TICKERS.has(normalizeGateTicker(ticker))
}

function normalizeGateTicker(ticker: string): string {
  const upper = ticker.toUpperCase().trim()
  const hkSymbol = upper.match(/^(\d{1,5})\.HK$/)
  if (hkSymbol) return hkSymbol[1].padStart(5, '0')
  const prefixedHk = upper.match(/^HK\.(\d{1,5})$/)
  if (prefixedHk) return prefixedHk[1].padStart(5, '0')
  const usSymbol = upper.match(/^([A-Z][A-Z0-9.-]*)\.US$/)
  if (usSymbol) return usSymbol[1]
  return upper
}

function isClosedHongKongState(marketState?: string): boolean {
  const state = normalizeMarketState(marketState)
  return state === 'CLOSED' || state === 'REST' || state === 'NONE' || state === 'UNAVAILABLE'
}

function isOpenHongKongState(marketState?: string): boolean {
  const state = normalizeMarketState(marketState)
  return state === 'WAITING_OPEN' || state === 'AUCTION' || state === 'PRE_MARKET_HK' || state === 'MORNING' || state === 'AFTERNOON'
}

function normalizeMarketState(marketState?: string): string {
  const raw = String(marketState ?? '').trim().toUpperCase()
  const compact = raw.replace(/[\s_-]/g, '')
  if (!compact) return ''
  if (compact.includes('OVERNIGHT')) return 'OVERNIGHT'
  if (compact === 'NIGHT' || compact === 'NIGHTOPEN') return 'NIGHT_OPEN'
  if (compact === 'PREMARKETHK') return 'PRE_MARKET_HK'
  if (compact === 'WAITINGOPEN') return 'WAITING_OPEN'
  if (compact === 'AUCTION') return 'AUCTION'
  if (compact === 'MORNING') return 'MORNING'
  if (compact === 'AFTERNOON') return 'AFTERNOON'
  if (compact.includes('PREMARKET')) return 'PRE_MARKET_BEGIN'
  if (compact.includes('POSTMARKET') || compact.includes('AFTERHOURS')) return 'AFTER_HOURS_BEGIN'
  if (compact === 'TRADING' || compact === 'NORMAL' || compact === 'REGULAR') return 'RTH'
  if (compact === '0' || compact === 'CLOSE' || compact === 'CLOSED' || compact === 'NOTOPEN') return 'CLOSED'
  if (compact === 'NONE') return 'NONE'
  if (compact === 'UNAVAILABLE') return 'UNAVAILABLE'
  if (compact === 'HALFTRADE' || compact === 'REST') return 'REST'
  return raw
}

function inferLlmGateMarketState(ticker: string, now = new Date()): string | undefined {
  if (isUsTicker(ticker)) return inferUsMarketState(now)
  if (isHongKongClosedGateTicker(ticker)) return inferHongKongMarketState(now)
  return undefined
}

function inferUsMarketState(now: Date): string {
  const parts = zonedParts(now, 'America/New_York')
  const minute = parts.hour * 60 + parts.minute
  if (parts.weekday === 6) return 'CLOSED'
  if (parts.weekday === 7) return minute >= 1200 ? 'OVERNIGHT' : 'CLOSED'
  if (minute < 240 || minute >= 1200) return 'OVERNIGHT'
  if (minute < 570) return 'PRE_MARKET_BEGIN'
  if (minute < 960) return 'RTH'
  return 'AFTER_HOURS_BEGIN'
}

function inferHongKongMarketState(now: Date): string {
  const parts = zonedParts(now, 'Asia/Hong_Kong')
  if (parts.weekday === 6 || parts.weekday === 7) return 'CLOSED'
  const minute = parts.hour * 60 + parts.minute
  if (minute < 540) return 'WAITING_OPEN'
  if (minute < 570) return 'AUCTION'
  if (minute < 720) return 'MORNING'
  if (minute < 780) return 'REST'
  if (minute < 960) return 'AFTERNOON'
  if (minute < 970) return 'TRADE_AT_LAST'
  return 'CLOSED'
}

function zonedParts(now: Date, timeZone: string): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    weekday: weekdayNumber(value('weekday')),
    hour: Number(value('hour')) || 0,
    minute: Number(value('minute')) || 0,
  }
}

function weekdayNumber(label: string): number {
  const normalized = label.slice(0, 3).toLowerCase()
  return ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(normalized) + 1
}
