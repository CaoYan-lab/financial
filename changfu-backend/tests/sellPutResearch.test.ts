import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { Pool } from 'pg'
import {
  analyzeSellPutReport,
  SELL_PUT_POOL_CAPACITY,
  SELL_PUT_PROMPT_VERSION,
  type SellPutObservation,
} from '../packages/domain/src/sellPutResearch.js'
import {
  lockSellPutTopThirty,
  parseStockAnalysisUniverse,
  providerSymbol,
  type SellPutUniverseCompany,
} from '../packages/domain/src/sellPutUniverse.js'
import {
  buildSellPutReportPrompt,
  SELL_PUT_PROMPT_TITLE,
} from '../packages/domain/src/sellPutPrompt.js'
import {
  hasActiveSellPutEntitlement,
  parseObservation,
} from '../apps/gateway/src/routes/sellPutResearch.js'

const base: SellPutObservation = {
  requestId: '11111111-1111-4111-8111-111111111111',
  rank: 1,
  symbol: 'US.NVDA',
  displayName: 'NVIDIA',
  country: 'United States',
  capturedAt: '2026-09-23T01:00:00.000Z',
  currentPrice: 180,
  marketCap: 4_000_000_000_000,
  peRatio: 45,
  rsi14: 58,
  ma50: 170,
  ma200: 150,
  ivRank: null,
  iv30: 42,
  nextEarningsDate: null,
  sevenDayNews: [],
  trend20d: 3,
  trend60d: 8,
  trend120d: 15,
  distanceTo52wHigh: -4,
  distanceTo52wLow: 60,
  realizedVol30d: 35,
  change30dPercent: 4.5,
  option: {
    code: 'US.NVDA261023P00160000',
    expiryDate: '2026-10-23',
    strikePrice: 160,
    bid: 2.8,
    ask: 3.2,
    lastPrice: 3,
    delta: -0.25,
    impliedVolatility: 42,
    volume: 800,
    openInterest: 2500,
    contractMultiplier: 100,
  },
  dataGaps: [],
}

test('SELL PUT 完整快照生成可审计候选和收益指标', () => {
  const report = analyzeSellPutReport([base], new Date('2026-09-23T02:00:00.000Z'))
  const item = report.items[0]!
  assert.equal(SELL_PUT_PROMPT_VERSION, 'top30-mega-cap-csp-v3')
  assert.equal(SELL_PUT_POOL_CAPACITY, 30)
  assert.equal(report.isUsableForAnalysis, true)
  assert.equal(report.candidateCount, 1)
  assert.equal(item.candidate, true)
  assert.equal(item.daysToExpiry, 30)
  assert.equal(item.premium, 3)
  assert.equal(item.safetyMarginPercent, 11.11)
  assert.equal(item.cashRequired, 16_000)
  assert.match(report.markdown, /Top 5 候选/)
})

test('缺少希腊值或流动性字段时只记录数据缺口且不生成候选', () => {
  const observation: SellPutObservation = {
    ...base,
    option: {
      ...base.option!,
      delta: null,
      openInterest: null,
    },
  }
  const report = analyzeSellPutReport(
    [observation],
    new Date('2026-09-23T02:00:00.000Z'),
  )
  assert.equal(report.isUsableForAnalysis, false)
  assert.equal(report.candidateCount, 0)
  assert.equal(report.items[0]!.candidate, false)
  assert.deepEqual(
    report.items[0]!.dataGaps,
    ['Delta不可用', '未平仓量不可用'],
  )
})

test('缺少期权链时报告仍可落库展示但不生成虚构策略', () => {
  const report = analyzeSellPutReport(
    [{ ...base, option: null, dataGaps: ['期权链请求失败'] }],
    new Date('2026-09-23T02:00:00.000Z'),
  )
  assert.equal(report.candidateCount, 0)
  assert.equal(report.items[0]!.optionCode, null)
  assert.equal(report.items[0]!.annualizedReturnPercent, null)
  assert.ok(report.items[0]!.dataGaps.includes('目标期限内无可用 PUT 期权链'))
})

