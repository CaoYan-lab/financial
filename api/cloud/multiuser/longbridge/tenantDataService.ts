import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  LongbridgeBrokerOrdersResponse,
  LongbridgeLiveTradingDashboardResponse,
  LongbridgeSourceStatusResponse,
  LongbridgeWorkbenchDashboardResponse,
} from '../../../../shared/longbridgeTypes.js'
import type { SimulationHistoryPage } from '../../../../shared/types.js'
import { getLlmRuntimeConfig } from '../../../simulation/llmRuntimeConfigService.js'
import { llmSimulationTickers } from '../../../simulation/simulationUniverse.js'
import { buildLiveEvaluationStatus } from '../../../trading/liveEvaluationStatusService.js'
import { buildLongbridgeOrderChildEnvironment } from '../../../longbridge/longbridgeOrderProxy.js'
import { query, queryOne } from '../../db/pgClient.js'
import type { BrokerConnection, LongbridgeCredentialBundle } from '../types.js'
import { credentialsForConnection } from './connectionStore.js'
import { contextsForConnection } from './contextRegistry.js'
import { loadTenantMarketStates } from './tenantMarketSessionService.js'

const execFileAsync = promisify(execFile)
const ORDERS_CHILD_PATH = resolve(process.cwd(), 'api', 'longbridge', 'longbridgeSdkOrdersChild.mjs')
const DETAIL_CHILD_PATH = resolve(process.cwd(), 'api', 'longbridge', 'longbridgeSdkOrderDetailChild.mjs')
const CANCEL_CHILD_PATH = resolve(process.cwd(), 'api', 'longbridge', 'longbridgeSdkOrderCancelChild.mjs')
const SUBMIT_CHILD_PATH = resolve(process.cwd(), 'api', 'longbridge', 'longbridgeSdkOrderChild.mjs')

function text(value: unknown): string {
  if (value === null || value === undefined) return '0'
  return String(value)
}

