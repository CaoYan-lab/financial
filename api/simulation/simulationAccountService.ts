import type { Position, SimulationAccountDashboardResponse } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'

export async function loadSimulationAccountDashboard(accountId?: string): Promise<SimulationAccountDashboardResponse> {
  const bridge = await runPythonBridge<SimulationAccountDashboardResponse>('futu_sim_account.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    accountId,
  })

  if (bridge.ok && bridge.data) return withDerivedPnL(bridge.data)

  const timestamp = new Date().toISOString()
  return {
    ok: false,
    accounts: [],
    selectedAccountId: 'unavailable',
    summary: {
      accountId: 'unavailable',
      currency: 'USD',
      totalAssets: 'unavailable',
      cash: 'unavailable',
      availableFunds: 'unavailable',
      buyingPower: 'unavailable',
      dailyPnL: 'unavailable',
      totalPnL: 'unavailable',
      source: {
        source: 'Futu OpenD Simulated Account',
        accessedAt: timestamp,
        timestamp,
      },
    },
    positions: [],
    trading: {
      environment: 'SIMULATE',
      liveTradingEnabled: false,
      requiresConfirmation: false,
      warning: 'Simulated account data unavailable; simulated trading is disabled.',
    },
    warnings: [`Simulated account bridge failed: ${bridge.error ?? 'unknown error'}`],
  }
}

function withDerivedPnL(data: SimulationAccountDashboardResponse): SimulationAccountDashboardResponse {
  const dailyPnL = sumMoney(data.positions.map((position) => position.todayPnL))
  const totalPnL = sumMoney(data.positions.map((position) => position.unrealizedPnL))
  return {
    ...data,
    summary: {
      ...data.summary,
      dailyPnL: data.summary.dailyPnL === 'unavailable' && dailyPnL !== undefined ? formatMoney(dailyPnL) : data.summary.dailyPnL,
      totalPnL: data.summary.totalPnL === 'unavailable' && totalPnL !== undefined ? formatMoney(totalPnL) : data.summary.totalPnL,
    },
  }
}

function sumMoney(values: Array<Position['todayPnL']>): number | undefined {
  const parsed = values.map(parseMoney).filter((value): value is number => value !== undefined)
  if (!parsed.length) return undefined
  return parsed.reduce((sum, value) => sum + value, 0)
}

function parseMoney(value: string | undefined): number | undefined {
  if (!value || value === 'unavailable') return undefined
  const numeric = Number(value.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(numeric) ? numeric : undefined
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