test('SELL PUT 报告以专属 Top30 研究池校验版本和标的', () => {
  const source = readFileSync(
    new URL('../packages/persistence/src/postgresSellPutResearchRepository.ts', import.meta.url),
    'utf8',
  )
  const createReport = source.slice(
    source.indexOf('async createReport'),
    source.indexOf('async latestReport'),
  )
  assert.match(createReport, /changfu\.sell_put_research_pools/)
  assert.match(createReport, /changfu\.sell_put_research_pool_items/)
  assert.doesNotMatch(createReport, /changfu\.provider_research_pool/)
})

test('SELL PUT 写入只允许有效套餐已绑定的 Provider', async () => {
  let statement = ''
  let values: unknown[] = []
  const activePool = {
    query: async (text: string, parameters: unknown[]) => {
      statement = text
      values = parameters
      return { rows: [{ active: true }] }
    },
  } as unknown as Pick<Pool, 'query'>
  const inactivePool = {
    query: async () => ({ rows: [{ active: false }] }),
  } as unknown as Pick<Pool, 'query'>

  assert.equal(
    await hasActiveSellPutEntitlement(activePool, '42', 'FUTU'),
    true,
  )
  assert.equal(
    await hasActiveSellPutEntitlement(inactivePool, '42', 'LONGBRIDGE'),
    false,
  )
  assert.match(statement, /subscription\.status = 'ACTIVE'/)
  assert.match(statement, /subscription\.expires_at > now\(\)/)
  assert.match(statement, /slot\.status = 'ACTIVE'/)
  assert.deepEqual(values, ['42', 'FUTU'])
})

test('Top30 合并 Alphabet 与 Berkshire 股权类别后仍严格返回 30 家公司', () => {
  const companies: SellPutUniverseCompany[] = [
    { rank: 1, ticker: 'GOOGL', companyName: 'Alphabet A', marketCap: '1' },
    { rank: 2, ticker: 'GOOG', companyName: 'Alphabet C', marketCap: '1' },
    { rank: 3, ticker: 'BRK.A', companyName: 'Berkshire A', marketCap: '1' },
    { rank: 4, ticker: 'BRK.B', companyName: 'Berkshire B', marketCap: '1' },
    ...Array.from({ length: 28 }, (_, index) => ({
      rank: index + 5,
      ticker: `T${index + 1}`,
      companyName: `Company ${index + 1}`,
      marketCap: '1',
    })),
  ]
  const locked = lockSellPutTopThirty(companies)
  assert.equal(locked.length, 30)
  assert.equal(locked.filter(item => item.ticker === 'GOOG').length, 1)
  assert.equal(locked.filter(item => item.ticker.startsWith('BRK.')).length, 1)
  assert.equal(locked.find(item => item.companyName === 'Berkshire Hathaway')?.ticker, 'BRK.B')
  assert.equal(providerSymbol('FUTU', 'NVDA'), 'US.NVDA')
  assert.equal(providerSymbol('LONGBRIDGE', 'NVDA'), 'NVDA.US')
})

