import { createPrivateKey, randomUUID, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { calculateEnvelopeContentHash } from '../dist/packages/domain/src/contextEnvelope.js'
import { signAccessToken } from '../dist/packages/auth/src/accessToken.js'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const databaseUrl = process.env.CHANGFU_DATABASE_URL
  ?? `postgresql://postgres:@/financial?host=${root}/.data/cloud-pg/pgdata`
const gatewayUrl = process.env.CHANGFU_GATEWAY_URL ?? 'http://127.0.0.1:4310'
const minutes = Number(process.argv.find(value => value.startsWith('--minutes='))?.split('=')[1] ?? 30)
const intervalSeconds = Number(
  process.argv.find(value => value.startsWith('--interval-seconds='))?.split('=')[1] ?? 120,
)
const symbols = ['US.MU', 'US.NVDA', 'US.SNDK']
const keychainService = 'com.changfu.desktop'
const pool = new Pool({ connectionString: databaseUrl, application_name: 'provider-pool-loop' })

function keychain(account) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', keychainService, '-a', account, '-w'],
      { encoding: 'utf8', timeout: 30_000 },
    )
    if (result.status === 0) return result.stdout.trim()
  }
  throw new Error(`KEYCHAIN_READ_FAILED:${account}`)
}

function runHost(executable, input, timeout = 120_000) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(executable, ['snapshot'], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status === 0) return JSON.parse(result.stdout)
    if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000)
  }
  throw new Error(`BROKER_SNAPSHOT_FAILED:${executable.split('/').at(-1)}`)
}

function providerSnapshot(provider, providerSymbols) {
  const appBin = `${root}/changfu-desktop/macos/build/长富.app/Contents/MacOS`
  if (provider === 'FUTU') {
    return runHost(`${appBin}/ChangFuBrokerHost`, { symbols: providerSymbols })
  }
  return runHost(`${appBin}/ChangFuLongbridgeHost`, {
    ...longbridgeCredentials,
    symbols: providerSymbols,
  })
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function privateKey() {
  const raw = Buffer.from(keychain('device-signing-key'), 'hex')
  if (raw.length !== 32) throw new Error('DEVICE_KEY_INVALID')
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      raw,
    ]),
    format: 'der',
    type: 'pkcs8',
  })
}

async function accessToken() {
  if (currentAccessToken && currentAccessExpiresAt > Date.now() + 60_000) {
    return currentAccessToken
  }
  const signed = signAccessToken({
    userId: '1',
    deviceId,
    privateKeyPem: accessPrivateKeyPem,
    keyId: 'changfu-local-v1',
    issuer: 'changfu-gateway',
    audience: 'changfu-desktop',
    ttlSeconds: 60 * 60,
  })
  currentAccessToken = signed.token
  currentAccessExpiresAt = signed.expiresAt.getTime()
  return currentAccessToken
}

