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
      riskLevel: 1,
      initMargin: '11996.37',
      maintenanceMargin: '9968.03',
      marginCall: '0.00',
      maxFinanceAmount: '28819.52',
      remainingFinanceAmount: '5925.11',
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
      risk_level: 1,
      init_margin: '11996.37',
      maintenance_margin: '9968.03',
      margin_call: '0.00',
      max_finance_amount: '28819.52',
      remaining_finance_amount: '5925.11',
    })
  })

  it('美元和港币账户快照按币种独立读取和缓存', async () => {
    mocks.accountBalance.mockImplementation(async (currency: string) => [{
      currency,
      netAssets: currency === 'HKD' ? '10126.39' : '1291.52',
      totalCash: currency === 'HKD' ? '10126.39' : '1291.52',
      buyPower: currency === 'HKD' ? '10126.39' : '1291.52',
      riskLevel: 0,
      cashInfos: [],
    }])

    const usd = await loadLongbridgeSdkAccountSnapshot({ currency: 'USD' })
    const hkd = await loadLongbridgeSdkAccountSnapshot({ currency: 'HKD' })
    const cachedHkd = await loadLongbridgeSdkAccountSnapshot({ currency: 'HKD' })

    expect(usd.assets).toMatchObject({ currency: 'USD', buy_power: '1291.52' })
    expect(hkd.assets).toMatchObject({ currency: 'HKD', buy_power: '10126.39' })
    expect(cachedHkd).toBe(hkd)
    expect(mocks.accountBalance).toHaveBeenCalledTimes(2)
  })
})
