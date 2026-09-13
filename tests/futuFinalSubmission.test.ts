import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ account: vi.fn(), submit: vi.fn(), session: vi.fn() }))
vi.mock('../api/live/liveAccountService.js', () => ({ loadLiveAccountDashboard: mocks.account }))
vi.mock('../api/live/futuLiveOrderService.js', () => ({ submitLiveOrder: mocks.submit }))
vi.mock('../api/live/managedOrderSupervisor.js', () => ({ registerSubmittedManagedOrder: vi.fn() }))
vi.mock('../api/simulation/marketSessionService.js', () => ({ loadMarketSessions: mocks.session }))
vi.mock('../api/live/liveTradingEngine.js', () => ({ openingRiskRejectionReason: () => undefined }))
import { liveOrderQueueService } from '../api/live/liveOrderQueueService'

function account() {
  return { ok: true, selectedAccountId: 'a', warnings: [], positions: [],
    summary: { accountId: 'a', currency: 'USD', tradingCurrency: 'USD', financingCurrency: 'USD', financingEquity: '$10000',
      initialMargin: '$0', maintenanceMargin: '$0', futuExposureLevel: 'SAFE', futuRiskStatus: 'LEVEL1',
      totalAssetsInTradingCurrency: '$10000', buyingPowerInTradingCurrency: '$10000', source: { accessedAt: new Date().toISOString() } } }
}
function pending(overrides: Record<string, unknown> = {}) {
  const order = { id: 'p1', status: 'PENDING_CONFIRMATION', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    intent: { ticker: 'AAPL', side: 'BUY', quantity: 1, limitPrice: 100, orderType: 'LIMIT', orderSession: 'RTH' },
    llmDecision: {}, riskWarnings: [], ...overrides } as any
  liveOrderQueueService.createPendingOrder(order)
  return order
}
describe('富途最终提交防线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    liveOrderQueueService.resetForTests()
    vi.stubEnv('LIVE_TRADING_ENABLED', 'true')
    vi.stubEnv('FUTU_LIVE_TRD_ENV', 'REAL')
    mocks.session.mockResolvedValue({ AAPL: { state: 'RTH' } })
    mocks.account.mockResolvedValue(account())
    mocks.submit.mockResolvedValue({ ok: true, orderId: 'o1', submittedAt: new Date().toISOString(), ticker: 'AAPL', side: 'BUY' })
  })
  afterEach(() => vi.unstubAllEnvs())
  it('提交前强制刷新并执行账户风控', async () => {
    pending()
    expect((await liveOrderQueueService.confirmPendingOrder('p1')).ok).toBe(true)
    expect(mocks.account).toHaveBeenCalledWith({ accountId: undefined, market: 'US', tradingCurrency: 'USD', refreshCache: true })
    expect(mocks.submit).toHaveBeenCalledTimes(1)
  })
  it('未知融资和读取失败均不能报单', async () => {
    pending()
    const a = account()
    a.summary.futuExposureLevel = 'WARNING'
    mocks.account.mockResolvedValueOnce(a)
    expect((await liveOrderQueueService.confirmPendingOrder('p1')).blockedByGate).toBe(true)
    mocks.account.mockResolvedValueOnce({ ...a, ok: false })
    expect((await liveOrderQueueService.confirmPendingOrder('p1')).ok).toBe(false)
    expect(mocks.submit).not.toHaveBeenCalled()
  })
  it('影子结果即使被错误写入待确认队列也无法执行', async () => {
    pending({ llmDecision: { promptAudit: { mode: 'shadow', ordersEnabled: false } } })
    expect((await liveOrderQueueService.confirmPendingOrder('p1')).error).toContain('影子建议禁止提交')
    expect(mocks.submit).not.toHaveBeenCalled()
  })
  it('同账户并发确认不会重复调用券商', async () => {
    pending()
    const results = await Promise.all([liveOrderQueueService.confirmPendingOrder('p1'), liveOrderQueueService.confirmPendingOrder('p1')])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(mocks.submit).toHaveBeenCalledTimes(1)
  })
  it('等待账户时被用户拒绝的订单不提交', async () => {
    pending()
    mocks.account.mockImplementationOnce(async () => {
      liveOrderQueueService.rejectPendingOrder('p1')
      return account()
    })
    expect((await liveOrderQueueService.confirmPendingOrder('p1')).ok).toBe(false)
    expect(mocks.submit).not.toHaveBeenCalled()
  })
})
