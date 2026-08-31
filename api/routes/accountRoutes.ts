import { Router } from 'express'
import type { AccountDashboardResponse } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'

const router = Router()

async function loadDashboard(): Promise<AccountDashboardResponse> {
  const bridge = await runPythonBridge<AccountDashboardResponse>('futu_account.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
  })

  if (!bridge.ok || !bridge.data) {
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
        warnings: [`Account bridge failed: ${bridge.error ?? 'unknown error'}`],
      },
      trading: {
        environment: 'UNKNOWN',
        liveTradingEnabled: false,
        requiresConfirmation: true,
        warning: 'Account data unavailable; live trading is disabled.',
      },
      missingCapabilities: [`Account bridge failed: ${bridge.error ?? 'unknown error'}`],
    }
  }

  return bridge.data
}

router.get('/dashboard', async (_req, res, next) => {
  try {
    res.json(await loadDashboard())
  } catch (error) {
    next(error)
  }
})

router.get('/summary', async (_req, res, next) => {
  try {
    const dashboard = await loadDashboard()
    res.json(dashboard.summary)
  } catch (error) {
    next(error)
  }
})

router.get('/positions', async (_req, res, next) => {
  try {
    const dashboard = await loadDashboard()
    res.json(dashboard.positions)
  } catch (error) {
    next(error)
  }
})

export default router

