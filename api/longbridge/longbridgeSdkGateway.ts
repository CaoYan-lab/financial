import { Config, QuoteContext, TradeContext } from 'longbridge'

const SDK_ENV_KEYS = [
  'LONGBRIDGE_APP_KEY',
  'LONGBRIDGE_APP_SECRET',
  'LONGBRIDGE_ACCESS_TOKEN',
] as const
const ACCOUNT_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.LONGBRIDGE_ACCOUNT_CACHE_TTL_MS || 15_000) || 15_000,
)
const AUTH_CACHE_TTL_MS = Math.max(
  15_000,
  Number(process.env.LONGBRIDGE_AUTH_CACHE_TTL_MS || 60_000) || 60_000,
)

type QuoteContextInstance = InstanceType<typeof QuoteContext>
type TradeContextInstance = InstanceType<typeof TradeContext>

export type LongbridgeSdkPosition = {
  symbol: string
  name: string
  quantity: string
  marketValue: string
  averageCost: string
  currentPrice: string
  todayPnL: string
  unrealizedPnL: string
  currency: string
}

export type LongbridgeSdkAccountSnapshot = {
  assets: Record<string, unknown>
  positions: LongbridgeSdkPosition[]
  accountReadAvailable: boolean
  positionReadAvailable: boolean
  orderReadAvailable: boolean
  checkedAt: string
}

export type LongbridgeSdkProbe = {
  ok: boolean
  sdkAvailable: boolean
  marketDataAvailable: boolean
  accountDataAvailable: boolean
  orderReadAvailable: boolean
  quotePackages: string[]
  tokenExpiresAt?: string
  tokenRemainingDays?: number
  checkedAt: string
  errors: string[]
}

let config: Config | undefined
let quoteContext: QuoteContextInstance | undefined
let tradeContext: TradeContextInstance | undefined
let accountCache:
  | { expiresAt: number; value: LongbridgeSdkAccountSnapshot }
  | undefined
let accountInFlight: Promise<LongbridgeSdkAccountSnapshot> | undefined
let probeCache: { expiresAt: number; value: LongbridgeSdkProbe } | undefined
let probeInFlight: Promise<LongbridgeSdkProbe> | undefined

export function longbridgeSdkCredentialsConfigured(): boolean {
  return SDK_ENV_KEYS.every((key) => Boolean(process.env[key]?.trim()))
}

export function longbridgeTokenHealth(now = Date.now()): {
  expiresAt?: string
  remainingDays?: number
  expired: boolean
} {
  const token = process.env.LONGBRIDGE_ACCESS_TOKEN?.trim()
  if (!token) return { expired: true }
  const configuredExpiry = tokenHealthFromTimestamp(
    process.env.LONGBRIDGE_TOKEN_EXPIRES_AT,
    now,
  )
  try {
    const segment = token.split('.')[1]
    if (!segment) return configuredExpiry ?? { expired: false }
    const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      exp?: number
    }
    if (!Number.isFinite(claims.exp)) return configuredExpiry ?? { expired: false }
    const expiresAtMs = Number(claims.exp) * 1_000
    return {
      expiresAt: new Date(expiresAtMs).toISOString(),
      remainingDays: (expiresAtMs - now) / 86_400_000,
      expired: expiresAtMs <= now,
    }
  } catch {
    return configuredExpiry ?? { expired: false }
  }
}

export function getLongbridgeSdkContexts(): {
  config: Config
  quote: QuoteContextInstance
  trade: TradeContextInstance
} {
  const missing = SDK_ENV_KEYS.filter((key) => !process.env[key]?.trim())
  if (missing.length) {
    throw new Error(`长桥 SDK 缺少环境变量：${missing.join(', ')}`)
  }
  if (!config) {
    config = Config.fromApikey(
      process.env.LONGBRIDGE_APP_KEY ?? '',
      process.env.LONGBRIDGE_APP_SECRET ?? '',
      process.env.LONGBRIDGE_ACCESS_TOKEN ?? '',
      { enablePrintQuotePackages: false },
    )
  }
  quoteContext ??= QuoteContext.new(config)
  tradeContext ??= TradeContext.new(config)
  return { config, quote: quoteContext, trade: tradeContext }
}

export async function loadLongbridgeSdkAccountSnapshot(
  options: { force?: boolean } = {},
): Promise<LongbridgeSdkAccountSnapshot> {
  if (!options.force && accountCache && accountCache.expiresAt > Date.now()) {
    return accountCache.value
  }
  if (accountInFlight) return accountInFlight

  accountInFlight = collectAccountSnapshot().then((value) => {
    accountCache = { expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS, value }
    return value
  }).finally(() => {
    accountInFlight = undefined
  })
  return accountInFlight
}

export async function probeLongbridgeSdk(
  options: { force?: boolean } = {},
): Promise<LongbridgeSdkProbe> {
  if (!options.force && probeCache && probeCache.expiresAt > Date.now()) {
    return probeCache.value
  }
  if (probeInFlight) return probeInFlight

  probeInFlight = collectProbe().then((value) => {
    probeCache = { expiresAt: Date.now() + AUTH_CACHE_TTL_MS, value }
    return value
  }).finally(() => {
    probeInFlight = undefined
  })
  return probeInFlight
}

