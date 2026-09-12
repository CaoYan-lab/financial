import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LiveAccountDashboardResponse,
  LivePendingOrder,
} from '../shared/types'

process.env.LONGBRIDGE_LIVE_HISTORY_DB_PATH =
  `/tmp/financial-longbridge-submit-guard-${process.pid}.sqlite3`
process.env.LIVE_PERSIST_TEST = '1'

const mocks = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  submitOrder: vi.fn(),
  registerManagedOrder: vi.fn(),
}))

vi.mock('../api/longbridge/longbridgeAdapter.js', () => ({
  loadLongbridgeLiveAccountDashboard: mocks.loadAccount,
}))
vi.mock('../api/longbridge/longbridgeLiveOrderService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/longbridge/longbridgeLiveOrderService.js')>()
  return {
    ...actual,
    submitLongbridgeLiveOrder: mocks.submitOrder,
  }
})
vi.mock('../api/longbridge/longbridgeLiveSettings.js', () => ({
  getLongbridgeLiveSettings: vi.fn(() => ({
    liveTradingEnabled: true,
    blockOpeningWhenCashNegative: true,
  })),
}))
vi.mock('../api/longbridge/longbridgeSdkGateway.js', () => ({
  getLongbridgeSdkContexts: vi.fn(() => ({
    quote: {
      staticInfo: vi.fn(async () => [{ symbol: 'MU.US', lotSize: 1 }]),
    },
  })),
}))
vi.mock('../api/longbridge/longbridgeMarketSessionService.js', () => ({
  loadLongbridgeMarketStates: vi.fn(async () => new Map([['MU.US', 'RTH']])),
  normalizeLongbridgeSymbol: vi.fn((ticker: string) =>
    ticker.toUpperCase().includes('.') ? ticker.toUpperCase() : `${ticker.toUpperCase()}.US`),
}))
vi.mock('../api/live/managedOrderSupervisor.js', () => ({
  registerSubmittedManagedOrder: mocks.registerManagedOrder,
}))

const { longbridgeOrderQueueService } = await import(
  '../api/longbridge/longbridgeOrderQueueService'
)

describe('Longbridge 最终提交风控', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LONGBRIDGE_LIVE_TRADING_ENABLED = 'true'
    longbridgeOrderQueueService.resetForTests()
    mocks.loadAccount.mockResolvedValue(tradingAccount())
    mocks.submitOrder.mockImplementation(async (input) => ({
      ok: true,
      orderId: 'broker-order-1',
      ticker: input.intent.ticker,
      side: input.intent.side,
      quantity: String(input.intent.quantity),
      orderType: input.intent.orderType,
      orderSession: input.intent.orderSession,
      limitPrice: `$${input.intent.limitPrice.toFixed(2)}`,
      submittedAt: '2026-09-12T00:00:00.000Z',
      strategy: input.intent.strategy,
      signalId: input.intent.signalId,
      pendingOrderId: input.pendingOrderId,
      feeContext: input.intent.feeContext,
    }))
  })

  it('账户快照失败时禁止调用真实下单', async () => {
    mocks.loadAccount.mockResolvedValueOnce({
      ...tradingAccount(),
      ok: false,
    })
    const order = pendingOrder()
    longbridgeOrderQueueService.createPendingOrder(order)

    const result = await longbridgeOrderQueueService.confirmPendingOrder(order.id)

    expect(result).toMatchObject({
      ok: false,
      blockedByGate: true,
    })
    expect(result.error).toContain('账户快照读取失败')
    expect(mocks.submitOrder).not.toHaveBeenCalled()
  })

  it('待确认期间购买力下降时重新执行完整风控并拒绝提交', async () => {
    mocks.loadAccount.mockResolvedValueOnce(tradingAccount({
      buyingPower: '$500.00',
      buyingPowerInTradingCurrency: '$500.00',
    }))
    const order = pendingOrder()
    longbridgeOrderQueueService.createPendingOrder(order)

    const result = await longbridgeOrderQueueService.confirmPendingOrder(order.id)

    expect(result.error).toContain('超过 USD 最大购买力保护线')
    expect(mocks.submitOrder).not.toHaveBeenCalled()
  })

  it('提交和持久化均使用方向性归一化后的实际价格', async () => {
    const order = pendingOrder()
    order.intent.limitPrice = 982.369
    order.llmDecision.limitPrice = 982.369
    longbridgeOrderQueueService.createPendingOrder(order)

    const result = await longbridgeOrderQueueService.confirmPendingOrder(order.id)

    expect(result.ok).toBe(true)
    expect(mocks.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ limitPrice: 982.36 }),
    }))
    expect(result.order?.intent.limitPrice).toBe(982.36)
  })
})

function tradingAccount(
  summary: Partial<LiveAccountDashboardResponse['summary']> = {},
): LiveAccountDashboardResponse {
  return {
    ok: true,
    selectedAccountId: 'longbridge-real',
    summary: {
      accountId: 'longbridge-real',
      currency: 'USD',
      totalAssets: '$20,000.00',
      cash: '$10,000.00',
      availableFunds: '$10,000.00',
      buyingPower: '$20,000.00',
      financingRiskLevel: 0,
      financingRiskLabel: '安全',
      financingOpeningRestricted: false,
      initialMargin: '$0.00',
      maintenanceMargin: '$0.00',
      marginCall: '$0.00',
      tradingCurrency: 'USD',
      totalAssetsInTradingCurrency: '$20,000.00',
      cashInTradingCurrency: '$10,000.00',
      availableFundsInTradingCurrency: '$10,000.00',
      buyingPowerInTradingCurrency: '$20,000.00',
      dailyPnL: '$0.00',
      totalPnL: '$0.00',
      ...summary,
    },
    positions: [],
    risk: {
      concentrationRisk: '正常',
      largestPosition: '无',
      cashRatio: '50%',
      top30Overlap: '无',
      warnings: [],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: true,
      requiresConfirmation: true,
      warning: '',
    },
    missingCapabilities: [],
    warnings: [],
  }
}

function pendingOrder(): LivePendingOrder {
  return {
    id: 'pending-mu-1',
    status: 'PENDING_CONFIRMATION',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    intent: {
      ticker: 'MU',
      side: 'BUY',
      quantity: 1,
      orderType: 'LIMIT',
      orderSession: 'RTH',
      limitPrice: 982.369,
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      signalId: 'signal-mu-1',
      reason: 'test',
      estimatedNotional: '$982.37',
      feeContext: {
        source: 'estimated_pre_trade',
        currency: 'USD',
        feeAmount: 1,
        feeDetails: [],
      },
    },
    signal: {
      id: 'signal-mu-1',
      ticker: 'MU',
      strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
      side: 'BUY',
      confidence: 'medium',
      reason: 'test',
      price: '$982.37',
      quantity: '1',
      limitPrice: '$982.37',
      riskAssessment: 'test',
      generatedAt: '2026-09-12T00:00:00.000Z',
      dataWindow: '{}',
      source: 'longbridge-sdk-cache',
    },
    llmDecision: {
      ok: true,
      approved: true,
      action: 'BUY',
      ticker: 'MU',
      orderQuantity: 1,
      limitPrice: 982.369,
      confidence: 'medium',
      reason: 'test',
      riskAssessment: 'test',
      dataWindowUsed: {
        kline1mBars: 30,
        tickerPoints: 30,
        orderBookDepth: 5,
      },
    },
    riskWarnings: [],
    decisionMode: 'legacy_direct',
  }
}
