import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConnection } from '../../api/cloud/multiuser/types.js'
import type { TenantJob } from '../../api/cloud/multiuser/longbridge/tenantJobStore.js'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getConnectionForVerification: vi.fn(),
  getOwnedConnection: vi.fn(),
  markConnectionInvalid: vi.fn(),
  markConnectionVerified: vi.fn(),
  loadDashboard: vi.fn(),
  runChild: vi.fn(),
  setDesired: vi.fn(),
  runStrategy: vi.fn(),
  runStrategyPool: vi.fn(),
  loadLotSize: vi.fn(),
  loadMarketStates: vi.fn(),
  appendPending: vi.fn(),
  getPending: vi.fn(),
  claimJob: vi.fn(),
  completeJob: vi.fn(),
  enqueueJob: vi.fn(),
  failJob: vi.fn(),
  enabled: vi.fn(() => true),
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({ query: mocks.query }))
vi.mock('../../api/utils/logger.js', () => ({ logger: { info: mocks.info, error: mocks.error } }))
vi.mock('../../api/cloud/multiuser/longbridge/connectionStore.js', () => ({
  getConnectionForVerification: mocks.getConnectionForVerification,
  getOwnedConnection: mocks.getOwnedConnection,
  markConnectionInvalid: mocks.markConnectionInvalid,
  markConnectionVerified: mocks.markConnectionVerified,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantDataService.js', () => ({
  loadTenantLiveDashboard: mocks.loadDashboard,
  runTenantOrderChild: mocks.runChild,
  setTenantDesiredState: mocks.setDesired,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantStrategyService.js', () => ({
  runTenantStrategyOnce: mocks.runStrategy,
  runTenantStrategyPoolOnce: mocks.runStrategyPool,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantMarketSessionService.js', () => ({
  loadTenantLotSize: mocks.loadLotSize,
  loadTenantMarketStates: mocks.loadMarketStates,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantOrderStore.js', () => ({
  appendTenantPendingOrder: mocks.appendPending,
  getTenantPendingOrder: mocks.getPending,
}))
vi.mock('../../api/cloud/multiuser/longbridge/tenantJobStore.js', () => ({
  claimTenantJob: mocks.claimJob,
  completeTenantJob: mocks.completeJob,
  enqueueTenantJob: mocks.enqueueJob,
  failTenantJob: mocks.failJob,
}))
vi.mock('../../api/cloud/multiuser/auth/multiUserAuthService.js', () => ({
  multiUserEnabled: mocks.enabled,
}))

import {
  multiUserWorkerTestHarness,
  startMultiUserWorkerRuntime,
  stopMultiUserWorkerRuntime,
} from '../../api/cloud/multiuser/worker/multiUserWorkerRuntime.js'

const connection: BrokerConnection = {
  id: 'binding-1',
  userId: 'user-1',
  platform: 'longbridge',
  credentialSource: 'encrypted_bundle',
  status: 'verified',
}
const pendingOrder = {
  id: 'pending-1',
  status: 'PENDING_CONFIRMATION',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  intent: {
    ticker: 'AAPL',
    side: 'BUY',
    quantity: 2,
    orderType: 'MARKETABLE_LIMIT',
    orderSession: 'RTH',
    limitPrice: 100,
    strategy: 'test',
    signalId: 'signal-1',
    reason: 'test',
    estimatedNotional: '$200',
    feeContext: {},
  },
  signal: {},
  llmDecision: { tradeHorizon: 'SWING' },
  riskWarnings: [],
}

const job = (jobType: string, payload: Record<string, unknown> = {}): TenantJob => ({
  id: `job-${jobType}`,
  userId: 'user-1',
  bindingId: 'binding-1',
  jobType,
  payload,
})

