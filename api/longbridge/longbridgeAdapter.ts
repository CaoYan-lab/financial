import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  LongbridgeAuthStatus,
  LongbridgeLiveTradingConfigResponse,
  LongbridgeMetric,
  LongbridgePosition,
  LongbridgeSourceStatusResponse,
  LongbridgeWorkbenchDashboardResponse,
} from '../../shared/longbridgeTypes.js'
import type { LiveAccountDashboardResponse, Position, UpdateLlmRuntimeConfigRequest, UpdateTradeStrategyConfigRequest } from '../../shared/types.js'
import { getLlmRuntimeConfig, updateLlmRuntimeConfig } from '../simulation/llmRuntimeConfigService.js'
import { getActiveLivePortfolioReviewPrompt, getTradeStrategyRuntimeConfig, updateTradeStrategyRuntimeConfig } from '../trade_strategy/tradeStrategyConfigService.js'
import { parseJsonOutput, resolveLongbridgeCliPath, runLongbridgeCli } from './longbridgeCli.js'
import {
  loadLongbridgeSdkAccountSnapshot,
  longbridgeSdkCredentialsConfigured,
  probeLongbridgeSdk,
  type LongbridgeAccountCurrency,
} from './longbridgeSdkGateway.js'

const LONGBRIDGE_SKILLS = [
  'longbridge',
  'longbridge-market-data',
  'longbridge-technical',
  'longbridge-quant',
  'longbridge-portfolio',
  'longbridge-research',
  'longbridge-earnings',
  'longbridge-fundamentals',
  'longbridge-content',
  'longbridge-derivatives',
  'longbridge-watchlist',
  'longbridge-intel',
  'longbridge-value-investing',
]

type AuthPayload = {
  token?: {
    status?: string
    logged_in_at?: string | null
    path?: string
  }
}

export async function loadLongbridgeSourceStatus(): Promise<LongbridgeSourceStatusResponse> {
  if (longbridgeSdkCredentialsConfigured()) {
    return loadLongbridgeSdkSourceStatus()
  }

  const checkedAt = new Date().toISOString()
  const cliPath = resolveLongbridgeCliPath()
  const envTokenConfigured = Boolean(process.env.LONGBRIDGE_ACCESS_TOKEN && process.env.LONGBRIDGE_APP_KEY && process.env.LONGBRIDGE_APP_SECRET)
  const version = await runLongbridgeCli(['--version'], { timeoutMs: 5_000 })
  const auth = envTokenConfigured
    ? { ok: true, stdout: '', stderr: '' }
    : await runLongbridgeCli(['auth', 'status', '--format', 'json'], { timeoutMs: 8_000 })
  const authPayload = parseJsonOutput<AuthPayload>(auth)
  const authStatus = envTokenConfigured ? 'authenticated' : normalizeAuthStatus(authPayload?.token?.status, auth)
  const installedSkills = installedLongbridgeSkills()
  const missingCapabilities: string[] = []

  if (!version.ok) missingCapabilities.push(`Longbridge CLI 不可用：${version.stderr || version.error || cliPath}`)
  if (authStatus !== 'authenticated') missingCapabilities.push('Longbridge OAuth 未登录，行情、账户、持仓和订单能力暂不可用。')
  if (installedSkills.length !== LONGBRIDGE_SKILLS.length) {
    missingCapabilities.push(`Longbridge Skill 安装不完整：${installedSkills.length}/${LONGBRIDGE_SKILLS.length}`)
  }

  return {
    ok: version.ok,
    cliAvailable: version.ok,
    cliPath,
    cliVersion: version.stdout || 'unavailable',
    authStatus,
    authDetail: envTokenConfigured ? 'env: LONGBRIDGE_ACCESS_TOKEN' : authPayload?.token?.path ? `token: ${authPayload.token.path}` : auth.stderr || auth.error || 'unavailable',
    skillsInstalled: installedSkills.length === LONGBRIDGE_SKILLS.length,
    installedSkills,
    marketDataAvailable: version.ok && authStatus === 'authenticated',
    accountDataAvailable: version.ok && authStatus === 'authenticated',
    tradingAvailable: version.ok && authStatus === 'authenticated' && process.env.LONGBRIDGE_LIVE_TRADING_ENABLED === 'true',
    mcpFallbackConfigured: Boolean(process.env.LONGBRIDGE_MCP_URL || process.env.LONGBRIDGE_MCP_SERVER),
    lastCheckedAt: checkedAt,
    missingCapabilities,
  }
}

