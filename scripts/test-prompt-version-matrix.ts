import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import type { LiveAccountDashboardResponse, LlmTradingDecision, Position, SimulationUniverseItem } from '../shared/types.js'
import type { TradingPromptBroker, TradingPromptComparisonResult } from '../shared/tradingPromptTypes.js'
import { LLM_SIMULATION_UNIVERSE } from '../api/simulation/simulationUniverse.js'
import { loadLiveAccountDashboard } from '../api/live/liveAccountService.js'
import { requestLiveTradingDecision } from '../api/live/liveTradingDecisionService.js'
import { realtimeSubscriptionService } from '../api/realtime/realtimeSubscriptionService.js'
import { realtimeStore } from '../api/realtime/realtimeStore.js'
import { loadStrategyMarketData, type StrategyMarketData } from '../api/simulation/realtimeDataAdapter.js'
import { buildTrendContextSummary } from '../api/simulation/trendContextService.js'
import { loadLongbridgeLiveAccountDashboard } from '../api/longbridge/longbridgeAdapter.js'
import { requestLongbridgeLiveTradingDecision } from '../api/longbridge/longbridgeLiveDecisionService.js'
import { loadLongbridgeStrategyMarketData, normalizeLongbridgeSymbol } from '../api/longbridge/longbridgeMarketDataService.js'
import {
  createTradingPromptComparisonRun,
  appendTradingPromptComparisonResult,
  finishTradingPromptComparisonRun,
  latestTradingPromptComparison,
} from '../api/live/tradingPromptComparisonStore.js'
import {
  resolveTradingPromptMode,
  saveTradingPromptMode,
  tradingPromptReleaseStatus,
} from '../api/live/tradingPromptReleaseService.js'

dotenv.config({ path: ['.env.local', '.env', '.data/cloud-faas/secrets.env'] })

process.env.LIVE_TRADING_ENABLED = 'false'
process.env.FUTU_LIVE_TRADING_ENABLED = 'false'
process.env.LONGBRIDGE_LIVE_TRADING_ENABLED = 'false'
process.env.LONGBRIDGE_AUTO_SUBMIT_ENABLED = 'false'
delete process.env.TRADING_PROMPT_MODE
delete process.env.FUTU_PROMPT_MODE
delete process.env.LONGBRIDGE_PROMPT_MODE
delete process.env.FUTU_SINGLE_PROMPT_MODE
delete process.env.LONGBRIDGE_SINGLE_PROMPT_MODE

