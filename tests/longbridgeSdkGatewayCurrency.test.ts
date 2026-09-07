import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const accountBalance = vi.fn()
  const stockPositions = vi.fn()
  const todayOrders = vi.fn()
  const quote = vi.fn()
  return {
    accountBalance,
    stockPositions,
    todayOrders,
    quote,
    tradeNew: vi.fn(() => ({ accountBalance, stockPositions, todayOrders })),
    quoteNew: vi.fn(() => ({ quote })),
  }
})

vi.mock('longbridge', () => ({
  Config: { fromApikey: vi.fn(() => ({})) },
  QuoteContext: { new: mocks.quoteNew },
  TradeContext: { new: mocks.tradeNew },
}))

import {
  loadLongbridgeSdkAccountSnapshot,
  resetLongbridgeSdkGatewayForTests,
} from '../api/longbridge/longbridgeSdkGateway.js'

describe('Longbridge SDK 账户资产币种', () => {
  const originalEnv = {
    appKey: process.env.LONGBRIDGE_APP_KEY,
    appSecret: process.env.LONGBRIDGE_APP_SECRET,
    accessToken: process.env.LONGBRIDGE_ACCESS_TOKEN,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetLongbridgeSdkGatewayForTests()
    process.env.LONGBRIDGE_APP_KEY = 'test-key'
    process.env.LONGBRIDGE_APP_SECRET = 'test-secret'
    process.env.LONGBRIDGE_ACCESS_TOKEN = 'test-token'
    mocks.accountBalance.mockResolvedValue([{
      currency: 'USD',
      netAssets: '1291.52',
      totalCash: '1291.52',
      buyPower: '1291.52',
      riskLevel: 0,
      cashInfos: [{
        currency: 'USD',
        availableCash: '1291.52',
        frozenCash: '0.00',
        settlingCash: '0.00',
        withdrawCash: '1291.52',
      }],
    }])
    mocks.stockPositions.mockResolvedValue({ channels: [] })
    mocks.todayOrders.mockResolvedValue([])
  })

  afterEach(() => {
    if (originalEnv.appKey === undefined) delete process.env.LONGBRIDGE_APP_KEY
    else process.env.LONGBRIDGE_APP_KEY = originalEnv.appKey
    if (originalEnv.appSecret === undefined) delete process.env.LONGBRIDGE_APP_SECRET
    else process.env.LONGBRIDGE_APP_SECRET = originalEnv.appSecret
    if (originalEnv.accessToken === undefined) delete process.env.LONGBRIDGE_ACCESS_TOKEN
    else process.env.LONGBRIDGE_ACCESS_TOKEN = originalEnv.accessToken
  })

  it('显式按美元口径读取账户资产', async () => {
    const snapshot = await loadLongbridgeSdkAccountSnapshot({ force: true })

    expect(mocks.accountBalance).toHaveBeenCalledWith('USD')
    expect(snapshot.assets).toMatchObject({
      currency: 'USD',
      net_assets: '1291.52',
      total_cash: '1291.52',
      available_cash: '1291.52',
      buy_power: '1291.52',
    })
  })
})