export async function loadLongbridgeWorkbenchDashboard(): Promise<LongbridgeWorkbenchDashboardResponse> {
  const sourceStatus = await loadLongbridgeSourceStatus()
  const warnings = [...sourceStatus.missingCapabilities]
  const positions = sourceStatus.accountDataAvailable ? await loadPositions(warnings) : []

  return {
    ok: sourceStatus.ok,
    sourceStatus,
    accountMetrics: sourceStatus.accountDataAvailable ? await loadAccountMetrics(warnings) : unavailableAccountMetrics(),
    positions,
    riskCards: riskCards(positions, sourceStatus),
    dataPanels: dataPanels(sourceStatus),
    researchPanels: researchPanels(sourceStatus),
    tradingPanels: tradingPanels(sourceStatus),
    warnings,
    updatedAt: new Date().toISOString(),
  }
}

export async function loadLongbridgeLiveAccountDashboard(
  currency: LongbridgeAccountCurrency = 'USD',
): Promise<LiveAccountDashboardResponse> {
  const sourceStatus = await loadLongbridgeSourceStatus()
  const warnings = [...sourceStatus.missingCapabilities]
  const assets = sourceStatus.accountDataAvailable ? await loadAssetRecord(warnings, currency) : {}
  const positions = sourceStatus.accountDataAvailable ? await loadPositions(warnings, currency) : []
  const now = new Date().toISOString()
  const availableCash = assetValue(assets, 'available_cash') ?? firstCashInfoValue(assets, 'available_cash') ?? assetValue(assets, 'total_cash')
  const totalCash = assetValue(assets, 'total_cash') ?? firstCashInfoValue(assets, 'available_cash')
  const buyPower = assetValue(assets, 'buy_power')
  const netAssets = assetValue(assets, 'net_assets')
  if (sourceStatus.accountDataAvailable && buyPower === undefined) warnings.push('Longbridge assets 未返回可解析 buy_power，LLM 将无法获得最大购买力。')
  return {
    ok: sourceStatus.accountDataAvailable,
    selectedAccountId: 'longbridge-real',
    summary: {
      accountId: 'longbridge-real',
      currency,
      totalAssets: formatCurrency(netAssets, currency),
      cash: formatCurrency(totalCash, currency),
      availableFunds: formatCurrency(availableCash, currency),
      buyingPower: formatCurrency(buyPower, currency),
      tradingCurrency: currency,
      totalAssetsInTradingCurrency: formatCurrency(netAssets, currency),
      cashInTradingCurrency: formatCurrency(totalCash, currency),
      availableFundsInTradingCurrency: formatCurrency(availableCash, currency),
      buyingPowerInTradingCurrency: formatCurrency(buyPower, currency),
      dailyPnL: formatCurrency(assets.today_pnl, currency),
      totalPnL: formatCurrency(assets.total_pnl, currency),
      source: {
        source: longbridgeSdkCredentialsConfigured()
          ? 'Longbridge SDK account'
          : 'Longbridge CLI assets',
        accessedAt: now,
        timestamp: now,
      },
    },
    positions: positions.map(toSharedPosition),
    risk: {
      concentrationRisk: positions.length ? '按长桥持仓计算' : '当前无持仓',
      largestPosition: positions[0]?.symbol ?? '无',
      cashRatio: 'unavailable',
      top30Overlap: 'unavailable',
      warnings,
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: sourceStatus.tradingAvailable,
      requiresConfirmation: true,
      warning: sourceStatus.tradingAvailable ? '长桥真实提交门禁已开启，仍需要人工确认。' : '长桥真实提交门禁关闭，本轮只允许 dry-run。',
    },
    missingCapabilities: sourceStatus.missingCapabilities,
    warnings,
  }
}

export function loadLongbridgeLiveTradingConfig(): LongbridgeLiveTradingConfigResponse {
  return {
    ok: true,
    llmRuntimeConfig: getLlmRuntimeConfig().config,
    modelOptions: getLlmRuntimeConfig().modelOptions,
    tradeStrategyConfig: getTradeStrategyRuntimeConfig('live'),
    candidatePoolConfig: buildLongbridgeCandidatePoolConfig(),
    warnings: getLlmRuntimeConfig().warnings,
  }
}

