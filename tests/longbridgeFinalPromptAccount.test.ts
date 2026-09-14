import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveAccountDashboardResponse } from '../shared/types'

const mocks = vi.hoisted(() => ({
  loadAccount: vi.fn(),
}))

vi.mock('../api/longbridge/longbridgeAdapter', () => ({
  loadLongbridgeLiveAccountDashboard: mocks.loadAccount,
  loadLongbridgeSourceStatus: vi.fn(),
}))
vi.mock('longbridge', () => ({
  Market: { US: 'US', HK: 'HK' },
  Period: { Min_1: 'Min_1', Min_30: 'Min_30' },
  AdjustType: { NoAdjust: 'NoAdjust' },
  TradeSessions: { All: 'All' },
}))

import {
  loadLongbridgeFinalPromptAccount,
  longbridgePromptAccountFailure,
} from '../api/longbridge/longbridgeLiveTradingEngine'

function account(overrides: Partial<LiveAccountDashboardResponse> = {}): LiveAccountDashboardResponse {
  return {
    ok: true,
    selectedAccountId: 'longbridge-real',
    summary: {
      accountId: 'longbridge-real',
      currency: 'USD',
      tradingCurrency: 'USD',
      totalAssets: '$10,000.00',
      totalAssetsInTradingCurrency: '$10,000.00',
      cash: '$5,000.00',
      availableFunds: '$5,000.00',
      buyingPower: '$20,000.00',
      financingRiskLevel: 0,
      financingOpeningRestricted: false,
      initialMargin: '$0.00',
      maintenanceMargin: '$0.00',
      marginCall: '$0.00',
      source: { timestamp: new Date().toISOString() },
    },
    positions: [],
    risk: {
      concentrationRisk: 'test',
      largestPosition: 'none',
      cashRatio: '100%',
      top30Overlap: 'test',
      warnings: [],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: 'test',
    },
    missingCapabilities: [],
    warnings: [],
    ...overrides,
  }
}

describe('Longbridge final prompt account', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ['TSLA', 'USD'],
    ['07747', 'HKD'],
  ])('在 %s 入模前强制刷新 %s 账户', async (symbol, currency) => {
    const current = account()
    mocks.loadAccount.mockResolvedValueOnce(current)

    await expect(loadLongbridgeFinalPromptAccount(symbol)).resolves.toBe(current)
    expect(mocks.loadAccount).toHaveBeenCalledWith(currency, { force: true })
  })

  it('账户失败或融资风险未知时跳过模型', () => {
    expect(longbridgePromptAccountFailure(account({ ok: false })))
      .toContain('快照读取失败')

    const unknown = account()
    unknown.summary.financingRiskLevel = undefined
    expect(longbridgePromptAccountFailure(unknown))
      .toContain('融资风险等级不可用')

    expect(longbridgePromptAccountFailure(account())).toBeUndefined()
  })
})