describe('多用户 Worker runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stopMultiUserWorkerRuntime()
    mocks.enabled.mockReturnValue(true)
    mocks.query.mockResolvedValue([])
    mocks.getOwnedConnection.mockResolvedValue(connection)
    mocks.getConnectionForVerification.mockResolvedValue(connection)
    mocks.runChild.mockResolvedValue({ ok: true, orderId: 'broker-1', rawResponse: { status: 'ok' } })
    mocks.getPending.mockResolvedValue(pendingOrder)
    mocks.loadLotSize.mockResolvedValue(1)
    mocks.runStrategy.mockResolvedValue({ ok: true })
    mocks.runStrategyPool.mockResolvedValue({ ok: true, evaluatedCount: 20 })
    mocks.loadMarketStates.mockResolvedValue(new Map([['AAPL.US', 'RTH']]))
    mocks.loadDashboard.mockResolvedValue({ ok: true })
    mocks.claimJob.mockResolvedValue(null)
    mocks.enqueueJob.mockResolvedValue('auto-submit-job-1')
  })

  it('验证 pending 绑定并处理验证失败', async () => {
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.verify_connection'),
    )).resolves.toEqual({ ok: true, verified: true })
    expect(mocks.markConnectionVerified).toHaveBeenCalledWith('user-1', 'binding-1')

    mocks.runChild.mockResolvedValueOnce({ ok: false, error: 'read failed' })
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.verify_connection'),
    )).rejects.toThrow('read failed')
    expect(mocks.markConnectionInvalid).toHaveBeenCalledWith('binding-1')

    mocks.getConnectionForVerification.mockResolvedValueOnce(null)
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.verify_connection'),
    )).rejects.toThrow('待验证的长桥绑定不存在')
  })

  it('处理启动、停止、订单列表、详情、撤单和单次策略', async () => {
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.start'),
    )).resolves.toMatchObject({ desired: 'running' })
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.stop'),
    )).resolves.toMatchObject({ desired: 'stopped' })
    await multiUserWorkerTestHarness.handleTenantJob(job('multiuser.longbridge.orders', { page: 1 }))
    await multiUserWorkerTestHarness.handleTenantJob(job('multiuser.longbridge.order_detail', { orderId: '1' }))
    await multiUserWorkerTestHarness.handleTenantJob(job('multiuser.longbridge.cancel_order', { orderId: '1' }))
    await multiUserWorkerTestHarness.handleTenantJob(job('multiuser.longbridge.run_once', { symbol: 'AAPL.US' }))
    await multiUserWorkerTestHarness.handleTenantJob(job('multiuser.longbridge.run_once', { symbol: 1 }))
    expect(mocks.setDesired).toHaveBeenCalledTimes(2)
    expect(mocks.runChild).toHaveBeenCalledWith(connection, 'cancel', { orderId: '1' })
    expect(mocks.runStrategy).toHaveBeenCalledWith('user-1', connection, 'AAPL.US')
    expect(mocks.runStrategyPool).toHaveBeenCalledWith('user-1', connection)
  })

  it('租户自动下单开启时为新待确认订单创建真实提交任务', async () => {
    mocks.runStrategy.mockResolvedValueOnce({ ok: true, pendingOrder })
    mocks.query.mockResolvedValueOnce([{
      mode: 'live',
      live_trading_enabled: true,
      auto_submit_enabled: true,
      shadow_verified_at: new Date(),
    }])
    const result = await multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.run_once', { symbol: 'AAPL.US' }),
    )
    expect(mocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      bindingId: 'binding-1',
      jobType: 'multiuser.longbridge.submit_order',
      payload: expect.objectContaining({
        pendingOrderId: pendingOrder.id,
        symbol: 'AAPL.US',
        orderSession: 'RTH',
      }),
    }))
    expect(result).toMatchObject({ autoSubmitJobIds: ['auto-submit-job-1'] })
  })

  it('拒绝绑定缺失和未知任务', async () => {
    mocks.getOwnedConnection.mockResolvedValueOnce(null)
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.orders'),
    )).rejects.toThrow('任务绑定不存在')
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.unknown'),
    )).rejects.toThrow('不支持的多用户任务')
  })

  it.each([
    { state: [] },
    { state: [{ mode: 'shadow', live_trading_enabled: true, shadow_verified_at: new Date() }] },
    { state: [{ mode: 'live', live_trading_enabled: false, shadow_verified_at: new Date() }] },
    { state: [{ mode: 'live', live_trading_enabled: true, shadow_verified_at: null }] },
  ])('实盘三重门禁任一条件不满足即拒绝', async ({ state }) => {
    mocks.query.mockResolvedValueOnce(state)
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.submit_order', { pendingOrderId: 'pending-1' }),
    )).rejects.toThrow('真实交易门禁关闭')
    expect(mocks.runChild).not.toHaveBeenCalled()
  })

  it('拒绝不存在或非待确认状态的订单', async () => {
    mocks.query.mockResolvedValueOnce([{
      mode: 'live', live_trading_enabled: true, shadow_verified_at: new Date(),
    }])
    mocks.getPending.mockResolvedValueOnce(null)
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.submit_order', { pendingOrderId: 'missing' }),
    )).rejects.toThrow('未找到当前用户可提交的待确认订单')
  })

  it('提交前重新读取交易日历并拒绝休市订单', async () => {
    mocks.query.mockResolvedValueOnce([{
      mode: 'live', live_trading_enabled: true, shadow_verified_at: new Date(),
    }])
    mocks.loadMarketStates.mockResolvedValueOnce(new Map([['AAPL.US', 'CLOSED']]))
    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.submit_order', {
        pendingOrderId: 'pending-1',
        symbol: 'AAPL.US',
      }),
    )).rejects.toThrow('休市')
    expect(mocks.runChild).not.toHaveBeenCalled()
  })

  it('提交前拒绝不符合港股每手股数的订单', async () => {
    mocks.query.mockResolvedValueOnce([{
      mode: 'live', live_trading_enabled: true, shadow_verified_at: new Date(),
    }])
    mocks.getPending.mockResolvedValueOnce({
      ...pendingOrder,
      intent: {
        ...pendingOrder.intent,
        ticker: '07709',
        quantity: 3,
      },
    })
    mocks.loadLotSize.mockResolvedValueOnce(100)

    await expect(multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.submit_order', {
        pendingOrderId: 'pending-1',
        symbol: '7709.HK',
      }),
    )).rejects.toThrow('每手 100 股')
    expect(mocks.loadMarketStates).not.toHaveBeenCalled()
    expect(mocks.runChild).not.toHaveBeenCalled()
  })

  it('提交成功时记录状态、托管订单和幂等事件', async () => {
    mocks.query.mockResolvedValueOnce([{
      mode: 'live', live_trading_enabled: true, shadow_verified_at: new Date(),
    }])
    const result = await multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.submit_order', { pendingOrderId: 'pending-1' }),
    )
    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { status: 'SUBMITTED', submittedOrder: { orderId: 'broker-1' } },
    })
    expect(mocks.appendPending).toHaveBeenCalledTimes(2)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('longbridge_managed_orders'))).toBe(true)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("'submitted'"))).toBe(true)
  })

  it('提交失败时写入 SUBMIT_FAILED 且不创建托管订单', async () => {
    mocks.query.mockResolvedValueOnce([{
      mode: 'live', live_trading_enabled: true, shadow_verified_at: new Date(),
    }])
    mocks.runChild.mockResolvedValueOnce({ ok: false, error: 'broker rejected' })
    const result = await multiUserWorkerTestHarness.handleTenantJob(
      job('multiuser.longbridge.submit_order', { pendingOrderId: 'pending-1' }),
    )
    expect(result.pendingOrder).toMatchObject({ status: 'SUBMIT_FAILED' })
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('longbridge_managed_orders'))).toBe(false)
  })

  it('监管订单同步终态、部分成交并按超时自动撤单', async () => {
    const old = new Date(Date.now() - 700_000)
    mocks.query.mockResolvedValueOnce([
      { order_id: 'filled', payload: { submittedQuantity: 2, version: 1 }, created_at: old },
      {
        order_id: 'partial',
        payload: { submittedQuantity: 3, orderType: 'LIMIT', submittedAt: 'old', version: 2 },
        created_at: old,
      },
      { order_id: 'failed-read', payload: {}, created_at: old },
    ])
    mocks.runChild
      .mockResolvedValueOnce({
        ok: true, status: 5, statusLabel: '已成交', quantity: 2,
        executedQuantity: 2, executedPrice: 101, updatedAt: 'now',
      })
      .mockResolvedValueOnce({
        ok: true, status: 11, statusLabel: '部分成交', quantity: 3,
        executedQuantity: 1, executedPrice: null, updatedAt: 'now',
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
    await multiUserWorkerTestHarness.superviseTenantOrders(
      'user-1',
      connection,
      true,
      { limitTimeoutSeconds: 1 },
    )
    expect(mocks.runChild).toHaveBeenCalledWith(connection, 'cancel', { orderId: 'partial' })
    expect(mocks.query.mock.calls.some(([, params]) => Array.isArray(params) && params.includes('FILLED'))).toBe(true)
    expect(mocks.query.mock.calls.some(([, params]) => Array.isArray(params) && params.includes('PARTIALLY_FILLED'))).toBe(true)
  })

  it('覆盖所有券商状态映射和终态判断', () => {
    const expected = new Map([
      [5, 'FILLED'], [11, 'PARTIALLY_FILLED'], [14, 'REJECTED'], [15, 'CANCELED'],
      [16, 'EXPIRED'], [17, 'PARTIALLY_CANCELED'], [12, 'CANCEL_PENDING'],
      [13, 'CANCEL_PENDING'], [1, 'TRACKING'], [99, 'UNKNOWN'],
    ])
    for (const [input, output] of expected) {
      expect(multiUserWorkerTestHarness.managedStatus(input)).toBe(output)
    }
    expect(multiUserWorkerTestHarness.isTerminalManagedStatus('FILLED')).toBe(true)
    expect(multiUserWorkerTestHarness.isTerminalManagedStatus('TRACKING')).toBe(false)
  })

  it('启动与停止 runtime，并消费成功任务和写入心跳', async () => {
    vi.useFakeTimers()
    mocks.claimJob
      .mockResolvedValueOnce(job('multiuser.longbridge.start'))
      .mockResolvedValueOnce(null)
    mocks.query
      .mockResolvedValueOnce([{
        user_id: 'user-1',
        id: 'binding-1',
        auto_cancel_enabled: false,
        settings: {},
      }])
      .mockResolvedValue([])
    startMultiUserWorkerRuntime('worker-1')
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.completeJob).toHaveBeenCalled()
    expect(mocks.loadDashboard).toHaveBeenCalled()
    stopMultiUserWorkerRuntime()
    vi.useRealTimers()
  })

  it('关闭功能开关时不启动 runtime', async () => {
    mocks.enabled.mockReturnValue(false)
    startMultiUserWorkerRuntime('worker-disabled')
    await Promise.resolve()
    expect(mocks.claimJob).not.toHaveBeenCalled()
    expect(mocks.info).not.toHaveBeenCalled()
  })
})