function buildDecisionContext(snapshot, requestedSymbols, sourceAt, riskPolicyId) {
  const quotes = snapshot.quotes.filter(item => requestedSymbols.includes(item.symbol))
  const bars = snapshot.minuteBars.filter(item => requestedSymbols.includes(item.symbol))
  const evidenceCatalog = [
    {
      id: 'ACCOUNT_SNAPSHOT',
      kind: 'ACCOUNT',
      summary: `账户权益 ${snapshot.account.totalAssets} ${snapshot.account.currency}`,
      sourceAt,
    },
    {
      id: 'ORDER_SCOPE',
      kind: 'ORDER',
      summary: `当前未终态订单 ${snapshot.openOrders.length} 笔`,
      sourceAt,
    },
  ]
  const trendContext = []
  const gapCatalog = []
  const dataWindow = []
  for (const symbol of requestedSymbols) {
    const quote = quotes.find(item => item.symbol === symbol)
    const symbolBars = bars.filter(item => item.symbol === symbol)
      .sort((left, right) => String(left.time).localeCompare(String(right.time)))
    if (quote) {
      evidenceCatalog.push({
        id: `QUOTE_${symbol.replaceAll('.', '_')}`,
        kind: 'QUOTE',
        summary: `${symbol} 最新价 ${quote.lastPrice}，昨收 ${quote.previousClose ?? '未知'}`,
        sourceAt,
      })
    } else {
      gapCatalog.push({
        code: 'QUOTE_MISSING',
        severity: 'BLOCKING',
        summary: `${symbol} 缺少关键报价`,
        sourceSupport: 'provider',
      })
    }
    if (symbolBars.length > 0) {
      const first = Number(symbolBars[0].close)
      const last = Number(symbolBars.at(-1).close)
      const change = first === 0 ? 0 : ((last - first) / first) * 100
      evidenceCatalog.push({
        id: `TREND_${symbol.replaceAll('.', '_')}`,
        kind: 'TREND',
        summary: `${symbol} 1 分钟线 ${symbolBars.length} 根，窗口涨跌 ${change.toFixed(3)}%`,
        sourceAt,
      })
      trendContext.push({
        symbol,
        barCount: symbolBars.length,
        firstClose: String(first),
        lastClose: String(last),
        windowChangePercent: change.toFixed(3),
      })
    } else {
      gapCatalog.push({
        code: 'TREND_MISSING',
        severity: 'BLOCKING',
        summary: `${symbol} 没有分钟线`,
        sourceSupport: 'provider',
      })
    }
    dataWindow.push({
      symbol,
      minuteBars: { requested: 60, available: symbolBars.length },
      tickerPoints: {
        requested: 50,
        available: snapshot.tickerPoints.filter(item => item.symbol === symbol).length,
      },
      orderBookDepth: {
        requested: 5,
        available: snapshot.orderBooks.find(item => item.symbol === symbol)?.bids?.length ?? 0,
      },
    })
  }
  return {
    strategyRequirements: {
      requiredContext: ['ACCOUNT', 'POSITION', 'QUOTE', 'MINUTE_TREND', 'ORDER_SCOPE'],
      optionalContext: ['NEWS', 'FILINGS', 'EARNINGS', 'ORDER_BOOK', 'TICKER'],
    },
    evidenceCatalog,
    trendContext,
    positionExposure: requestedSymbols.map(symbol => ({
      symbol,
      classification: 'DIRECT_STOCK_OR_ETF',
      quantity: String(snapshot.positions
        .filter(item => item.symbol === symbol)
        .reduce((sum, item) => sum + Number(item.quantity), 0)),
      availableToClose: null,
      known: true,
    })),
    accountRisk: {
      status: 'ACCOUNT_SNAPSHOT_AVAILABLE',
      riskPolicyId,
      equity: String(snapshot.account.totalAssets),
      cash: String(snapshot.account.cash),
      buyingPower: String(snapshot.account.buyingPower),
      currency: snapshot.account.currency,
      maxPerTradeLoss: null,
      availablePortfolioRisk: null,
    },
    ordersKnowledge: {
      status: 'KNOWN',
      openOrderCount: snapshot.openOrders.length,
      scope: 'BROKER_OPEN_ORDERS',
    },
    dataWindow,
    extendedSession: quotes.map(item => ({
      symbol: item.symbol,
      marketState: item.marketState ?? snapshot.market.state,
      preMarketPrice: item.preMarketPrice ?? null,
      afterHoursPrice: item.afterHoursPrice ?? null,
      overnightPrice: item.overnightPrice ?? null,
      sourceAt,
    })),
    gapCatalog,
    temporalBoundary: {
      capturedAt: sourceAt,
      sourceValidUntil: new Date(Date.parse(sourceAt) + 300_000).toISOString(),
      marketState: snapshot.market.state,
      nextSessionOpen: 'NOT_YET_OCCURRED',
      futureDataPolicy: '未来开盘价和跳空结果不得列为采集失败',
    },
    outputContract: {
      version: 'model-result-v1',
      evidenceIdPolicy: 'CATALOG_ONLY',
      holdRequiresEvidence: true,
      gapSeverityPolicy: 'ONLY_BLOCKING_FORCES_HOLD',
      allowedActions: ['BUY', 'SELL', 'HOLD'],
    },
  }
}