function number(value: unknown): number {
  const parsed = Number(text(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function usd(value: unknown): string {
  return `$${number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function currencyMoney(value: unknown, currency: 'USD' | 'HKD'): string {
  return `${currency === 'HKD' ? 'HK$' : '$'}${number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export async function verifyTenantCredentials(
  bundle: LongbridgeCredentialBundle,
): Promise<{ accountFingerprint: string }> {
  const { Config, TradeContext } = await import('longbridge')
  const config = Config.fromApikey(bundle.appKey, bundle.appSecret, bundle.accessToken, {
    enablePrintQuotePackages: false,
  })
  const trade = TradeContext.new(config)
  const balances = await trade.accountBalance()
  const positions = await trade.stockPositions()
  const channels = positions.channels.map((channel) => channel.accountChannel).sort().join(',')
  return {
    accountFingerprint: `${channels || 'default'}:${balances.length}`,
  }
}

export async function loadTenantWorkbench(
  connection: BrokerConnection,
  currency: 'USD' | 'HKD' = 'USD',
): Promise<LongbridgeWorkbenchDashboardResponse> {
  const { quote, trade } = contextsForConnection(connection)
  const balances = await trade.accountBalance(currency)
  const positionResponse = await trade.stockPositions()
  const balance = balances.find((item) => item.currency === currency) ?? balances[0]
  const cashInfo = balance?.cashInfos?.find((item) => item.currency === currency)
    ?? balance?.cashInfos?.[0]
  const rawPositions = positionResponse.channels.flatMap((channel) => channel.positions)
  const quotes = rawPositions.length
    ? await quote.quote(rawPositions.map((position) => position.symbol))
    : []
  const quoteBySymbol = new Map(quotes.map((item) => [item.symbol, item]))
  const positions = rawPositions.map((position) => {
    const currentPrice = number(quoteBySymbol.get(position.symbol)?.lastDone)
    const quantity = number(position.quantity)
    const averageCost = number(position.costPrice)
    const marketValue = currentPrice * quantity
    return {
      symbol: position.symbol,
      name: position.symbolName,
      quantity: text(position.quantity),
      marketValue: usd(marketValue),
      averageCost: usd(averageCost),
      currentPrice: usd(currentPrice),
      todayPnL: '暂无',
      unrealizedPnL: usd((currentPrice - averageCost) * quantity),
      currency: position.currency,
    }
  })
  const now = new Date().toISOString()
  const sourceStatus: LongbridgeSourceStatusResponse = {
    ok: true,
    runtimeProvider: 'sdk',
    sdkAvailable: true,
    cliAvailable: false,
    cliPath: '',
    cliVersion: '',
    authStatus: 'authenticated',
    authDetail: '当前用户独立 SDK 凭据',
    accountReadAvailable: true,
    positionReadAvailable: true,
    orderReadAvailable: true,
    skillsInstalled: true,
    installedSkills: [],
    marketDataAvailable: true,
    accountDataAvailable: true,
    tradingAvailable: false,
    mcpFallbackConfigured: false,
    lastCheckedAt: now,
    missingCapabilities: [],
  }
  return {
    ok: true,
    sourceStatus,
    accountMetrics: [
      { label: '账户净资产', value: currencyMoney(balance?.netAssets, currency), helper: balance?.currency ?? currency },
      { label: '账户现金', value: currencyMoney(balance?.totalCash, currency), helper: balance?.currency ?? currency },
      { label: '现金可用', value: currencyMoney(cashInfo?.availableCash ?? balance?.totalCash, currency), helper: balance?.currency ?? currency },
      { label: '最大购买力', value: currencyMoney(balance?.buyPower, currency), helper: balance?.currency ?? currency },
      { label: '风险等级', value: String(balance?.riskLevel ?? '未知'), helper: '当前绑定账户' },
    ],
    positions,
    riskCards: [
      { label: '持仓数量', value: String(positions.length), helper: '当前账户持仓标的数' },
      { label: '最大融资额度', value: currencyMoney(balance?.maxFinanceAmount, currency), helper: balance?.currency ?? currency },
      { label: '剩余融资额度', value: currencyMoney(balance?.remainingFinanceAmount, currency), helper: balance?.currency ?? currency },
      { label: '初始保证金', value: currencyMoney(balance?.initMargin, currency), helper: balance?.currency ?? currency },
      { label: '维持保证金', value: currencyMoney(balance?.maintenanceMargin, currency), helper: balance?.currency ?? currency },
      { label: '追加保证金', value: currencyMoney(balance?.marginCall, currency), helper: balance?.currency ?? currency },
    ],
    dataPanels: [
      { label: '数据路径', value: '独立 SDK', helper: '按当前用户绑定创建 Context' },
      { label: '账户读取', value: '正常', helper: '与其他用户隔离' },
    ],
    researchPanels: [
      { label: '研究数据', value: '共享只读', helper: '不包含其他账户数据' },
    ],
    tradingPanels: [
      { label: '实盘模式', value: '影子模式', helper: '逐户验收后方可开启' },
    ],
    warnings: [],
    updatedAt: now,
  }
}

export async function loadTenantLiveDashboard(
  userId: string,
  bindingId: string,
  connection?: BrokerConnection,
): Promise<LongbridgeLiveTradingDashboardResponse> {
  const state = await queryOne<{
    desired: string
    mode: string
    live_trading_enabled: boolean
    auto_submit_enabled: boolean
    auto_cancel_enabled: boolean
    settings: Record<string, unknown>
  }>(
    `SELECT desired, mode, live_trading_enabled, auto_submit_enabled, auto_cancel_enabled, settings
     FROM multiuser.longbridge_engine_state
     WHERE user_id = $1 AND binding_id = $2`,
    [userId, bindingId],
  )
  const [signals, pendingOrders, candidates] = await Promise.all([
    latestTenantEvents<Record<string, unknown>>(userId, bindingId, 'signals'),
    latestTenantEvents<Record<string, unknown>>(userId, bindingId, 'pending-orders', 'id'),
    latestTenantEvents<Record<string, unknown>>(userId, bindingId, 'candidate-pool', 'candidateId'),
  ])
  const activePendingOrders = pendingOrders.filter((item) =>
    item.status === 'PENDING_CONFIRMATION' || item.status === 'CONFIRMED_SUBMITTING')
  const visibleSignals = signals.filter((item) => !isMarketSessionPseudoSignal(item))
  const now = new Date().toISOString()
  const universe = llmSimulationTickers()
  const symbols = universe.map(normalizeLongbridgeSymbol)
  const marketStates = connection
    ? await loadTenantMarketStates(connection, symbols)
    : new Map(symbols.map((symbol) => [symbol, 'UNAVAILABLE']))
  const running = state?.desired === 'running'
  return {
    ok: true,
    engine: {
      running,
      mode: 'REAL',
      accountId: bindingId,
      startedAt: '',
      lastRunAt: '',
      nextRunAt: '',
      universe,
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      runIntervalMs: 60_000,
      pendingOrderCount: activePendingOrders.length,
      submittedOrderCount: pendingOrders.filter((item) => item.status === 'SUBMITTED').length,
      signalCount: visibleSignals.length,
      lastError: '',
    },
    evaluationStatus: buildLiveEvaluationStatus({
      running,
      items: symbols.map((symbol) => ({
        ticker: symbol,
        marketState: marketStates.get(symbol),
        updatedAt: now,
      })),
      disableUsOvernightLlm: getLlmRuntimeConfig().config.disableUsOvernightLlm,
      updatedAt: now,
    }),
    liveTradingEnabled: state?.mode === 'live' && state.live_trading_enabled,
    autoSubmitEnabled: state?.auto_submit_enabled === true,
    autoCancelEnabled: state?.auto_cancel_enabled === true,
    blockOpeningWhenCashNegative:
      state?.settings?.blockOpeningWhenCashNegative !== false,
    marketableLimitTimeoutSeconds: 90,
    limitTimeoutSeconds: 600,
    brokerSyncIntervalSeconds: 30,
    modelReviewIntervalSeconds: 60,
    signals: visibleSignals as LongbridgeLiveTradingDashboardResponse['signals'],
    pendingOrders: activePendingOrders as LongbridgeLiveTradingDashboardResponse['pendingOrders'],
    candidatePool: {
      executionMode: 'candidate_pool',
      enabled: true,
      promptVersion: 'live_portfolio_candidate_review_v1',
      promptLabel: '多用户独立组合裁决',
      promptSummary: '单票评估、候选池和组合裁决均按当前用户绑定隔离。',
      promptConfigVersion: 1,
      promptRawYaml: '',
      presetId: 'tenant-isolated',
      presetLabel: '租户隔离',
      timingPresets: [],
      decisionRuleCount: 1,
      requiredJsonKeys: [],
      candidates: candidates as LongbridgeLiveTradingDashboardResponse['candidatePool']['candidates'],
    },
    warnings: ['当前用户处于独立影子模式，完成逐户验收前不会提交真实订单。'],
    updatedAt: now,
  }
}

async function latestTenantEvents<T extends Record<string, unknown>>(
  userId: string,
  bindingId: string,
  kind: string,
  identityKey = 'id',
): Promise<T[]> {
  const rows = await query<{ payload: T }>(
    `SELECT payload
     FROM multiuser.longbridge_events
     WHERE user_id = $1 AND binding_id = $2 AND kind = $3
     ORDER BY created_at DESC, id DESC
     LIMIT 500`,
    [userId, bindingId, kind],
  )
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    const identity = String(row.payload[identityKey] ?? '')
    if (!identity || seen.has(identity)) return []
    seen.add(identity)
    return [row.payload]
  })
}

export async function listTenantHistory<T>(
  userId: string,
  bindingId: string,
  kind: string,
  page: number,
  pageSize: number,
  filters: Record<string, string> = {},
): Promise<SimulationHistoryPage<T>> {
  const rows = await query<{ payload: T }>(
    `SELECT payload
     FROM multiuser.longbridge_events
     WHERE user_id = $1 AND binding_id = $2 AND kind = $3
     ORDER BY created_at DESC, id DESC
     LIMIT 2000`,
    [userId, bindingId, kind],
  )
  const currentItems = dedupeLifecycle(rows.map((row) => row.payload), kind)
    .filter((item) => kind !== 'signals' || !isMarketSessionPseudoSignal(item))
    .filter((item) => tenantHistoryMatches(item, kind, filters))
  const total = currentItems.length
  const offset = (page - 1) * pageSize
  return {
    items: currentItems.slice(offset, offset + pageSize),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

function normalizeLongbridgeSymbol(ticker: string): string {
  const normalized = ticker.trim().toUpperCase()
  if (/^\d{1,5}$/.test(normalized)) return `${normalized.replace(/^0+/, '')}.HK`
  if (normalized.includes('.')) return normalized
  return `${normalized}.US`
}

function isMarketSessionPseudoSignal(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const signal = item as Record<string, unknown>
  if (String(signal.lifecycleStatus ?? '').toUpperCase() !== 'SKIPPED') return false
  const marketState = String(signal.marketState ?? '').toUpperCase()
  if (!['CLOSED', 'REST', 'NONE', 'UNAVAILABLE', 'OVERNIGHT', 'NIGHT', 'NIGHT_OPEN'].includes(marketState)) return false
  const reason = String(signal.lifecycleReason ?? signal.reason ?? '')
  return reason.includes('LLM 请求已关闭')
    || reason.includes('周末、节假日或休市状态')
}

function dedupeLifecycle<T>(items: T[], kind: string): T[] {
  if (kind === 'signals') return items
  const key = kind === 'candidate-pool' ? 'candidateId' : 'id'
  const seen = new Set<string>()
  return items.filter((item) => {
    const identity = String((item as Record<string, unknown>)[key] ?? '')
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function tenantHistoryMatches(item: unknown, kind: string, filters: Record<string, string>): boolean {
  const record = item as Record<string, unknown>
  if (kind === 'pending-orders') {
    const intent = (record.intent ?? {}) as Record<string, unknown>
    if (filters.status && filters.status !== 'ALL' && record.status !== filters.status) return false
    if (filters.ticker && filters.ticker !== 'ALL' && String(intent.ticker ?? '').toUpperCase() !== filters.ticker) return false
    if (filters.side && filters.side !== 'ALL' && intent.side !== filters.side) return false
  }
  if (kind === 'signals') {
    if (filters.ticker && filters.ticker !== 'ALL' && String(record.ticker ?? '').toUpperCase() !== filters.ticker) return false
    if (filters.direction && filters.direction !== 'ALL' && record.side !== filters.direction) return false
    if (filters.lifecycleStatus && filters.lifecycleStatus !== 'ALL' && record.lifecycleStatus !== filters.lifecycleStatus) return false
  }
  if (kind === 'candidate-pool' && filters.statusGroup && filters.statusGroup !== 'ALL') {
    const active = ['ACTIVE', 'WATCH', 'PROMOTED']
    if (filters.statusGroup === 'ACTIVE' && !active.includes(String(record.status ?? ''))) return false
    if (filters.statusGroup !== 'ACTIVE' && record.status !== filters.statusGroup) return false
  }
  return true
}

function childEnvironment(connection: BrokerConnection, allowSubmit = false): NodeJS.ProcessEnv {
  const credentials = credentialsForConnection(connection)
  const env = buildLongbridgeOrderChildEnvironment({
    credentials,
    allowSubmit,
  })
  if (!env) throw new Error('云端长桥订单代理未配置')
  return env
}

export async function runTenantOrderChild(
  connection: BrokerConnection,
  action: 'orders' | 'detail' | 'cancel' | 'submit',
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const script = {
    orders: ORDERS_CHILD_PATH,
    detail: DETAIL_CHILD_PATH,
    cancel: CANCEL_CHILD_PATH,
    submit: SUBMIT_CHILD_PATH,
  }[action]
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  try {
    const result = await execFileAsync(process.execPath, [script, encoded], {
      timeout: 35_000,
      maxBuffer: 2 * 1024 * 1024,
      env: childEnvironment(connection, action === 'submit'),
    })
    return JSON.parse(result.stdout.trim()) as Record<string, unknown>
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    if (failure.stdout?.trim()) {
      try {
        return JSON.parse(failure.stdout.trim()) as Record<string, unknown>
      } catch {
        // Fall through to normalized failure.
      }
    }
    return { ok: false, error: failure.stderr?.trim() || failure.message || '长桥订单子进程失败' }
  }
}

export async function listTenantBrokerOrders(
  connection: BrokerConnection,
  input: Record<string, unknown>,
): Promise<LongbridgeBrokerOrdersResponse> {
  return runTenantOrderChild(connection, 'orders', input) as Promise<LongbridgeBrokerOrdersResponse>
}

export async function setTenantDesiredState(
  userId: string,
  bindingId: string,
  desired: 'running' | 'stopped',
): Promise<void> {
  await query(
    `INSERT INTO multiuser.longbridge_engine_state (user_id, binding_id, desired)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, binding_id) DO UPDATE
       SET desired = EXCLUDED.desired, updated_at = now()`,
    [userId, bindingId, desired],
  )
}
