import dotenv from 'dotenv'
import { loadLongbridgeLiveAccountDashboard, loadLongbridgeSourceStatus } from '../api/longbridge/longbridgeAdapter.js'
import { longbridgeLiveTradingEngine } from '../api/longbridge/longbridgeLiveTradingEngine.js'
import { buildLongbridgeLiveDecisionPrompt } from '../api/longbridge/longbridgeLiveDecisionService.js'
import { loadLongbridgeStrategyMarketData } from '../api/longbridge/longbridgeMarketDataService.js'
import { longbridgeOrderQueueService } from '../api/longbridge/longbridgeOrderQueueService.js'

dotenv.config({ path: ['.env.local', '.env'] })

const symbol = process.argv[2] || 'AAPL.US'

const status = await loadLongbridgeSourceStatus()
console.log('Longbridge auth:', status.authStatus)
console.log('Longbridge CLI:', status.cliVersion)

const account = await loadLongbridgeLiveAccountDashboard()
console.log('Assets:', {
  totalAssets: account.summary.totalAssets,
  cash: account.summary.cash,
  buyingPower: account.summary.buyingPower,
  positions: account.positions.length,
})

const marketData = await loadLongbridgeStrategyMarketData(symbol, { klineCount: 30 })
console.log('Market data:', marketData.ok
  ? {
      symbol: marketData.symbol,
      ticker: marketData.ticker,
      lastPrice: marketData.lastPrice,
      bars: marketData.bars.length,
      ticks: marketData.tickerPoints.length,
      asks: marketData.asks.length,
      bids: marketData.bids.length,
      warnings: marketData.warnings,
    }
  : marketData)

if (marketData.ok) {
  const prompt = buildLongbridgeLiveDecisionPrompt({
    symbol: marketData.symbol,
    account,
    marketData,
    dataWindow: {
      kline1mBars: 30,
      tickerPoints: 30,
      orderBookDepth: 5,
      pollIntervalSeconds: 60,
      reason: 'Longbridge smoke test window.',
      source: 'fallback',
    },
  })
  const payload = JSON.parse(prompt[1].content)
  console.log('Prompt source:', {
    platform: payload.platformRuntime.platform,
    dataSource: payload.platformRuntime.dataSource,
    marketDataSource: payload.marketData.source,
    klineBars: payload.marketData.recentKlineBars.length,
  })
}

const runResult = await longbridgeLiveTradingEngine.runOnceDryRun(symbol)
console.log('Dry-run decision:', {
  ok: runResult.ok,
  action: runResult.decision?.action,
  approved: runResult.decision?.approved,
  signal: runResult.signal?.id,
  candidates: runResult.candidatePool.candidates.length,
  pendingOrders: runResult.pendingOrders.length,
  warnings: runResult.warnings,
})

const pending = runResult.pendingOrders[0]
if (pending) {
  const confirm = longbridgeOrderQueueService.confirmPendingOrder(pending.id)
  console.log('Gate check:', {
    ok: confirm.ok,
    blockedByGate: confirm.blockedByGate,
    error: confirm.error,
  })
} else {
  console.log('Gate check: skipped, no pending order generated.')
}