function envelope(
  provider,
  state,
  snapshot,
  requestedSymbols,
  sequence,
  signingKey,
  deviceId,
) {
  const now = new Date()
  const sourceAt = now.toISOString()
  const filteredQuotes = snapshot.quotes.filter(item => requestedSymbols.includes(item.symbol))
  const filteredBars = snapshot.minuteBars.filter(item => requestedSymbols.includes(item.symbol))
  const unsigned = {
    schemaVersion: '2.0',
    requestId: randomUUID(),
    deviceId,
    brokerConnectionId: state.broker_connection_id,
    provider,
    purpose: 'SINGLE_DECISION',
    capturedAt: sourceAt,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence,
    account: {
      accountIdHash: 'integration-redacted',
      broker: provider,
      environment: snapshot.account.environment,
      totalAssets: { value: String(snapshot.account.totalAssets), currency: snapshot.account.currency },
      cash: { value: String(snapshot.account.cash), currency: snapshot.account.currency },
      buyingPower: { value: String(snapshot.account.buyingPower), currency: snapshot.account.currency },
    },
    positions: snapshot.positions,
    marketSessions: [{ market: snapshot.market.name, state: snapshot.market.state }],
    quotes: filteredQuotes,
    minuteBars: filteredBars,
    tickerPoints: snapshot.tickerPoints.filter(item => requestedSymbols.includes(item.symbol)),
    orderBooks: snapshot.orderBooks.filter(item => requestedSymbols.includes(item.symbol)),
    openOrders: snapshot.openOrders,
    recentDeals: snapshot.recentDeals,
    research: {
      entitlementStatus: 'active',
      planName: '旗舰版',
      poolLimit: Math.max(100, requestedSymbols.length),
      poolSymbols: requestedSymbols,
      conversationSymbols: requestedSymbols,
    },
    decisionContext: buildDecisionContext(
      snapshot,
      requestedSymbols,
      sourceAt,
      state.config.riskPolicyId,
    ),
    capabilities: [],
    researchPoolVersion: Number(state.pool_version),
    tradingConfigVersion: Number(state.config_version),
    catalogVersion: state.catalog_version,
    tradingSessionId: null,
    requestedSymbols,
    clientPolicyVersion: 'provider-loop-integration-v1',
    dataGaps: [],
  }
  const contentHash = calculateEnvelopeContentHash(unsigned)
  const deviceSignature = sign(null, Buffer.from(contentHash, 'hex'), signingKey)
    .toString('base64url')
  return { ...unsigned, contentHash, deviceSignature }
}

async function providerState(provider) {
  const state = await pool.query(
    `SELECT c.broker_connection_id, t.version AS config_version, t.catalog_version,
            t.config, p.version AS pool_version
       FROM changfu.broker_connections c
       JOIN changfu.trading_configs t
         ON t.broker_connection_id = c.broker_connection_id AND t.user_id = c.user_id
       JOIN changfu.provider_research_pools p
         ON p.user_id = c.user_id AND p.provider_id = c.broker
      WHERE c.user_id = 1 AND c.broker = $1 AND c.status = 'ACTIVE'`,
    [provider],
  )
  if (!state.rows[0]) throw new Error(`PROVIDER_STATE_MISSING:${provider}`)
  const items = await pool.query(
    `SELECT provider_symbol, canonical_symbol
       FROM changfu.provider_research_pool_items
      WHERE user_id = 1 AND provider_id = $1 AND status = 'ACTIVE'
        AND canonical_symbol = ANY($2::text[])
      ORDER BY canonical_symbol`,
    [provider, symbols],
  )
  if (items.rows.length !== symbols.length) throw new Error(`PROVIDER_POOL_INCOMPLETE:${provider}`)
  return { ...state.rows[0], items: items.rows }
}