export function updateLongbridgeLlmConfig(input: UpdateLlmRuntimeConfigRequest): LongbridgeLiveTradingConfigResponse {
  updateLlmRuntimeConfig(input)
  return loadLongbridgeLiveTradingConfig()
}

export function updateLongbridgeTradeStrategyConfig(input: UpdateTradeStrategyConfigRequest): LongbridgeLiveTradingConfigResponse {
  updateTradeStrategyRuntimeConfig('live', input)
  return loadLongbridgeLiveTradingConfig()
}

async function loadAccountMetrics(warnings: string[]): Promise<LongbridgeMetric[]> {
  const parsed = await loadAssetRecord(warnings)
  const availableCash = assetValue(parsed, 'available_cash') ?? firstCashInfoValue(parsed, 'available_cash') ?? assetValue(parsed, 'total_cash')
  return [
    metric('美金总览', formatUsd(assetValue(parsed, 'net_assets')), '账户净资产，USD'),
    metric('现金可用', formatUsd(availableCash), '可用现金，USD'),
    metric('最大购买力', formatUsd(assetValue(parsed, 'buy_power')), '最大购买力，USD'),
    metric('风险等级', formatUnknown(parsed.risk_level), '账户风险等级'),
  ]
}

async function loadAssetRecord(
  warnings: string[],
  currency: LongbridgeAccountCurrency = 'USD',
): Promise<Record<string, unknown>> {
  if (longbridgeSdkCredentialsConfigured()) {
    try {
      return (await loadLongbridgeSdkAccountSnapshot({ currency })).assets
    } catch (error) {
      warnings.push(`Longbridge SDK 账户资产读取失败：${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }
  if (currency !== 'USD') {
    warnings.push(`Longbridge CLI 无法保证 ${currency} 账户口径，已按不可用处理。`)
    return {}
  }

  const assets = await runLongbridgeCli(['assets', '--format', 'json'])
  if (!assets.ok) {
    warnings.push(`Longbridge assets 读取失败：${assets.stderr || assets.error || 'unknown error'}`)
    return {}
  }
  const payload = parseJsonOutput<unknown>(assets)
  return normalizeAssetPayload(payload)
}

async function loadPositions(
  warnings: string[],
  currency: LongbridgeAccountCurrency = 'USD',
): Promise<LongbridgePosition[]> {
  if (longbridgeSdkCredentialsConfigured()) {
    try {
      return (await loadLongbridgeSdkAccountSnapshot({ currency })).positions
    } catch (error) {
      warnings.push(`Longbridge SDK 持仓读取失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  const result = await runLongbridgeCli(['positions', '--format', 'json'])
  if (!result.ok) {
    warnings.push(`Longbridge positions 读取失败：${result.stderr || result.error || 'unknown error'}`)
    return []
  }
  const parsed = parseJsonOutput<unknown[]>(result)
  if (!Array.isArray(parsed)) return []
  return parsed.map((item) => normalizePosition(item as Record<string, unknown>))
}

function normalizePosition(item: Record<string, unknown>): LongbridgePosition {
  return {
    symbol: formatUnknown(item.symbol ?? item.stock_code ?? item.code),
    name: formatUnknown(item.name ?? item.stock_name),
    quantity: formatUnknown(item.quantity ?? item.qty),
    marketValue: formatUnknown(item.market_value),
    averageCost: formatUnknown(item.average_cost ?? item.cost_price),
    currentPrice: formatUnknown(item.current_price ?? item.last_price),
    todayPnL: formatUnknown(item.today_pnl ?? item.intraday_pnl),
    unrealizedPnL: formatUnknown(item.unrealized_pnl ?? item.pl),
    currency: formatUnknown(item.currency),
  }
}

function toSharedPosition(position: LongbridgePosition): Position {
  const symbol = position.symbol.toUpperCase()
  const ticker = symbol.split('.')[0] || symbol
  return {
    code: symbol,
    ticker,
    name: position.name,
    assetType: 'STOCK',
    underlyingTicker: ticker,
    quantity: position.quantity,
    marketValue: position.marketValue,
    averageCost: position.averageCost,
    currentPrice: position.currentPrice,
    todayPnL: position.todayPnL,
    unrealizedPnL: position.unrealizedPnL,
    pnlRatio: 'unavailable',
    positionRatio: 'unavailable',
    currency: position.currency || 'USD',
  }
}

function normalizeAssetPayload(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) return (payload[0] as Record<string, unknown> | undefined) ?? {}
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>
  return {}
}

function unavailableAccountMetrics(): LongbridgeMetric[] {
  return [
    metric('美金总览', '等待授权', '需要 Longbridge OAuth'),
    metric('现金可用', '等待授权', '需要 Quote permission'),
    metric('最大购买力', '等待授权', '需要账户资产接口'),
    metric('风险等级', '等待授权', '需要 Longbridge assets'),
  ]
}

function riskCards(positions: LongbridgePosition[], status: LongbridgeSourceStatusResponse): LongbridgeMetric[] {
  return [
    metric('平台隔离', 'Longbridge 独立', '不读取 Futu 账户、订单和持久化表'),
    metric('持仓数量', String(positions.length), status.accountDataAvailable ? '长桥持仓接口' : '等待授权后加载'),
    metric('交易门禁', status.tradingAvailable ? '已开启' : '未开启', 'LONGBRIDGE_LIVE_TRADING_ENABLED'),
  ]
}

function dataPanels(status: LongbridgeSourceStatusResponse): LongbridgeMetric[] {
  if (status.runtimeProvider === 'sdk') {
    return [
      metric('接入方式', status.sdkAvailable ? 'Node SDK' : '不可用', '常驻 worker 内无头鉴权'),
      metric('授权状态', authLabel(status.authStatus), status.authDetail),
      metric('行情权限', status.quotePackages?.length ? status.quotePackages.join(' / ') : '未探测到', '由长桥账户行情套餐决定'),
      metric('令牌有效期', status.tokenExpiresAt ? `${Math.max(0, Math.floor(status.tokenRemainingDays ?? 0))} 天` : '未知', status.tokenExpiresAt ?? '未提供到期时间'),
    ]
  }

  return [
    metric('命令行状态', status.cliAvailable ? '可用' : '不可用', status.cliVersion),
    metric('OAuth 状态', authLabel(status.authStatus), status.authDetail),
    metric('技能装载', `${status.installedSkills.length}/${LONGBRIDGE_SKILLS.length}`, '已装载到 Trae CN'),
    metric('后备通道', status.mcpFallbackConfigured ? '已配置' : '未配置', '命令行优先，MCP 后备'),
  ]
}

async function loadLongbridgeSdkSourceStatus(): Promise<LongbridgeSourceStatusResponse> {
  const probe = await probeLongbridgeSdk()
  const missingCapabilities = [...probe.errors]
  const tokenTooCloseToExpiry =
    probe.tokenRemainingDays !== undefined && probe.tokenRemainingDays < 1
  const cloudMode = process.env.CLOUD_MODE === '1'
  const orderProxyReady = Boolean(process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim())
  const orderNetworkReady = !cloudMode || orderProxyReady
  if (tokenTooCloseToExpiry && !missingCapabilities.some((item) => item.includes('Access Token'))) {
    missingCapabilities.push('长桥 Access Token 剩余有效期不足 24 小时，真实交易已熔断。')
  }
  if (!probe.orderReadAvailable) {
    missingCapabilities.push('长桥订单读取权限不可用。')
  }
  if (cloudMode && !orderProxyReady) {
    missingCapabilities.push('云端长桥真实订单专用代理尚未配置。')
  }

  return {
    ok: probe.ok,
    runtimeProvider: 'sdk',
    sdkAvailable: probe.sdkAvailable,
    cliAvailable: false,
    cliPath: 'not-required',
    cliVersion: 'not-required',
    authStatus: probe.ok ? 'authenticated' : 'not_authenticated',
    authDetail: probe.ok ? '长桥 SDK API Key 已鉴权' : '长桥 SDK 鉴权失败',
    tokenExpiresAt: probe.tokenExpiresAt,
    tokenRemainingDays: probe.tokenRemainingDays,
    quotePackages: probe.quotePackages,
    accountReadAvailable: probe.accountDataAvailable,
    positionReadAvailable: probe.accountDataAvailable,
    orderReadAvailable: probe.orderReadAvailable,
    skillsInstalled: true,
    installedSkills: [],
    marketDataAvailable: probe.marketDataAvailable,
    accountDataAvailable: probe.accountDataAvailable,
    tradingAvailable:
      probe.accountDataAvailable
      && probe.orderReadAvailable
      && !tokenTooCloseToExpiry
      && orderNetworkReady
      && process.env.LONGBRIDGE_LIVE_TRADING_ENABLED === 'true',
    mcpFallbackConfigured: false,
    lastCheckedAt: probe.checkedAt,
    missingCapabilities,
  }
}

function researchPanels(status: LongbridgeSourceStatusResponse): LongbridgeMetric[] {
  return [
    metric('行情输入', status.marketDataAvailable ? '真实数据' : '等待授权', '报价、K 线、盘口、分时'),
    metric('研究输入', status.marketDataAvailable ? '可用' : '等待授权', '新闻、公告、基本面、机构研究'),
    metric('模型数据源', '长桥数据适配器', '禁止混用 Futu 实时缓存'),
  ]
}

function tradingPanels(status: LongbridgeSourceStatusResponse): LongbridgeMetric[] {
  return [
    metric('量化引擎', '待接入', '长桥独立引擎'),
    metric('待确认订单', '0', '长桥独立队列'),
    metric('真实提交', status.tradingAvailable ? '门禁已开启' : '门禁关闭', '确认后才允许提交订单'),
  ]
}

function metric(label: string, value: string, helper: string): LongbridgeMetric {
  return { label, value, helper }
}

function buildLongbridgeCandidatePoolConfig() {
  const tradeStrategyConfig = getTradeStrategyRuntimeConfig('live')
  const prompt = getActiveLivePortfolioReviewPrompt()
  const presetId = tradeStrategyConfig.selection.portfolioTimingPresetId ?? prompt.defaultPresetId
  const preset = prompt.timingPresets.find((item) => item.id === presetId) ?? prompt.timingPresets[0]
  return {
    executionMode: tradeStrategyConfig.selection.executionMode,
    enabled: tradeStrategyConfig.selection.executionMode === 'candidate_pool',
    promptVersion: prompt.id,
    promptLabel: prompt.label,
    promptSummary: prompt.summary,
    promptConfigVersion: prompt.version,
    promptRawYaml: prompt.rawYaml,
    presetId: preset?.id ?? prompt.defaultPresetId,
    presetLabel: preset?.label ?? 'DeepSeek 平衡版 v1',
    timingPresets: prompt.timingPresets,
    decisionRuleCount: prompt.decisionRules.length,
    requiredJsonKeys: Object.keys(prompt.requiredJson ?? {}),
    candidates: [],
  }
}

function normalizeAuthStatus(status: string | undefined, result: { ok: boolean; stderr: string; error?: string }): LongbridgeAuthStatus {
  if (status === 'ok' || status === 'valid' || status === 'authenticated') return 'authenticated'
  if (status === 'not_found' || status === 'expired' || status === 'invalid') return 'not_authenticated'
  if (!result.ok && /not authenticated|not_found|token/i.test(`${result.stderr} ${result.error ?? ''}`)) return 'not_authenticated'
  return 'unknown'
}

function authLabel(status: LongbridgeAuthStatus): string {
  if (status === 'authenticated') return '已登录'
  if (status === 'not_authenticated') return '未登录'
  return '未知'
}

function installedLongbridgeSkills(): string[] {
  const homes = [os.homedir(), '/Users/bytedance'].filter(Boolean)
  return LONGBRIDGE_SKILLS.filter((skill) =>
    homes.some((home) =>
      [
        path.join(home, '.agents', 'skills', skill, 'SKILL.md'),
        path.join(home, '.trae-cn', 'skills', skill, 'SKILL.md'),
      ].some((candidate) => fs.existsSync(candidate)),
    ),
  )
}

function formatUnknown(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'unavailable'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'unavailable'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function formatUsd(value: unknown): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 'unavailable'
  return `$${numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatCurrency(value: unknown, currency: LongbridgeAccountCurrency): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 'unavailable'
  const prefix = currency === 'HKD' ? 'HK$' : '$'
  return `${prefix}${numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function assetValue(record: Record<string, unknown>, key: string): unknown {
  const value = record[key]
  return value === null || value === undefined || value === '' ? undefined : value
}

function firstCashInfoValue(record: Record<string, unknown>, key: string): unknown {
  const cashInfos = record.cash_infos
  if (!Array.isArray(cashInfos)) return undefined
  const first = cashInfos.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  return first ? assetValue(first, key) : undefined
}
