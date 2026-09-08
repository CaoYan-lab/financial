import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConnection } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  accountBalance: vi.fn(),
  stockPositions: vi.fn(),
  quote: vi.fn(),
}))

vi.mock('../../api/cloud/multiuser/longbridge/contextRegistry.js', () => ({
  contextsForConnection: vi.fn(() => ({
    trade: {
      accountBalance: mocks.accountBalance,
      stockPositions: mocks.stockPositions,
    },
    quote: { quote: mocks.quote },
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
})