test('Top30 解析只保留美股代码并正确映射明确的跨市场上市标的', () => {
  const row = (
    rank: number,
    href: string,
    companyName: string,
    ticker: string,
    marketCap: string,
    price: string,
  ) => `
    <tr>
      <td>${rank}</td>
      <td>
        <a href="${href}">
          <div title="${companyName}">${companyName}</div>
          <div>${ticker}</div>
        </a>
      </td>
      <td>${marketCap}</td>
      <td>${price}</td>
    </tr>`
  const parsed = parseStockAnalysisUniverse([
    '<table>',
    row(1, '/stocks/nvda/', 'NVIDIA Corporation', 'NVDA', '5.73T', '$237.47'),
    row(
      2,
      '/quote/tpe/2330/',
      'Taiwan Semiconductor Manufacturing Company Limited',
      'TPE:2330',
      '2.07T',
      '$80.01',
    ),
    row(
      3,
      '/quote/tadawul/2222/',
      'Saudi Arabian Oil Company',
      'TADAWUL:2222',
      '1.66T',
      '$6.88',
    ),
    row(
      4,
      '/quote/hkg/0700/',
      'Tencent Holdings Limited',
      'HKG:0700',
      '473.78B',
      '$52.65',
    ),
    row(5, '/stocks/1.26t/', 'Invalid market-cap ticker', '1.26T', '1.26T', '$197.77'),
    '</table>',
  ].join(''))

  assert.deepEqual(parsed, [
    {
      rank: 1,
      ticker: 'NVDA',
      companyName: 'NVIDIA Corporation',
      marketCap: '5.73T',
    },
    {
      rank: 2,
      ticker: 'TSM',
      companyName: 'Taiwan Semiconductor Manufacturing Company Limited',
      marketCap: '2.07T',
    },
  ])
})

test('桌面 SELL PUT Prompt v3 与 Web 报告保留相同标题和硬约束', () => {
  const webArchive = readFileSync(
    new URL('../../api/services/reportPromptArchive.ts', import.meta.url),
    'utf8',
  )
  const webGenerator = readFileSync(
    new URL('../../api/services/llmReportAnalysisService.ts', import.meta.url),
    'utf8',
  )
  const messages = buildSellPutReportPrompt({
    runId: 'run-1',
    providerId: 'FUTU',
    generatedAt: base.capturedAt,
    observations: [base],
    deterministicBaseline: analyzeSellPutReport([base]),
  })
  const combined = messages.map(message => message.content).join('\n')
  assert.match(webArchive, new RegExp(SELL_PUT_PROMPT_TITLE))
  for (const requirement of [
    'Futu API Top30 数据',
    'selectedOptionPremiumSource',
    '20/60/120 日趋势',
    'Top 5 最值得操作机会',
    '禁止出现 EST premium',
  ]) {
    assert.match(webGenerator, new RegExp(requirement.replaceAll('/', '\\/')))
    assert.match(combined, new RegExp(requirement.replaceAll('/', '\\/')))
  }
  assert.doesNotMatch(messages[1]!.content, /"analysis":/)
})

test('Longbridge SELL PUT 报告只使用 Longbridge 数据源语义', () => {
  const messages = buildSellPutReportPrompt({
    runId: 'run-2',
    providerId: 'LONGBRIDGE',
    generatedAt: base.capturedAt,
    observations: [base],
    deterministicBaseline: analyzeSellPutReport([base]),
  })
  const combined = messages.map(message => message.content).join('\n')
  assert.match(combined, /Longbridge API Top30 数据/)
  assert.match(combined, /Longbridge option snapshot/)
  assert.match(combined, /Longbridge OpenAPI/)
  assert.doesNotMatch(combined, /Futu API|Futu option snapshot|Futu OpenD/)
})

