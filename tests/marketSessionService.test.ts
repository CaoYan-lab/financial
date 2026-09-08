import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  snapshot: vi.fn(() => ({})),
}))

vi.mock('../api/utils/runPythonBridge.js', () => ({
  runPythonBridge: mocks.bridge,
}))
vi.mock('../api/realtime/realtimeStore.js', () => ({
  realtimeStore: { snapshot: mocks.snapshot },
}))

describe('Futu 市场状态缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('缓存缺少请求标的时重新请求并返回完整股票池', async () => {
    mocks.bridge
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: true,
          states: [state('AAPL')],
          updatedAt: '2026-09-08T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: true,
          states: [state('AAPL'), state('MU')],
          updatedAt: '2026-09-08T00:00:01.000Z',
        },
      })
    const { loadMarketSessions } = await import('../api/simulation/marketSessionService.js')

    expect(Object.keys(await loadMarketSessions(['AAPL']))).toEqual(['AAPL'])
    expect(Object.keys(await loadMarketSessions(['AAPL', 'MU'])).sort()).toEqual(['AAPL', 'MU'])
    expect(mocks.bridge).toHaveBeenCalledTimes(2)
  })

  it('市场日历读取失败时为全部请求标的返回不可用', async () => {
    mocks.bridge.mockResolvedValueOnce({ ok: false, error: 'bridge unavailable' })
    const { loadMarketSessions } = await import('../api/simulation/marketSessionService.js')
    const result = await loadMarketSessions(['AAPL', 'MU'])
    expect(result.AAPL.state).toBe('UNAVAILABLE')
    expect(result.MU.state).toBe('UNAVAILABLE')
  })

  it('合并同时发生的完整股票池状态刷新，避免触发 OpenD 限频', async () => {
    let resolveBridge!: (value: unknown) => void
    mocks.bridge.mockImplementationOnce(() => new Promise((resolve) => {
      resolveBridge = resolve
    }))
    const { loadMarketSessions } = await import('../api/simulation/marketSessionService.js')

    const first = loadMarketSessions(['AAPL', 'MU'])
    const second = loadMarketSessions(['AAPL', 'MU'])
    resolveBridge({
      ok: true,
      data: {
        ok: true,
        states: [state('AAPL'), state('MU')],
        updatedAt: '2026-09-08T00:00:00.000Z',
      },
    })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(mocks.bridge).toHaveBeenCalledTimes(1)
    expect(Object.keys(firstResult).sort()).toEqual(['AAPL', 'MU'])
    expect(Object.keys(secondResult).sort()).toEqual(['AAPL', 'MU'])
  })
})

function state(ticker: string) {
  return {
    ticker,
    code: `US.${ticker}`,
    state: 'CLOSED',
    labelZh: '休市',
    labelEn: 'Closed',
    tradable: false,
    allowsExtendedHours: false,
    updatedAt: '2026-09-08T00:00:00.000Z',
  }
}