async function runModel(provider, state, snapshot, symbol, sequence, signingKey, deviceId, token) {
  const context = envelope(
    provider,
    state,
    snapshot,
    [symbol],
    sequence,
    signingKey,
    deviceId,
  )
  const response = await fetch(`${gatewayUrl}/v1/model/runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ context, userMessage: null, modelRoute: 'OFFICIAL' }),
    signal: AbortSignal.timeout(240_000),
  })
  const text = await response.text()
  const events = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const failure = events.find(item => item.type === 'error')
  const result = events.findLast(item => item.type === 'result')?.result
  if (!response.ok || failure || !result) {
    throw new Error(`${provider}_MODEL_FAILED:${failure?.error?.code ?? response.status}`)
  }
  return {
    provider,
    requestId: context.requestId,
    requestedSymbols: context.requestedSymbols,
    status: result.status,
    responseType: result.responseType,
    signal: result.signal ?? null,
  }
}

async function audit(requestIds) {
  const result = await pool.query(
    `SELECT r.request_id, c.broker AS provider, r.requested_symbols, r.status,
            r.error_code, count(s.signal_id)::int AS signal_count,
            coalesce(
              json_agg(json_build_object('symbol', s.symbol, 'action', s.action)
                ORDER BY s.symbol) FILTER (WHERE s.signal_id IS NOT NULL),
              '[]'::json
            ) AS signals
       FROM changfu.model_runs r
       JOIN changfu.broker_connections c ON c.broker_connection_id = r.broker_connection_id
       LEFT JOIN changfu.signals s ON s.request_id = r.request_id
      WHERE r.request_id = ANY($1::uuid[])
      GROUP BY r.request_id, c.broker, r.requested_symbols, r.status, r.error_code
      ORDER BY min(r.started_at)`,
    [requestIds],
  )
  return result.rows
}

const startedAt = Date.now()
const deadline = startedAt + minutes * 60_000
let currentAccessToken = null
let currentAccessExpiresAt = 0
const longbridgeCredentials = JSON.parse(keychain('longbridge-legacy-credentials'))
const deviceId = keychain('device-id')
const accessPrivateKeyPem = readFileSync(`${root}/.data/changfu-backend/access-private.pem`, 'utf8')
const signingKey = privateKey()
const states = Object.fromEntries(await Promise.all(
  ['FUTU', 'LONGBRIDGE'].map(async provider => [provider, await providerState(provider)]),
))
let round = 0
let sequence = Math.floor(Date.now() / 1000)
const requestIds = []

console.log(JSON.stringify({
  type: 'started',
  startedAt: new Date(startedAt).toISOString(),
  deadline: new Date(deadline).toISOString(),
  intervalSeconds,
  providers: Object.fromEntries(Object.entries(states).map(([provider, state]) => [
    provider,
    {
      poolVersion: Number(state.pool_version),
      symbols: state.items.map(item => item.canonical_symbol),
    },
  ])),
}))

try {
  while (Date.now() < deadline || round === 0) {
    round += 1
    const roundStartedAt = Date.now()
    const token = await accessToken()
    const results = []
    const runProvider = async ([provider, state]) => {
      try {
        const snapshot = providerSnapshot(
          provider,
          state.items.map(item => item.provider_symbol),
        )
        let nextIndex = 0
        const concurrency = state.items.length
        const workers = Array.from({ length: concurrency }, async () => {
          while (nextIndex < state.items.length) {
            const item = state.items[nextIndex++]
            try {
              const result = await runModel(
                provider,
                state,
                snapshot,
                item.canonical_symbol,
                sequence++,
                signingKey,
                deviceId,
                token,
              )
              results.push(result)
              requestIds.push(result.requestId)
            } catch (error) {
              results.push({
                provider,
                symbol: item.canonical_symbol,
                status: 'FAILED',
                error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
              })
            }
          }
        })
        await Promise.all(workers)
      } catch (error) {
        results.push({
          provider,
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
        })
      }
    }
    await Promise.all(Object.entries(states).map(runProvider))
    const roundAudit = await audit(results.flatMap(item => item.requestId ? [item.requestId] : []))
    if (roundAudit.some(item =>
      item.requested_symbols.length !== 1 || item.signal_count !== 1
    )) throw new Error('INDEPENDENT_SIGNAL_AUDIT_FAILED')
    console.log(JSON.stringify({
      type: 'round',
      round,
      occurredAt: new Date().toISOString(),
      results,
      audit: roundAudit,
    }))
    const nextAt = roundStartedAt + intervalSeconds * 1_000
    if (nextAt < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, nextAt - Date.now())))
    } else {
      break
    }
  }
  console.log(JSON.stringify({
    type: 'completed',
    finishedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    rounds: round,
    requests: requestIds.length,
    audit: await audit(requestIds),
  }))
} finally {
  await pool.end()
}
