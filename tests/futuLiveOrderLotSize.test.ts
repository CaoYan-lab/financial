import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runPythonBridge: vi.fn(),
  snapshot: vi.fn(() => ({ quote: { lotSize: 100 } })),
}))

vi.mock('../api/utils/runPythonBridge.js', () => ({
  runPythonBridge: mocks.runPythonBridge,
}))

vi.mock('../api/realtime/realtimeStore.js', () => ({
  realtimeStore: { snapshot: mocks.snapshot },
}))

import { submitLiveOrder } from '../api/live/futuLiveOrderService.js'

describe('Futu 港股真实提交整手门禁', () => {
  const previousEnabled = process.env.LIVE_TRADING_ENABLED
  const previousEnvironment = process.env.FUTU_LIVE_TRD_ENV

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LIVE_TRADING_ENABLED = 'true'
    process.env.FUTU_LIVE_TRD_ENV = 'REAL'
  })

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.LIVE_TRADING_ENABLED
    else process.env.LIVE_TRADING_ENABLED = previousEnabled
    if (previousEnvironment === undefined) delete process.env.FUTU_LIVE_TRD_ENV
    else process.env.FUTU_LIVE_TRD_ENV = previousEnvironment
  })

  it('提交前拒绝不符合真实每手股数的港股订单', async () => {
    const result = await submitLiveOrder('account-1', 'pending-1', 'confirm-1', {
      ticker: '07747',
      side: 'BUY',
      quantity: 3,
      orderType: 'MARKETABLE_LIMIT',
      orderSession: 'RTH',
      limitPrice: 82.54,
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      signalId: 'signal-1',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('每手 100 股')
    expect(mocks.runPythonBridge).not.toHaveBeenCalled()
  })
})
