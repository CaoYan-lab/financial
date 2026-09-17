import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConnection } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  accountBalance: vi.fn(),
  stockPositions: vi.fn(),
  quote: vi.fn(),
  request: vi.fn(),
}))

vi.mock('../../api/cloud/multiuser/longbridge/contextRegistry.js', () => ({
  contextsForConnection: vi.fn(() => ({
    trade: {
      accountBalance: mocks.accountBalance,
      stockPositions: mocks.stockPositions,
    },
    quote: { quote: mocks.quote },
    pnl: { request: mocks.request },
  })),
}))

vi.mock('../../api/cloud/multiuser/longbridge/connectionStore.js', () => ({
  credentialsForConnection: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { loadTenantWorkbench } from '../../api/cloud/multiuser/longbridge/tenantDataService.js'

function sdkDecimal(value: string) {
  return { toString: () => value }
}

describe('Longbridge 租户账户资产币种', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.accountBalance.mockResolvedValue([{
      currency: 'USD',
      netAssets: '1291.52',
      totalCash: '1291.52',
      buyPower: '1291.52',
      riskLevel: 0,
      initMargin: '0.00',
      maintenanceMargin: '0.00',
      marginCall: '0.00',
    }])
    mocks.stockPositions.mockResolvedValue({ channels: [] })
    mocks.quote.mockResolvedValue([])
    mocks.request.mockImplementation(async (_method: string, path: string) => ({
      currency: 'USD',
      sum_profit: '-42.18',
      updated_at: '2026-09-16T16:00:00Z',
      ...(path.includes('start=1788220800')
        ? { start_date: '2026-09-01' }
        : {}),
    }))
  })

  it('显式请求美元资产并按美元展示', async () => {
    const connection: BrokerConnection = {
      id: 'binding-a',
      userId: 'user-a',
      platform: 'longbridge',
      credentialSource: 'encrypted_bundle',
      status: 'verified',
    }

    const dashboard = await loadTenantWorkbench(connection)

    expect(mocks.accountBalance).toHaveBeenCalledWith('USD')
    expect(dashboard.accountMetrics).toContainEqual({
      label: '账户净资产',
      value: '$1,291.52',
      helper: 'USD',
    })
  })

  it('港股策略可显式请求港币资产并按港币展示', async () => {
    mocks.accountBalance.mockResolvedValueOnce([{
      currency: 'HKD',
      netAssets: '10126.39',
      totalCash: '10126.39',
      buyPower: '10126.39',
      riskLevel: 0,
      initMargin: '0.00',
      maintenanceMargin: '0.00',
      marginCall: '0.00',
    }])
    const connection: BrokerConnection = {
      id: 'binding-a',
      userId: 'user-a',
      platform: 'longbridge',
      credentialSource: 'encrypted_bundle',
      status: 'verified',
    }

    const dashboard = await loadTenantWorkbench(connection, 'HKD')

    expect(mocks.accountBalance).toHaveBeenCalledWith('HKD')
    expect(dashboard.accountMetrics).toContainEqual({
      label: '最大购买力',
      value: 'HK$10,126.39',
      helper: 'HKD',
    })
  })

  it('账户今日盈亏使用 Longbridge 账户级期间盈亏，不汇总当前持仓涨跌', async () => {
    mocks.stockPositions.mockResolvedValueOnce({
      channels: [{
        positions: [{
          symbol: 'AAPL.US',
          symbolName: 'Apple',
          quantity: '2',
          availableQuantity: '2',
          costPrice: '90',
          currency: 'USD',
        }],
      }],
    })
    mocks.quote.mockResolvedValueOnce([{
      symbol: 'AAPL.US',
      lastDone: '105',
      prevClose: '100',
    }])
    const connection: BrokerConnection = {
      id: 'binding-a',
      userId: 'user-a',
      platform: 'longbridge',
      credentialSource: 'encrypted_bundle',
      status: 'verified',
    }

    const dashboard = await loadTenantWorkbench(connection)

    expect(dashboard.positions[0].todayPnL).toBe('$10.00')
    expect(dashboard.accountMetrics).toContainEqual({
      label: '今日盈亏',
      value: '$-42.18',
      helper: '长桥账户级当日盈亏，包含已实现盈亏与费用',
    })
    expect(dashboard.accountMetrics).toContainEqual({
      label: '账户总盈亏',
      value: '$-42.18',
      helper: '2026-09-01 至今的长桥账户级累计盈亏',
    })
  })

  it('账户级盈亏失败时显示不可用，不以持仓涨跌冒充', async () => {
    mocks.request.mockRejectedValueOnce(new Error('upstream unavailable'))
    mocks.stockPositions.mockResolvedValueOnce({
      channels: [{
        positions: [{
          symbol: 'AAPL.US',
          symbolName: 'Apple',
          quantity: '2',
          availableQuantity: '2',
          costPrice: '90',
          currency: 'USD',
        }],
      }],
    })
    mocks.quote.mockResolvedValueOnce([{
      symbol: 'AAPL.US',
      lastDone: '105',
      prevClose: '100',
    }])

    const dashboard = await loadTenantWorkbench({
      id: 'binding-a',
      userId: 'user-a',
      platform: 'longbridge',
      credentialSource: 'encrypted_bundle',
      status: 'verified',
    })

    expect(dashboard.positions[0].todayPnL).toBe('$10.00')
    expect(dashboard.accountMetrics).toContainEqual({
      label: '今日盈亏',
      value: '不可用',
      helper: '长桥账户级当日盈亏，包含已实现盈亏与费用',
    })
    expect(dashboard.warnings).toContain(
      'Longbridge 账户级今日盈亏暂不可用，未使用当前持仓涨跌替代。',
    )
  })

  it('租户盘前持仓使用 SDK 扩展时段现价', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T10:30:00Z'))
    try {
      mocks.stockPositions.mockResolvedValueOnce({
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
      mocks.quote.mockResolvedValueOnce([{
        symbol: 'TQQQ.US',
        lastDone: sdkDecimal('67.93'),
        prevClose: sdkDecimal('67.93'),
        preMarketQuote: {
          lastDone: sdkDecimal('70.15'),
          timestamp: new Date('2026-09-17T10:30:00Z'),
        },
      }])

      const dashboard = await loadTenantWorkbench({
        id: 'binding-a',
        userId: 'user-a',
        platform: 'longbridge',
        credentialSource: 'encrypted_bundle',
        status: 'verified',
      })

      expect(dashboard.positions[0]).toMatchObject({
        currentPrice: '$70.15',
        marketValue: '$911.95',
        todayPnL: '$28.86',
        unrealizedPnL: '$-0.13',
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