async function collectAccountSnapshot(): Promise<LongbridgeSdkAccountSnapshot> {
  const { quote, trade } = getLongbridgeSdkContexts()
  const [balances, positionsResponse, orders] = await Promise.all([
    trade.accountBalance('USD'),
    trade.stockPositions(),
    trade.todayOrders(),
  ])
  const balance = balances.find((item) => item.currency === 'USD') ?? balances[0]
  const positions = positionsResponse.channels.flatMap((channel) =>
    channel.positions.map((position) => ({
      symbol: position.symbol,
      name: position.symbolName,
      quantity: decimalText(position.quantity),
      averageCost: decimalText(position.costPrice),
      currency: position.currency,
    })),
  )
  const quotes = positions.length
    ? await quote.quote(positions.map((position) => position.symbol))
    : []
  const quoteBySymbol = new Map(quotes.map((item) => [item.symbol, item]))
  const normalizedPositions = positions.map((position) => {
    const current = decimalNumber(quoteBySymbol.get(position.symbol)?.lastDone)
    const previousClose = decimalNumber(quoteBySymbol.get(position.symbol)?.prevClose)
    const quantity = numeric(position.quantity)
    const averageCost = numeric(position.averageCost)
    return {
      ...position,
      currentPrice: finiteText(current),
      marketValue: finiteText(current * quantity),
      todayPnL: finiteText((current - previousClose) * quantity),
      unrealizedPnL: finiteText((current - averageCost) * quantity),
    }
  })
  const cashInfo = balance?.cashInfos.find((item) => item.currency === balance.currency)
    ?? balance?.cashInfos.find((item) => item.currency === 'USD')
    ?? balance?.cashInfos[0]

  return {
    assets: balance
      ? {
          net_assets: decimalText(balance.netAssets),
          total_cash: decimalText(balance.totalCash),
          available_cash: decimalText(cashInfo?.availableCash),
          buy_power: decimalText(balance.buyPower),
          risk_level: balance.riskLevel,
          currency: balance.currency,
          cash_infos: balance.cashInfos.map((item) => ({
            available_cash: decimalText(item.availableCash),
            currency: item.currency,
            frozen_cash: decimalText(item.frozenCash),
            settling_cash: decimalText(item.settlingCash),
            withdraw_cash: decimalText(item.withdrawCash),
          })),
        }
      : {},
    positions: normalizedPositions,
    accountReadAvailable: balances.length > 0,
    positionReadAvailable: Boolean(positionsResponse),
    orderReadAvailable: Array.isArray(orders),
    checkedAt: new Date().toISOString(),
  }
}

async function collectProbe(): Promise<LongbridgeSdkProbe> {
  const checkedAt = new Date().toISOString()
  const token = longbridgeTokenHealth()
  if (!longbridgeSdkCredentialsConfigured()) {
    return {
      ok: false,
      sdkAvailable: false,
      marketDataAvailable: false,
      accountDataAvailable: false,
      orderReadAvailable: false,
      quotePackages: [],
      tokenExpiresAt: token.expiresAt,
      tokenRemainingDays: token.remainingDays,
      checkedAt,
      errors: ['长桥 SDK 凭据未完整配置。'],
    }
  }

  const errors: string[] = []
  let quotePackages: string[] = []
  let marketDataAvailable = false
  let accountDataAvailable = false
  let orderReadAvailable = false
  try {
    const { quote } = getLongbridgeSdkContexts()
    const packages = await quote.quotePackageDetails()
    quotePackages = packages.map((item) => `${item.key}:${item.name}`)
    marketDataAvailable = packages.length > 0
  } catch (error) {
    errors.push(`行情授权探测失败：${errorMessage(error)}`)
  }
  try {
    const account = await loadLongbridgeSdkAccountSnapshot()
    accountDataAvailable =
      account.accountReadAvailable && account.positionReadAvailable
    orderReadAvailable = account.orderReadAvailable
  } catch (error) {
    errors.push(`账户授权探测失败：${errorMessage(error)}`)
  }
  if (token.expired) errors.push('长桥 Access Token 已过期。')

  return {
    ok: marketDataAvailable && accountDataAvailable && !token.expired,
    sdkAvailable: true,
    marketDataAvailable,
    accountDataAvailable,
    orderReadAvailable,
    quotePackages,
    tokenExpiresAt: token.expiresAt,
    tokenRemainingDays: token.remainingDays,
    checkedAt,
    errors,
  }
}

export function resetLongbridgeSdkGatewayForTests(): void {
  config = undefined
  quoteContext = undefined
  tradeContext = undefined
  accountCache = undefined
  accountInFlight = undefined
  probeCache = undefined
  probeInFlight = undefined
}

function decimalText(value: unknown): string {
  if (value === null || value === undefined) return 'unavailable'
  const text = typeof value === 'object' && 'toString' in value
    ? String((value as { toString: () => string }).toString())
    : String(value)
  return text && text !== 'NaN' ? text : 'unavailable'
}

function decimalNumber(value: unknown): number {
  return numeric(decimalText(value))
}

function numeric(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function finiteText(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'unavailable'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tokenHealthFromTimestamp(
  value: string | undefined,
  now: number,
): { expiresAt: string; remainingDays: number; expired: boolean } | undefined {
  if (!value) return undefined
  const expiresAtMs = Date.parse(value)
  if (!Number.isFinite(expiresAtMs)) return undefined
  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    remainingDays: (expiresAtMs - now) / 86_400_000,
    expired: expiresAtMs <= now,
  }
}
