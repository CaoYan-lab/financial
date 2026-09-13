import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import type { LiveAccountDashboardResponse, LlmTradingDecision, Position } from '../shared/types.js'
import { loadLiveAccountDashboard } from '../api/live/liveAccountService.js'
import { requestLiveTradingDecision } from '../api/live/liveTradingDecisionService.js'
import { realtimeSubscriptionService } from '../api/realtime/realtimeSubscriptionService.js'
import { realtimeStore } from '../api/realtime/realtimeStore.js'
import { loadStrategyMarketData } from '../api/simulation/realtimeDataAdapter.js'
import type { StrategyMarketData } from '../api/simulation/realtimeDataAdapter.js'
import { buildTrendContextSummary } from '../api/simulation/trendContextService.js'
import { loadLongbridgeLiveAccountDashboard } from '../api/longbridge/longbridgeAdapter.js'
import { requestLongbridgeLiveTradingDecision } from '../api/longbridge/longbridgeLiveDecisionService.js'
import {
  loadLongbridgeStrategyMarketData,
  normalizeLongbridgeSymbol,
} from '../api/longbridge/longbridgeMarketDataService.js'

dotenv.config({ path: ['.env.local', '.env', '.data/cloud-faas/secrets.env'] })

process.env.LIVE_TRADING_ENABLED = 'false'
process.env.LONGBRIDGE_LIVE_TRADING_ENABLED = 'false'
process.env.FUTU_PROMPT_MODE = 'live'
process.env.LONGBRIDGE_PROMPT_MODE = 'live'
process.on('uncaughtException', error => {
  realtimeSubscriptionService.stop()
  console.error(error)
  process.exit(1)
})

const dataWindow = {
  kline1mBars: 10,
  tickerPoints: 1,
  orderBookDepth: 0,
  pollIntervalSeconds: 60,
  reason: '真实上下文提示词验收',
  source: 'fallback' as const,
}

const startedAt = new Date().toISOString()
const [initialFutuAccount, initialLongbridgeAccount] = await Promise.all([
  loadLiveAccountDashboard({ market: 'US', tradingCurrency: 'USD', refreshCache: true }),
  loadLongbridgeLiveAccountDashboard('USD', { force: true }),
])
const ticker = commonUsTicker(initialFutuAccount, initialLongbridgeAccount) ?? process.argv[2]?.toUpperCase() ?? 'AAPL'
const symbol = normalizeLongbridgeSymbol(ticker)

const [futuMarket, longbridgeMarket] = await Promise.all([
  loadFutuMarket(ticker),
  loadLongbridgeStrategyMarketData(symbol, { klineCount: dataWindow.kline1mBars }),
])

const [futuAccount, longbridgeAccount] = await Promise.all([
  loadLiveAccountDashboard({ market: 'US', tradingCurrency: 'USD', refreshCache: true }),
  loadLongbridgeLiveAccountDashboard('USD', { force: true }),
])

if (!futuAccount.ok) throw new Error(`Futu账户读取失败：${futuAccount.warnings.join('；')}`)
if (!longbridgeAccount.ok) throw new Error(`Longbridge账户读取失败：${longbridgeAccount.warnings.join('；')}`)
if (!futuMarket.ok) throw new Error(`Futu行情读取失败：${futuMarket.reason}`)
if (!longbridgeMarket.ok) throw new Error(`Longbridge行情读取失败：${longbridgeMarket.reason}`)

const futuTrend = buildTrendContextSummary(ticker, {
  lookbackTradingDays: 7,
  barInterval: '30m',
  currentPrice: futuMarket.lastPrice,
}, futuMarket.bars)
const longbridgeTrend = buildTrendContextSummary(ticker, {
  lookbackTradingDays: 7,
  barInterval: '30m',
  currentPrice: longbridgeMarket.lastPrice,
}, longbridgeMarket.bars)

const decisions = await Promise.all([
  requestLiveTradingDecision({
    ticker,
    universe: [],
    account: futuAccount,
    marketData: futuMarket,
    allPositions: futuAccount.positions,
    position: directPosition(futuAccount, ticker),
    dataWindow,
    riskModel: 'institutional_risk_guard_v1',
    trendContext: futuTrend,
    managedOpenOrders: [],
    pendingOrders: [],
  }),
  requestLongbridgeLiveTradingDecision({
    symbol,
    account: longbridgeAccount,
    marketData: longbridgeMarket,
    dataWindow,
    trendContext: longbridgeTrend,
    universe: [],
    managedOpenOrders: [],
    pendingOrders: [],
  }),
])

