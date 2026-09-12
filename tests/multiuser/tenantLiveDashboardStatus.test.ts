import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConnection } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  marketStates: vi.fn(),
  tickers: vi.fn(() => ['AAPL', '07747']),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantMarketSessionService.js', () => ({
  loadTenantMarketStates: mocks.marketStates,
}))
vi.mock('../../api/simulation/simulationUniverse.js', () => ({
  llmSimulationTickers: mocks.tickers,
  llmUniverseItem: vi.fn((ticker: string) => ({
    ticker,
    market: /^\d{5}$/.test(ticker) ? 'HK' : 'US',
  })),
}))
vi.mock('../../api/simulation/llmRuntimeConfigService.js', () => ({
  getLlmRuntimeConfig: vi.fn(() => ({
    config: { disableUsOvernightLlm: true },
  })),
}))
vi.mock('../../api/cloud/multiuser/longbridge/contextRegistry.js', () => ({
  contextsForConnection: vi.fn(),
}))
vi.mock('../../api/cloud/multiuser/longbridge/connectionStore.js', () => ({
  credentialsForConnection: vi.fn(),
}))

import {
  listTenantHistory,
  loadTenantLiveDashboard,
} from '../../api/cloud/multiuser/longbridge/tenantDataService.js'

const connection: BrokerConnection = {
  id: 'binding-1',
  userId: 'user-1',
  platform: 'longbridge',
  credentialSource: 'encrypted_bundle',
  status: 'verified',
}

const closedPseudoSignal = {
  id: 'closed-1',
  ticker: '07747',
  side: 'HOLD',
  reason: '港股休市后 LLM 请求已关闭，当前市场状态 CLOSED。',
  lifecycleStatus: 'SKIPPED',
  lifecycleReason: '港股休市后 LLM 请求已关闭，当前市场状态 CLOSED。',
  marketState: 'CLOSED',
}
const validSignal = {
  id: 'signal-1',
  ticker: 'AAPL',
  side: 'HOLD',
  reason: '继续观察',
  lifecycleStatus: 'HOLD',
}

describe('Longbridge 租户实盘状态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryOne.mockResolvedValue({
      desired: 'running',
      mode: 'shadow',
      live_trading_enabled: false,
      auto_submit_enabled: false,
      auto_cancel_enabled: false,
      settings: {},
    })
    mocks.marketStates.mockResolvedValue(new Map([
      ['AAPL.US', 'RTH'],
      ['7747.HK', 'CLOSED'],
    ]))
    mocks.query.mockImplementation(async (_sql: string, params?: unknown[]) => {
      const kind = params?.[2]
      if (kind === 'signals') {
        return [{ payload: closedPseudoSignal }, { payload: validSignal }]
      }
      return []
    })
  })

  it('Dashboard 返回全标的状态并过滤历史休市伪信号', async () => {
    const dashboard = await loadTenantLiveDashboard('user-1', 'binding-1', connection)
    expect(dashboard.evaluationStatus).toMatchObject({
      state: 'PARTIAL',
      activeCount: 1,
      waitingCount: 1,
      totalCount: 2,
    })
    expect(dashboard.signals).toEqual([validSignal])
    expect(dashboard.engine.signalCount).toBe(1)
    expect(dashboard.blockOpeningWhenCashNegative).toBe(true)
  })

  it('Dashboard 返回当前用户关闭的负现金开仓保护设置', async () => {
    mocks.queryOne.mockResolvedValueOnce({
      desired: 'running',
      mode: 'live',
      live_trading_enabled: true,
      auto_submit_enabled: true,
      auto_cancel_enabled: false,
      settings: { blockOpeningWhenCashNegative: false },
    })

    const dashboard = await loadTenantLiveDashboard('user-1', 'binding-1', connection)

    expect(dashboard.blockOpeningWhenCashNegative).toBe(false)
  })

  it('信号历史分页排除休市伪信号并修正总数', async () => {
    const history = await listTenantHistory(
      'user-1',
      'binding-1',
      'signals',
      1,
      12,
    )
    expect(history.items).toEqual([validSignal])
    expect(history.total).toBe(1)
    expect(history.totalPages).toBe(1)
  })

  it('连接上下文不可用时按状态异常保护且不请求交易日历', async () => {
    const dashboard = await loadTenantLiveDashboard('user-1', 'binding-1')
    expect(dashboard.evaluationStatus).toMatchObject({
      state: 'ERROR',
      activeCount: 0,
      waitingCount: 0,
      totalCount: 2,
    })
    expect(dashboard.evaluationStatus.items.every((item) =>
      item.evaluationState === 'ERROR')).toBe(true)
    expect(mocks.marketStates).not.toHaveBeenCalled()
  })
})
