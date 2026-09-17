import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const accountBalance = vi.fn()
  const stockPositions = vi.fn()
  const todayOrders = vi.fn()
  const request = vi.fn()
  const quote = vi.fn()
  return {
    accountBalance,
    stockPositions,
    todayOrders,
    request,
    quote,
    tradeNew: vi.fn(() => ({ accountBalance, stockPositions, todayOrders })),
    quoteNew: vi.fn(() => ({ quote })),
    httpNew: vi.fn(() => ({ request })),
  }
})

vi.mock('longbridge', () => ({
  Config: { fromApikey: vi.fn(() => ({})) },
  HttpClient: { fromApikey: mocks.httpNew },
  QuoteContext: { new: mocks.quoteNew },
  TradeContext: { new: mocks.tradeNew },
}))

import {
  longbridgeHttpUrl,
  loadLongbridgeSdkAccountSnapshot,
  resetLongbridgeSdkGatewayForTests,
} from '../api/longbridge/longbridgeSdkGateway.js'

describe('Longbridge SDK 账户资产币种', () => {
  const originalEnv = {
    appKey: process.env.LONGBRIDGE_APP_KEY,
    appSecret: process.env.LONGBRIDGE_APP_SECRET,
    accessToken: process.env.LONGBRIDGE_ACCESS_TOKEN,
    httpUrl: process.env.LONGBRIDGE_HTTP_URL,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetLongbridgeSdkGatewayForTests()
    process.env.LONGBRIDGE_APP_KEY = 'test-key'
    process.env.LONGBRIDGE_APP_SECRET = 'test-secret'
    process.env.LONGBRIDGE_ACCESS_TOKEN = 'test-token'
    delete process.env.LONGBRIDGE_HTTP_URL
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
    mocks.request.mockImplementation(async (_method: string, path: string) => ({
      currency: 'USD',
      sum_profit: '-42.18',
      updated_at: '2026-09-16T16:00:00Z',
      ...(path.includes('start=1788220800')
        ? { start_date: '2026-09-01' }
        : {}),
    }))
  })

  afterEach(() => {
    if (originalEnv.appKey === undefined) delete process.env.LONGBRIDGE_APP_KEY
    else process.env.LONGBRIDGE_APP_KEY = originalEnv.appKey
    if (originalEnv.appSecret === undefined) delete process.env.LONGBRIDGE_APP_SECRET
    else process.env.LONGBRIDGE_APP_SECRET = originalEnv.appSecret
    if (originalEnv.accessToken === undefined) delete process.env.LONGBRIDGE_ACCESS_TOKEN
    else process.env.LONGBRIDGE_ACCESS_TOKEN = originalEnv.accessToken
    if (originalEnv.httpUrl === undefined) delete process.env.LONGBRIDGE_HTTP_URL
    else process.env.LONGBRIDGE_HTTP_URL = originalEnv.httpUrl
  })

  it('中国大陆部署默认使用可连通的 Longbridge HTTP 接入点', () => {
    expect(longbridgeHttpUrl()).toBe('https://openapi.longbridge.cn')
    process.env.LONGBRIDGE_HTTP_URL = 'https://custom.example.com'
    expect(longbridgeHttpUrl()).toBe('https://custom.example.com')
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
      account_today_pnl: -42.18,
      account_today_pnl_currency: 'USD',
      account_total_pnl: -42.18,
      account_total_pnl_currency: 'USD',
      account_total_pnl_start_date: '2026-09-01',
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

  it('空头持仓的负可用数量归一化为正的可平股数', async () => {
    mocks.stockPositions.mockResolvedValue({
      channels: [{
        positions: [{
          symbol: 'GOOG.US',
          symbolName: 'Alphabet',
          quantity: '-1',
          availableQuantity: '-1',
          costPrice: '342.00',
          currency: 'USD',
        }],
      }],
    })
    mocks.quote.mockResolvedValue([{
      symbol: 'GOOG.US',
      lastDone: '341.43',
      prevClose: '340.00',
    }])

    const snapshot = await loadLongbridgeSdkAccountSnapshot({ force: true })

    expect(snapshot.positions[0]).toMatchObject({
      symbol: 'GOOG.US',
      quantity: '-1',
      availableToClose: 1,
    })
  })

  it('行情缺少昨收价时不伪造持仓今日盈亏', async () => {
    mocks.stockPositions.mockResolvedValue({
      channels: [{
        positions: [{
          symbol: 'AAPL.US',
          symbolName: 'Apple',
          quantity: '2',
          availableQuantity: '2',
          costPrice: '90.00',
          currency: 'USD',
        }],
      }],
    })
    mocks.quote.mockResolvedValue([{
      symbol: 'AAPL.US',
      lastDone: '105.00',
    }])

    const snapshot = await loadLongbridgeSdkAccountSnapshot({ force: true })

    expect(snapshot.positions[0]).toMatchObject({
      currentPrice: '105.00',
      todayPnL: 'unavailable',
    })
  })

  it('盘前持仓使用 SDK 扩展时段现价计算市值和浮盈亏', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T10:30:00Z'))
    try {
      mocks.stockPositions.mockResolvedValue({
        channels: [{
          positions: [{
            symbol: 'TQQQ.US',
            symbolName: 'ProShares UltraPro QQQ',
            quantity: '13',
            availableQuantity: '13',
            costPrice: '70.16',
            currency: 'USD',
          }],
        }],
      })
      mocks.quote.mockResolvedValue([{
        symbol: 'TQQQ.US',
        lastDone: '67.93',
        prevClose: '67.93',
        preMarketQuote: {
          lastDone: '70.15',
          timestamp: new Date('2026-09-17T10:30:00Z'),
        },
      }])

      const snapshotPromise = loadLongbridgeSdkAccountSnapshot({ force: true })
      await vi.runAllTimersAsync()
      const snapshot = await snapshotPromise

      expect(snapshot.positions[0]).toMatchObject({
        currentPrice: '70.15',
        marketValue: '911.95',
        todayPnL: '28.86',
        unrealizedPnL: '-0.13',
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