const result = {
  startedAt,
  completedAt: new Date().toISOString(),
  safety: {
    evaluationEngineStarted: false,
    orderQueueCalled: false,
    brokerSubmitCalled: false,
    liveTradingEnabled: false,
  },
  ticker,
  brokers: {
    futu: brokerResult(futuAccount, futuMarket, decisions[0]!),
    longbridge: brokerResult(longbridgeAccount, longbridgeMarket, decisions[1]!),
  },
}

const outputDir = resolve('.data/trading-prompt-live-context-test')
await mkdir(outputDir, { recursive: true, mode: 0o700 })
const outputPath = resolve(outputDir, `${startedAt.replace(/[:.]/g, '-')}.json`)
await writeFile(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ outputPath, ...result }, null, 2))
realtimeSubscriptionService.stop()

async function loadFutuMarket(tickerInput: string): Promise<StrategyMarketData> {
  realtimeSubscriptionService.start([tickerInput])
  const deadline = Date.now() + 15_000
  let last = loadStrategyMarketData(tickerInput, dataWindow)
  while (!last.ok && Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
    last = loadStrategyMarketData(tickerInput, dataWindow)
  }
  if (!last.ok) {
    const snapshot = realtimeStore.snapshot(tickerInput)
    const price = Number(snapshot.quote?.price.replace(/[$,%\s,]/g, ''))
    if (snapshot.source === 'futu-callback' && Number.isFinite(price) && price > 0) {
      return {
        ok: true,
        ticker: tickerInput,
        lastPrice: price,
        bars: snapshot.klineBars,
        tickerPoints: snapshot.tickerPoints,
        asks: snapshot.asks,
        bids: snapshot.bids,
        lotSize: snapshot.quote?.lotSize,
        marketState: snapshot.quote?.marketState,
        updatedAt: snapshot.updatedAt || snapshot.quote?.updatedAt || new Date().toISOString(),
      }
    }
  }
  return last
}

function commonUsTicker(futu: LiveAccountDashboardResponse, longbridge: LiveAccountDashboardResponse) {
  const futuTickers = new Set(directUsTickers(futu.positions))
  return directUsTickers(longbridge.positions).find(item => futuTickers.has(item))
}

function directUsTickers(positions: Position[]) {
  return positions
    .filter(position => ['STOCK', 'ETF'].includes(position.assetType))
    .map(position => (position.underlyingTicker || position.ticker).toUpperCase().replace(/^US\./, '').replace(/\.US$/, ''))
    .filter(tickerInput => /^[A-Z][A-Z0-9.-]*$/.test(tickerInput))
}

function directPosition(account: LiveAccountDashboardResponse, tickerInput: string) {
  return account.positions.find(position =>
    ['STOCK', 'ETF'].includes(position.assetType)
    && (position.underlyingTicker || position.ticker).toUpperCase().replace(/^US\./, '').replace(/\.US$/, '') === tickerInput)
}

function brokerResult(account: LiveAccountDashboardResponse, market: {
  lastPrice: number
  updatedAt: string
  marketState?: string
  bars: unknown[]
  tickerPoints: unknown[]
  asks: unknown[]
  bids: unknown[]
  warnings?: string[]
}, decision: LlmTradingDecision) {
  return {
    context: {
      accountOk: account.ok,
      accountSourceAt: account.summary.source?.timestamp ?? account.summary.source?.accessedAt ?? null,
      positionCount: account.positions.length,
      directPositionQuantity: directPosition(account, decision.ticker)?.quantity ?? '0',
      marketPrice: market.lastPrice,
      marketUpdatedAt: market.updatedAt,
      marketState: market.marketState ?? null,
      bars: market.bars.length,
      tickerPoints: market.tickerPoints.length,
      asks: market.asks.length,
      bids: market.bids.length,
      warnings: market.warnings ?? [],
    },
    signal: {
      ok: decision.ok,
      approved: decision.approved,
      action: decision.action,
      ticker: decision.ticker,
      orderQuantity: decision.orderQuantity,
      limitPrice: decision.limitPrice,
      reason: decision.reason,
      riskAssessment: decision.riskAssessment,
      error: decision.error ?? null,
    },
    audit: decision.promptAudit ? {
      requestId: decision.promptAudit.requestId,
      version: decision.promptAudit.version,
      mode: decision.promptAudit.mode,
      ordersEnabled: decision.promptAudit.ordersEnabled,
      contextUsableAtResponse: decision.promptAudit.contextUsableAtResponse,
      contractValid: decision.promptAudit.contractValid,
      policyValid: decision.promptAudit.policyValid,
      errors: decision.promptAudit.errors,
      rawOutput: decision.promptAudit.output,
    } : null,
  }
}
