import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeMock = vi.hoisted(() => vi.fn())

vi.mock('../api/utils/runPythonBridge', () => ({
  runPythonBridge: bridgeMock,
}))

import { loadFutuLiveOrders } from '../api/live/futuLiveOrderService'

describe('Futu 实盘订单读取超时', () => {
  beforeEach(() => {
    bridgeMock.mockReset()
    bridgeMock.mockResolvedValue({ ok: false, error: 'timeout' })
  })

  it('订单列表子进程带 30 秒硬超时', async () => {
    await loadFutuLiveOrders({ accountId: 'test-account', bypassCache: true })

    expect(bridgeMock).toHaveBeenCalledWith(
      'futu_live_orders.py',
      expect.objectContaining({ accountId: 'test-account' }),
      { timeoutMs: 30_000 },
    )
  })
})
