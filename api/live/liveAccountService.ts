import type { AccountDashboardResponse, LiveAccountDashboardResponse, Position } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'

export type LiveAccountDashboardOptions = {
  accountId?: string
  market?: 'US' | 'HK' | 'CN'
  tradingCurrency?: 'USD' | 'HKD' | 'CNY'
}

export async function loadLiveAccountDashboard(accountIdOrOptions?: string | LiveAccountDashboardOptions): Promise<LiveAccountDashboardResponse> {
  const options = typeof accountIdOrOptions === 'string' ? { accountId: accountIdOrOptions } : (accountIdOrOptions ?? {})
  const bridge = await runPythonBridge<AccountDashboardResponse>('futu_account.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    accountId: options.accountId,
    market: options.market ?? 'US',
    tradingCurrency: options.tradingCurrency ?? 'USD',
  })

  if (bridge.ok && bridge.data) return normalizeLiveAccount(bridge.data)

  const timestamp = new Date().toISOString()
  return {
    ok: false,
    summary: {
      accountId: 'unavailable',
      currency: 'USD',
      totalAssets: 'unavailable',
      cash: 'unavailable',
      availableFunds: 'unavailable',
      buyingPower: 'unavailable',
      tradingCurrency: 'USD',
      totalAssetsInTradingCurrency: 'unavailable',
      cashInTradingCurrency: 'unavailable',
      availableFundsInTradingCurrency: 'unavailable',
      buyingPowerInTradingCurrency: 'unavailable',
      dailyPnL: 'unavailable',
      totalPnL: 'unavailable',
      source: {
        source: 'Futu OpenD Account',
        accessedAt: timestamp,
        timestamp,
      },
    },
    positions: [],
    risk: {
      concentrationRisk: 'unavailable',
      largestPosition: 'unavailable',
      cashRatio: 'unavailable',
      top30Overlap: 'unavailable',
      warnings: [],
    },
    trading: {
      environment: 'UNKNOWN',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: 'Account data unavailable; live trading is disabled.',
    },
    missingCapabilities: [`Live account bridge failed: ${bridge.error ?? 'unknown error'}`],
    selectedAccountId: 'unavailable',
    warnings: [`Live account bridge failed: ${bridge.error ?? 'unknown error'}`],
  }
}

function normalizeLiveAccount(data: AccountDashboardResponse): LiveAccountDashboardResponse {
  const selectedAccountId = data.summary.accountId || 'unavailable'
  const dailyPnL = sumMoney(data.positions.map((position) => position.todayPnL))
  const totalPnL = sumMoney(data.positions.map((position) => position.unrealizedPnL))
  const liveTradingEnabled = process.env.LIVE_TRADING_ENABLED === 'true' && process.env.FUTU_LIVE_TRD_ENV === 'REAL'
  const warnings = [...(data.missingCapabilities ?? []), ...(data.risk.warnings ?? [])]
  if (!liveTradingEnabled) warnings.unshift('LIVE_TRADING_ENABLED 或 FUTU_LIVE_TRD_ENV 门禁未开启，确认接口不会提交真实订单。')

  return {
    ...data,
    summary: {
      ...data.summary,
      dailyPnL: data.summary.dailyPnL === 'unavailable' && dailyPnL !== undefined ? formatMoney(dailyPnL) : data.summary.dailyPnL,
      totalPnL: data.summary.totalPnL === 'unavailable' && totalPnL !== undefined ? formatMoney(totalPnL) : data.summary.totalPnL,
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled,
      requiresConfirmation: true,
      warning: liveTradingEnabled ? 'Live trading is enabled but every order still requires manual confirmation.' : 'Live trading is gated; confirmation API will not submit real orders.',
    },
    selectedAccountId,
    warnings,
  }
}

function sumMoney(values: Array<Position['todayPnL']>): number | undefined {
  const parsed = values.map(parseMoney).filter((value): value is number => value !== undefined)
  if (!parsed.length) return undefined
  return parsed.reduce((sum, value) => sum + value, 0)
}

export function parseMoney(value: string | undefined): number | undefined {
  if (!value || value === 'unavailable') return undefined
  const numeric = Number(value.replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(numeric) ? numeric : undefined
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