test('SELL PUT 报告详情和桌面缓存按 Provider 隔离', () => {
  const gateway = readFileSync(
    new URL('../apps/gateway/src/routes/sellPutResearch.ts', import.meta.url),
    'utf8',
  )
  const worker = readFileSync(
    new URL('../apps/decision-worker/src/server.ts', import.meta.url),
    'utf8',
  )
  const repository = readFileSync(
    new URL('../packages/persistence/src/postgresSellPutResearchRepository.ts', import.meta.url),
    'utf8',
  )
  const appState = readFileSync(
    new URL('../../changfu-desktop/macos/App/AppState.swift', import.meta.url),
    'utf8',
  )
  const longbridgeHost = readFileSync(
    new URL('../../changfu-desktop/macos/LongbridgeHost/main.swift', import.meta.url),
    'utf8',
  )
  const workspace = readFileSync(
    new URL('../../changfu-desktop/macos/App/FutuWorkspaces.swift', import.meta.url),
    'utf8',
  )
  const apig = readFileSync(
    new URL('../deploy/volcano/scripts/configure-apig.sh', import.meta.url),
    'utf8',
  )
  assert.match(gateway, /providerId: selectedProvider/)
  assert.match(gateway, /getReport\(userId, selectedProvider, reportMatch\.groups\.run\)/)
  assert.match(gateway, /AbortSignal\.timeout\(330_000\)/)
  assert.match(worker, /sellPutReportModelTimeoutMs = modelRequestTimeoutMs/)
  assert.match(
    worker,
    /requestModelText\(\{[\s\S]*temperature: 0,[\s\S]*timeoutMs: sellPutReportModelTimeoutMs/,
  )
  assert.doesNotMatch(worker, /max_output_tokens: 6_000/)
  assert.match(repository, /provider_id = \$2 AND run_id = \$3::uuid/)
  assert.match(appState, /sellPutReports\[providerId\]/)
  assert.match(appState, /sellPutReportHistories\[providerId\]/)
  assert.match(appState, /sellPutRunStates\[providerId\]/)
  assert.match(appState, /!sellPutRunState\(for: providerId\)\.isRunning/)
  assert.doesNotMatch(appState, /sellPutRunningProviderId/)
  assert.match(appState, /providerId == "FUTU" \? 8 : 5/)
  assert.match(appState, /message\.contains\("429002"\)/)
  assert.match(appState, /validateLongbridgeSellPutAccess\(items\)/)
  assert.match(appState, /subscription\.grantsResearchAccess\(to: providerId\)/)
  assert.match(workspace, /\.disabled\(!state\.canStartSellPutReport\)/)
  assert.match(apig, /TimeoutSetting:\{Enable:false\}/)
  assert.match(appState, /message\.contains\("301604"\)/)
  assert.match(appState, /message\.contains\("500 internal server error"\)/)
  assert.match(longbridgeHost, /stride\(from: 0, to: symbols\.count, by: 100\)/)
  assert.match(longbridgeHost, /let brokerUnderlying = longbridgeSymbol\(underlying\)/)
  assert.match(longbridgeHost, /\["option", "chain", brokerUnderlying/)
  assert.doesNotMatch(appState, /let providerId = "FUTU"/)
  assert.doesNotMatch(appState, /sellPutPools\["FUTU"\]/)
})

test('Gateway 接受 Swift 省略 nil 可选字段的 SELL PUT observation', () => {
  const parsed = parseObservation({
    requestId: base.requestId,
    rank: 1,
    symbol: 'US.NVDA',
    displayName: 'NVIDIA',
    country: 'United States',
    capturedAt: base.capturedAt,
    currentPrice: 180,
    change30dPercent: 4.5,
    option: {
      code: base.option!.code,
      expiryDate: base.option!.expiryDate,
      strikePrice: 160,
      bid: 2.8,
      ask: 3.2,
      contractMultiplier: 100,
    },
    dataGaps: ['IV Rank 不可用'],
  })
  assert.ok(parsed)
  assert.equal(parsed.ivRank, null)
  assert.equal(parsed.nextEarningsDate, null)
  assert.deepEqual(parsed.sevenDayNews, [])
  assert.equal(parsed.option?.delta, null)
  assert.equal(parsed.option?.openInterest, null)

  const unavailable = parseObservation({
    requestId: base.requestId,
    rank: 1,
    symbol: 'US.NVDA',
    displayName: 'NVIDIA',
    country: 'United States',
    capturedAt: base.capturedAt,
    dataGaps: ['OpenD 不可用'],
  })
  assert.ok(unavailable)
  assert.equal(unavailable.currentPrice, null)
  assert.equal(unavailable.option, null)
})
