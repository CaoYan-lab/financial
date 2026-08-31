import { LLM_SIMULATION_UNIVERSE } from '../api/simulation/simulationUniverse.js'

type MarketDataResponse = {
  ok: boolean
  source?: string
  symbol?: string
  ticker?: string
  lastPrice?: number
  bars?: unknown[]
  tickerPoints?: unknown[]
  asks?: unknown[]
  bids?: unknown[]
  warnings?: string[]
  reason?: string
}

type SubscriptionStatus = {
  state: string
  subscribedSymbols: string[]
  sdkAvailable: boolean
  lastError?: string
}

type CheckResult = {
  round: number
  inputSymbol: string
  ok: boolean
  source?: string
  symbol?: string
  lastPrice?: number
  bars: number
  points: number
  asks: number
  bids: number
  durationMs: number
  warnings: string[]
  error?: string
}

const API_BASE_URL = process.env.LONGBRIDGE_CONCURRENCY_API_URL ?? 'http://localhost:3001'
const CONCURRENCY = numberEnv('LONGBRIDGE_CACHE_TEST_CONCURRENCY', 26)
const ROUNDS = numberEnv('LONGBRIDGE_CACHE_TEST_ROUNDS', 1)
const MIN_BARS = numberEnv('LONGBRIDGE_CACHE_TEST_MIN_BARS', 60)
const MIN_POINTS = numberEnv('LONGBRIDGE_CACHE_TEST_MIN_POINTS', 1)
const REQUIRE_DEPTH = process.env.LONGBRIDGE_CACHE_TEST_REQUIRE_DEPTH !== '0'
const INPUT_SYMBOLS = (process.env.LONGBRIDGE_CACHE_TEST_SYMBOLS?.split(',').map((item) => item.trim()).filter(Boolean) ?? defaultSymbols()).slice(0, CONCURRENCY)

if (INPUT_SYMBOLS.length !== CONCURRENCY) {
  throw new Error(`需要 ${CONCURRENCY} 个标的来模拟并发，但当前只有 ${INPUT_SYMBOLS.length} 个。`)
}

console.log('Longbridge SDK cache concurrency check')
console.log(JSON.stringify({
  apiBaseUrl: API_BASE_URL,
  concurrency: CONCURRENCY,
  rounds: ROUNDS,
  minBars: MIN_BARS,
  minPoints: MIN_POINTS,
  requireDepth: REQUIRE_DEPTH,
  symbols: INPUT_SYMBOLS,
}, null, 2))

const subscription = await subscribe(INPUT_SYMBOLS)
console.log('Subscription status:', JSON.stringify(subscription, null, 2))
if (subscription.state !== 'subscribed' || !subscription.sdkAvailable) {
  throw new Error(`Longbridge SDK 订阅未就绪：${subscription.lastError ?? subscription.state}`)
}

const allResults: CheckResult[] = []
for (let round = 1; round <= ROUNDS; round += 1) {
  const startedAt = Date.now()
  const results = await Promise.all(INPUT_SYMBOLS.map((symbol) => checkSymbol(symbol, round)))
  allResults.push(...results)
  const failed = results.filter((item) => !item.ok)
  console.log(`Round ${round}: ${results.length - failed.length}/${results.length} passed in ${Date.now() - startedAt}ms`)
  printRound(results)
}

const failed = allResults.filter((item) => !item.ok)
const sourceCounts = allResults.reduce<Record<string, number>>((acc, item) => {
  const source = item.source ?? 'unknown'
  acc[source] = (acc[source] ?? 0) + 1
  return acc
}, {})

console.log('Source counts:', JSON.stringify(sourceCounts, null, 2))
if (failed.length) {
  console.error('FAILED: Longbridge SDK cache did not satisfy all concurrent reads.')
  console.error(JSON.stringify(failed, null, 2))
  process.exit(1)
}

console.log(`PASSED: ${CONCURRENCY} concurrent Longbridge cache reads completed without data loss.`)

async function subscribe(symbols: string[]): Promise<SubscriptionStatus> {
  const response = await fetch(`${API_BASE_URL}/api/longbridge/realtime/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols, waitForSeed: true }),
  })
  if (!response.ok) throw new Error(`订阅请求失败：HTTP ${response.status} ${await response.text()}`)
  return response.json() as Promise<SubscriptionStatus>
}

async function checkSymbol(inputSymbol: string, round: number): Promise<CheckResult> {
  const startedAt = Date.now()
  try {
    const response = await fetch(`${API_BASE_URL}/api/longbridge/realtime/${encodeURIComponent(inputSymbol)}`)
    if (!response.ok) {
      return failedResult(round, inputSymbol, startedAt, `HTTP ${response.status}: ${await response.text()}`)
    }
    const data = await response.json() as MarketDataResponse
    const bars = data.bars?.length ?? 0
    const points = data.tickerPoints?.length ?? 0
    const asks = data.asks?.length ?? 0
    const bids = data.bids?.length ?? 0
    const errors: string[] = []
    if (!data.ok) errors.push(data.reason ?? 'market data ok=false')
    if (data.source !== 'longbridge-sdk-cache') errors.push(`source=${data.source ?? 'missing'}`)
    if (!Number.isFinite(data.lastPrice) || (data.lastPrice ?? 0) <= 0) errors.push('lastPrice missing')
    if (bars < MIN_BARS) errors.push(`bars ${bars} < ${MIN_BARS}`)
    if (points < MIN_POINTS) errors.push(`points ${points} < ${MIN_POINTS}`)
    if (REQUIRE_DEPTH && (asks < 1 || bids < 1)) errors.push(`depth asks=${asks} bids=${bids}`)
    return {
      round,
      inputSymbol,
      ok: errors.length === 0,
      source: data.source,
      symbol: data.symbol,
      lastPrice: data.lastPrice,
      bars,
      points,
      asks,
      bids,
      durationMs: Date.now() - startedAt,
      warnings: [...(data.warnings ?? []), ...errors],
      error: errors.length ? errors.join('; ') : undefined,
    }
  } catch (error) {
    return failedResult(round, inputSymbol, startedAt, error instanceof Error ? error.message : String(error))
  }
}

function failedResult(round: number, inputSymbol: string, startedAt: number, error: string): CheckResult {
  return {
    round,
    inputSymbol,
    ok: false,
    bars: 0,
    points: 0,
    asks: 0,
    bids: 0,
    durationMs: Date.now() - startedAt,
    warnings: [],
    error,
  }
}

function printRound(results: CheckResult[]) {
  console.table(results.map((item) => ({
    round: item.round,
    input: item.inputSymbol,
    ok: item.ok,
    source: item.source ?? '-',
    symbol: item.symbol ?? '-',
    price: item.lastPrice ?? '-',
    bars: item.bars,
    points: item.points,
    asks: item.asks,
    bids: item.bids,
    ms: item.durationMs,
    error: item.error ?? '',
  })))
}

function defaultSymbols() {
  return LLM_SIMULATION_UNIVERSE.map((item) => item.market === 'HK' ? `${item.ticker}.HK` : `${item.ticker}.US`)
}

function numberEnv(key: string, fallback: number) {
  const value = Number(process.env[key])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