const concurrency = Math.max(1, Math.min(12, Number(process.env.PROMPT_MATRIX_CONCURRENCY ?? 8) || 8))
const dataWindow = {
  kline1mBars: 10,
  tickerPoints: 1,
  orderBookDepth: 0,
  pollIntervalSeconds: 60,
  reason: '双券商全标的提示词版本对比',
  source: 'fallback' as const,
}
const runId = `prompt-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const startedAt = new Date().toISOString()
const universe = [...LLM_SIMULATION_UNIVERSE]
const totalCases = universe.length * 4
const accountCache = new Map<string, { loadedAt: number; promise: Promise<LiveAccountDashboardResponse> }>()
createTradingPromptComparisonRun({
  id: runId, startedAt, completedAt: null, status: 'RUNNING',
  universeCount: universe.length, totalCases, completedCases: 0,
  passedCases: 0, failedCases: 0, reportPath: null, error: null,
})

process.on('uncaughtException', error => {
  realtimeSubscriptionService.stop()
  finishTradingPromptComparisonRun(runId, { status: 'FAILED', error: error.message })
  console.error(error)
  process.exit(1)
})

try {
  const contexts = await loadContexts(universe)
  for (const mode of ['legacy', 'live'] as const) {
    accountCache.clear()
    await switchMode('futu', mode)
    await switchMode('longbridge', mode)
    await mapLimit(contexts, concurrency, async context => {
      await Promise.all([
        evaluate('futu', mode, context),
        evaluate('longbridge', mode, context),
      ])
    })
  }
  const reportPath = await writeReport(runId)
  finishTradingPromptComparisonRun(runId, { status: 'COMPLETED', reportPath })
  const completed = latestTradingPromptComparison()
  console.log(JSON.stringify({
    run: completed.run,
    reportPath,
    summary: summarize(completed.results),
  }, null, 2))
} catch (error) {
  finishTradingPromptComparisonRun(runId, {
    status: 'FAILED',
    error: error instanceof Error ? error.message : 'unknown matrix test error',
  })
  throw error
} finally {
  realtimeSubscriptionService.stop()
  await restoreMode('futu', 'live')
  await restoreMode('longbridge', 'live')
}

type Context = {
  item: SimulationUniverseItem
  futuMarket: StrategyMarketData
  longbridgeMarket: Awaited<ReturnType<typeof loadLongbridgeStrategyMarketData>>
}

async function loadContexts(items: SimulationUniverseItem[]): Promise<Context[]> {
  realtimeSubscriptionService.start(items.map(item => item.ticker))
  await new Promise(resolveDelay => setTimeout(resolveDelay, 18_000))

  return mapLimit(items, 4, async item => {
    const symbol = item.market === 'HK' ? normalizeLongbridgeSymbol(item.ticker) : `${item.ticker}.US`
    const longbridgeMarket = await loadLongbridgeStrategyMarketData(symbol, {
      klineCount: dataWindow.kline1mBars,
      includeDepth: false,
      includeTrades: false,
    })
    return {
      item,
      futuMarket: futuMarket(item.ticker),
      longbridgeMarket,
    }
  })
}

function futuMarket(ticker: string): StrategyMarketData {
  const loaded = loadStrategyMarketData(ticker, dataWindow)
  if (loaded.ok) return loaded
  const snapshot = realtimeStore.snapshot(ticker)
  const price = Number(snapshot.quote?.price.replace(/[$,%\s,]/g, ''))
  if (snapshot.source !== 'futu-callback' || !Number.isFinite(price) || price <= 0) return loaded
  return {
    ok: true, ticker, lastPrice: price, bars: snapshot.klineBars,
    tickerPoints: snapshot.tickerPoints, asks: snapshot.asks, bids: snapshot.bids,
    lotSize: snapshot.quote?.lotSize, marketState: snapshot.quote?.marketState,
    updatedAt: snapshot.updatedAt || snapshot.quote?.updatedAt || new Date().toISOString(),
  }
}

async function switchMode(broker: TradingPromptBroker, mode: 'legacy' | 'live') {
  const current = await tradingPromptReleaseStatus(broker)
  await saveTradingPromptMode(broker, 'default', {
    mode, expectedRevision: current.revision, confirmed: true,
  })
  const roles = await Promise.all(['single', 'portfolio', 'managed'].map(role =>
    resolveTradingPromptMode(broker, role as 'single' | 'portfolio' | 'managed')))
  if (roles.some(resolved => resolved !== mode)) throw new Error(`${broker}切换${mode}后路由校验失败`)
}

async function restoreMode(broker: TradingPromptBroker, mode: 'legacy' | 'shadow' | 'live') {
  const current = await tradingPromptReleaseStatus(broker)
  if (current.selectedMode === mode) return
  await saveTradingPromptMode(broker, 'default', {
    mode, expectedRevision: current.revision, confirmed: true,
  }).catch(() => undefined)
}

async function evaluate(broker: TradingPromptBroker, mode: 'legacy' | 'live', context: Context) {
  const market = broker === 'futu' ? context.futuMarket : context.longbridgeMarket
  const currency = (context.item.tradingCurrency ?? 'USD') as 'USD' | 'HKD'
  const account = await freshAccount(broker, currency)
  const createdAt = new Date().toISOString()
  if (!account.ok || !market.ok) {
    appendResult({
      runId, broker, mode, ticker: context.item.ticker, modelRequested: false,
      contextOk: false, marketPrice: market.ok ? market.lastPrice : null,
      marketUpdatedAt: market.ok ? market.updatedAt : null, action: 'NOT_RUN',
      approved: false, requestOk: false, contractValid: null, policyValid: null,
      contextUsableAtResponse: null, durationMs: 0,
      reason: !account.ok ? '账户上下文不可用' : market.reason,
      riskAssessment: '上下文读取失败，未请求模型。',
      errors: [...(!account.ok ? account.warnings : []), ...(!market.ok ? [market.reason] : [])],
      rawOutput: null, contextSummary: contextSummary(account, market), createdAt,
    })
    return
  }
  const started = performance.now()
  let decision: LlmTradingDecision
  try {
    const trend = buildTrendContextSummary(context.item.ticker, {
      lookbackTradingDays: 7, barInterval: '30m', currentPrice: market.lastPrice,
    }, market.bars)
    decision = broker === 'futu'
      ? await requestLiveTradingDecision({
          ticker: context.item.ticker, universe, account, marketData: market,
          allPositions: account.positions, position: directPosition(account, context.item.ticker),
          dataWindow, riskModel: 'institutional_risk_guard_v1', trendContext: trend,
          managedOpenOrders: [], pendingOrders: [],
        })
      : await requestLongbridgeLiveTradingDecision({
          symbol: context.item.market === 'HK' ? normalizeLongbridgeSymbol(context.item.ticker) : `${context.item.ticker}.US`,
          account, marketData: market, dataWindow, trendContext: trend,
          universe, managedOpenOrders: [], pendingOrders: [],
        })
  } catch (error) {
    appendResult({
      runId, broker, mode, ticker: context.item.ticker, modelRequested: true,
      contextOk: true, marketPrice: market.lastPrice, marketUpdatedAt: market.updatedAt,
      action: 'ERROR', approved: false, requestOk: false, contractValid: null,
      policyValid: null, contextUsableAtResponse: null,
      durationMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : '模型调用异常',
      riskAssessment: '模型调用未完成。', errors: [error instanceof Error ? error.message : 'unknown error'],
      rawOutput: null, contextSummary: contextSummary(account, market), createdAt,
    })
    return
  }
  const routeCorrect = mode === 'legacy'
    ? !decision.promptAudit
    : decision.promptAudit?.mode === 'live' && decision.promptAudit.version.startsWith('dual-broker-production-')
  const requestOk = mode === 'legacy'
    ? routeCorrect && Boolean(decision.rawText) && decision.ok
    : routeCorrect && Boolean(decision.promptAudit?.rawText) && decision.promptAudit?.contractValid === true && decision.promptAudit?.policyValid === true
  appendResult({
    runId, broker, mode, ticker: context.item.ticker, modelRequested: true,
    contextOk: true, marketPrice: market.lastPrice, marketUpdatedAt: market.updatedAt,
    action: decision.promptAudit?.output?.action ?? decision.action,
    approved: decision.promptAudit?.output?.approved === true || decision.approved,
    requestOk, contractValid: decision.promptAudit?.contractValid ?? null,
    policyValid: decision.promptAudit?.policyValid ?? null,
    contextUsableAtResponse: decision.promptAudit?.contextUsableAtResponse ?? null,
    durationMs: Math.round(performance.now() - started), reason: decision.reason,
    riskAssessment: decision.riskAssessment,
    errors: [
      ...(!routeCorrect ? ['提示词版本路由不正确'] : []),
      ...(decision.promptAudit?.errors ?? []),
      ...(decision.error ? [decision.error] : []),
    ],
    rawOutput: decision.promptAudit?.output ?? decision.rawText ?? null,
    contextSummary: {
      ...contextSummary(account, market),
      route: mode === 'legacy' ? 'legacy-decision-service' : decision.promptAudit?.version ?? 'missing-new-audit',
    },
    createdAt,
  })
}

function freshAccount(broker: TradingPromptBroker, currency: 'USD' | 'HKD') {
  const key = `${broker}:${currency}`
  const cached = accountCache.get(key)
  if (cached && Date.now() - cached.loadedAt <= 30_000) return cached.promise
  const promise = broker === 'futu'
    ? loadLiveAccountDashboard({
        market: currency === 'HKD' ? 'HK' : 'US',
        tradingCurrency: currency,
        refreshCache: true,
      })
    : loadLongbridgeLiveAccountDashboard(currency, { force: true })
  accountCache.set(key, { loadedAt: Date.now(), promise })
  return promise
}

function appendResult(result: Omit<TradingPromptComparisonResult, 'id'>) {
  appendTradingPromptComparisonResult(result)
  console.log(`[${result.broker}/${result.mode}] ${result.ticker}: ${result.action} ${result.requestOk ? 'PASS' : 'FAIL'} ${result.durationMs}ms`)
}

function contextSummary(account: LiveAccountDashboardResponse, market: { ok: boolean; [key: string]: any }) {
  return {
    accountOk: account.ok,
    accountSourceAt: account.summary.source?.timestamp ?? account.summary.source?.accessedAt ?? null,
    positionCount: account.positions.length,
    marketOk: market.ok,
    marketPrice: market.ok ? market.lastPrice : null,
    marketUpdatedAt: market.ok ? market.updatedAt : null,
    marketState: market.ok ? market.marketState ?? null : null,
    bars: market.ok ? market.bars.length : 0,
    tickerPoints: market.ok ? market.tickerPoints.length : 0,
    asks: market.ok ? market.asks.length : 0,
    bids: market.ok ? market.bids.length : 0,
  }
}

function directPosition(account: LiveAccountDashboardResponse, ticker: string): Position | undefined {
  const normalized = ticker.toUpperCase().replace(/^0+(\d+)$/, '$1')
  return account.positions.find(position => {
    if (!['STOCK', 'ETF'].includes(position.assetType)) return false
    const candidate = (position.underlyingTicker || position.ticker).toUpperCase()
      .replace(/^US\.|^HK\./, '').replace(/\.US$|\.HK$/, '').replace(/^0+(\d+)$/, '$1')
    return candidate === normalized
  })
}

async function writeReport(id: string) {
  const data = latestTradingPromptComparison()
  const summary = summarize(data.results) as Record<string, { total: number; passed: number; failed: number; actions: Record<string, number> }>
  const reportDir = resolve('.trae/documents')
  await mkdir(reportDir, { recursive: true })
  const path = resolve(reportDir, `prompt_version_matrix_${id}.md`)
  const rows = data.results.map(result =>
    `| ${result.ticker} | ${result.broker === 'futu' ? 'Futu' : 'Longbridge'} | ${result.mode === 'legacy' ? '旧版' : '新版'} | ${result.action} | ${result.requestOk ? '通过' : '未通过'} | ${result.contractValid === null ? '-' : result.contractValid ? '通过' : '失败'} | ${result.policyValid === null ? '-' : result.policyValid ? '通过' : '失败'} | ${result.durationMs} | ${escapeCell(result.reason)} |`)
  const markdown = `# 双券商提示词版本全标的对比\n\n`
    + `- 运行编号：\`${id}\`\n- 开始时间：${startedAt}\n- 标的数：${universe.length}\n- 测试数：${totalCases}\n`
    + `- 安全边界：未启动评估引擎、未调用订单队列、未调用券商提交接口。\n\n`
    + `## 汇总\n\n| 券商 | 版本 | 通过/总数 | 信号分布 |\n| --- | --- | --- | --- |\n`
    + `| Futu | 旧版 | ${summary.futu_legacy.passed}/${summary.futu_legacy.total} | ${actionDistribution(summary.futu_legacy.actions)} |\n`
    + `| Futu | 新版 | ${summary.futu_live.passed}/${summary.futu_live.total} | ${actionDistribution(summary.futu_live.actions)} |\n`
    + `| Longbridge | 旧版 | ${summary.longbridge_legacy.passed}/${summary.longbridge_legacy.total} | ${actionDistribution(summary.longbridge_legacy.actions)} |\n`
    + `| Longbridge | 新版 | ${summary.longbridge_live.passed}/${summary.longbridge_live.total} | ${actionDistribution(summary.longbridge_live.actions)} |\n\n`
    + `“通过”表示真实模型请求成功且命中目标版本后端；新版还必须通过契约和政策校验。测试结果不进入订单队列。\n\n`
    + `| 标的 | 券商 | 版本 | 信号 | 结果 | 契约 | 政策 | 耗时毫秒 | 原因 |\n`
    + `| --- | --- | --- | --- | --- | --- | --- | ---: | --- |\n${rows.join('\n')}\n`
  await writeFile(path, markdown)
  return path
}

function escapeCell(value: string) {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 240)
}

function actionDistribution(actions: Record<string, number>) {
  return Object.entries(actions).map(([action, count]) => `${action} ${count}`).join('、')
}

function summarize(results: TradingPromptComparisonResult[]) {
  return Object.fromEntries((['futu', 'longbridge'] as const).flatMap(broker =>
    (['legacy', 'live'] as const).map(mode => {
      const items = results.filter(item => item.broker === broker && item.mode === mode)
      return [`${broker}_${mode}`, {
        total: items.length,
        passed: items.filter(item => item.requestOk).length,
        failed: items.filter(item => !item.requestOk).length,
        actions: Object.fromEntries([...new Set(items.map(item => item.action))].map(action => [
          action, items.filter(item => item.action === action).length,
        ])),
      }]
    })))
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index])
    }
  }))
  return results
}
