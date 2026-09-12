import { describe, expect, it } from 'vitest'
import { loadLongbridgeLiveAccountDashboard } from '../api/longbridge/longbridgeAdapter'
import { buildLongbridgeLiveDecisionPrompt, parseLongbridgeTradingDecision, requestLongbridgeLiveTradingDecision } from '../api/longbridge/longbridgeLiveDecisionService'
import { loadLongbridgeStrategyMarketData } from '../api/longbridge/longbridgeMarketDataService'
import { buildPortfolioReviewPrompt } from '../api/live/livePortfolioReviewDecisionService'
import type { LiveAccountDashboardResponse, LlmDataWindowRecommendation } from '../shared/types'

const dataWindow: LlmDataWindowRecommendation = {
  kline1mBars: 30,
  tickerPoints: 30,
  orderBookDepth: 5,
  pollIntervalSeconds: 60,
  reason: 'Longbridge integration test window.',
  source: 'fallback',
}

const runPrompt = process.env.RUN_LONGBRIDGE_INTEGRATION === '1' ? describe : describe.skip
const runLlm = process.env.RUN_LONGBRIDGE_INTEGRATION === '1' && process.env.RUN_LONGBRIDGE_LLM_INTEGRATION === '1' ? describe : describe.skip

describe('Longbridge live decision prompt context', () => {
  it('传入账户资金、持仓、K 线、盘口和组合上下文', () => {
    const marketData = {
      ok: true as const,
      ticker: 'AAPL',
      symbol: 'AAPL.US',
      source: 'longbridge-cli' as const,
      lastPrice: 180,
      bars: [{ time: '2026-06-22T10:00:00.000Z', open: 179, high: 181, low: 178, close: 180 }],
      tickerPoints: [{ time: '2026-06-22T10:00:00.000Z', price: 180 }],
      asks: [{ price: '180.10', size: '100', depth: 1 }],
      bids: [{ price: '179.90', size: '100', depth: 1 }],
      bestAsk: 180.1,
      bestBid: 179.9,
      marketState: 'TRADING',
      updatedAt: '2026-06-22T10:00:00.000Z',
      warnings: [],
    }
    const prompt = buildLongbridgeLiveDecisionPrompt({ symbol: 'AAPL.US', account: testAccount(), marketData, dataWindow })
    const payload = JSON.parse(prompt[1].content)

    expect(payload.targetInstrument.ticker).toBe('AAPL')
    expect(payload.account.totalAssets).toBe('$10000.00')
    expect(payload.account.availableFunds).toBe('$5000.00')
    expect(payload.account.buyingPower).toBe('$12000.00')
    expect(payload.account.availableFundsNumeric).toBe(5000)
    expect(payload.account.buyingPowerNumeric).toBe(12000)
    expect(payload.account.orderSizingConstraint).toContain('$12000.00')
    expect(payload.account.positions[0].ticker).toBe('AAPL')
    expect(payload.currentPosition.ticker).toBe('AAPL')
    expect(payload.portfolioContext.targetExposure.exposureSide).toBe('LONG')
    expect(payload.riskModel).toContain('购买力')
    expect(payload.marketData.recentKlineBars).toHaveLength(1)
    expect(payload.marketData.asks).toHaveLength(1)
    expect(payload.marketData.bids).toHaveLength(1)
  })

  it('将长桥融资风险等级和保证金状态加入提示词，并优先于购买力限制', () => {
    const account = testAccount()
    account.summary.financingRiskLevel = 2
    account.summary.financingRiskLabel = '预警'
    account.summary.financingOpeningRestricted = true
    account.summary.initialMargin = '$9000.00'
    account.summary.maintenanceMargin = '$8000.00'
    account.summary.marginCall = '$100.00'
    account.summary.maximumFinancing = '$20000.00'
    account.summary.remainingFinancing = '$3000.00'
    const marketData = {
      ok: true as const,
      ticker: 'AAPL',
      symbol: 'AAPL.US',
      source: 'longbridge-sdk-cache' as const,
      lastPrice: 180,
      bars: [],
      tickerPoints: [],
      asks: [],
      bids: [],
      marketState: 'TRADING',
      updatedAt: '2026-09-11T10:00:00.000Z',
      warnings: [],
    }

    const payload = JSON.parse(buildLongbridgeLiveDecisionPrompt({
      symbol: marketData.symbol,
      account,
      marketData,
      dataWindow,
    })[1].content)

    expect(payload.account.financingRisk).toMatchObject({
      level: 2,
      label: '预警',
      openingRestricted: true,
      marginCall: '$100.00',
      remainingFinancing: '$3000.00',
    })
    expect(payload.account.financingRisk.rule).toContain('即使 buyingPower 大于 0 也禁止新增仓位')
    expect(payload.account.orderSizingConstraint).toContain('不得使用剩余购买力继续融资')
  })

  it('将融资风险状态加入组合候选裁决提示词', () => {
    const account = testAccount()
    account.summary.financingRiskLevel = 2
    account.summary.financingRiskLabel = '预警'
    account.summary.financingOpeningRestricted = true
    account.summary.initialMargin = '$9000.00'
    account.summary.maintenanceMargin = '$8000.00'
    account.summary.marginCall = '$100.00'
    const prompt = buildPortfolioReviewPrompt({
      candidates: [{
        candidateId: 'candidate-1',
        ticker: 'AAPL',
        action: 'BUY',
        groupKey: 'AAPL_DIRECT',
        riskTags: [],
        firstSeenAt: '2026-09-11T10:00:00.000Z',
        lastSeenAt: '2026-09-11T10:00:00.000Z',
        signalCount: 1,
        firstSignalPrice: 180,
        latestSignalPrice: 180,
        latestMarketPrice: 180,
        priceDriftPct: 0,
        proposedQuantity: 1,
        proposedNotional: 180,
        confidence: 'medium',
        recentReasons: ['test'],
      }],
      account,
      positions: account.positions,
      pendingOrders: [],
      constraints: {
        maxPromotedOrdersPerReview: 1,
        minSignalConfirmations: 1,
        leveragedEtfCooldownMinutes: 30,
        sameGroupMutualExclusion: false,
        humanConfirmationRequired: true,
      },
    }, 'portfolio-review-test')
    const payload = JSON.parse(prompt[1].content)

    expect(payload.portfolioState.account.financingRisk).toMatchObject({
      level: 2,
      label: '预警',
      openingRestricted: true,
      marginCall: '$100.00',
    })
    expect(payload.portfolioState.account.financingRisk.rule).toContain('禁止晋级')
  })

  it('港股提示词包含真实每手股数，美股不套用港股规则', () => {
    const hkMarketData = {
      ok: true as const,
      ticker: '09660',
      symbol: '9660.HK',
      source: 'longbridge-sdk-cache' as const,
      lastPrice: 15,
      bars: [],
      tickerPoints: [],
      asks: [],
      bids: [],
      lotSize: 600,
      marketState: 'MORNING',
      updatedAt: '2026-09-08T02:00:00.000Z',
      warnings: [],
    }
    const hkPayload = JSON.parse(buildLongbridgeLiveDecisionPrompt({
      symbol: hkMarketData.symbol,
      account: testAccount(),
      marketData: hkMarketData,
      dataWindow,
    })[1].content)

    expect(hkPayload.account.tradingUnit.lotSize).toBe(600)
    expect(hkPayload.account.tradingUnit.rule).toContain('每手 600 股')
    expect(hkPayload.portfolioContext.orderQuantityConvention).toContain('600 的正整数倍')

    const usMarketData = { ...hkMarketData, ticker: 'AAPL', symbol: 'AAPL.US', lotSize: 1 }
    const usPayload = JSON.parse(buildLongbridgeLiveDecisionPrompt({
      symbol: usMarketData.symbol,
      account: testAccount(),
      marketData: usMarketData,
      dataWindow,
    })[1].content)
    expect(usPayload.account.tradingUnit.rule).toContain('不套用港股整手约束')
  })

  it('负现金保护开启时提示模型只允许平仓', () => {
    const account = testAccount()
    account.summary.availableFunds = '$-100.00'
    account.summary.availableFundsInTradingCurrency = '$-100.00'
    const marketData = {
      ok: true as const,
      ticker: 'AAPL',
      symbol: 'AAPL.US',
      source: 'longbridge-sdk-cache' as const,
      lastPrice: 180,
      bars: [],
      tickerPoints: [],
      asks: [],
      bids: [],
      lotSize: 1,
      marketState: 'RTH',
      updatedAt: '2026-09-11T15:00:00.000Z',
      warnings: [],
    }

    const payload = JSON.parse(buildLongbridgeLiveDecisionPrompt({
      symbol: marketData.symbol,
      account,
      marketData,
      dataWindow,
      blockOpeningWhenCashNegative: true,
    })[1].content)

    expect(payload.account.blockOpeningWhenCashNegative).toBe(true)
    expect(payload.account.orderSizingConstraint).toContain('只允许 SELL_TO_CLOSE')
  })

  it('拒绝港股非整手开仓数量，并保留美股按股数量', () => {
    const baseMarketData = {
      ok: true as const,
      ticker: '07709',
      symbol: '7709.HK',
      source: 'longbridge-sdk-cache' as const,
      lastPrice: 44,
      bars: [],
      tickerPoints: [],
      asks: [],
      bids: [],
      lotSize: 100,
      marketState: 'MORNING',
      updatedAt: '2026-09-08T02:00:00.000Z',
      warnings: [],
    }
    const raw = '{"approved":true,"action":"BUY","ticker":"07709","orderQuantity":3,"limitPrice":44}'
    const blocked = parseLongbridgeTradingDecision(raw, {
      symbol: baseMarketData.symbol,
      account: testAccount(),
      marketData: baseMarketData,
      dataWindow,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.action).toBe('HOLD')
    expect(blocked.error).toContain('每手 100 股')

    const usMarketData = { ...baseMarketData, ticker: 'AAPL', symbol: 'AAPL.US', lotSize: 1 }
    const accepted = parseLongbridgeTradingDecision(
      '{"approved":true,"action":"BUY","ticker":"AAPL","orderQuantity":3,"limitPrice":180}',
      { symbol: usMarketData.symbol, account: testAccount(), marketData: usMarketData, dataWindow },
    )
    expect(accepted.ok).toBe(true)
    expect(accepted.orderQuantity).toBe(3)
  })
})

runPrompt('Longbridge live decision prompt integration', () => {
  it('使用 Longbridge 真实行情构建大模型 Prompt', async () => {
    const account = await loadLongbridgeLiveAccountDashboard()
    const marketData = await loadLongbridgeStrategyMarketData('AAPL.US', { klineCount: 30 })
    expect(marketData.ok).toBe(true)
    if (!marketData.ok) throw new Error(marketData.reason)

    const prompt = buildLongbridgeLiveDecisionPrompt({ symbol: marketData.symbol, account, marketData, dataWindow })
    const payload = JSON.parse(prompt[1].content)

    expect(payload.platformRuntime.platform).toBe('Longbridge')
    expect(payload.platformRuntime.dataSource).toContain('Longbridge')
    expect(payload.marketData.source).toBe('longbridge-cli')
    expect(payload.marketData.recentKlineBars.length).toBeGreaterThan(0)
    expect(payload.account.source).toBe('longbridge-cli')
    expect(JSON.stringify(payload)).not.toContain('Futu REAL')
    expect(JSON.stringify(payload)).not.toContain('Futu OpenD')
  }, 60_000)
})

function testAccount(): LiveAccountDashboardResponse {
  return {
    ok: true,
    selectedAccountId: 'longbridge-real',
    summary: {
      accountId: 'longbridge-real',
      currency: 'USD',
      totalAssets: '$10000.00',
      cash: '$4000.00',
      availableFunds: '$5000.00',
      buyingPower: '$12000.00',
      tradingCurrency: 'USD',
      totalAssetsInTradingCurrency: '$10000.00',
      cashInTradingCurrency: '$4000.00',
      availableFundsInTradingCurrency: '$5000.00',
      buyingPowerInTradingCurrency: '$12000.00',
      dailyPnL: '$0.00',
      totalPnL: '$0.00',
    },
    positions: [
      {
        code: 'AAPL.US',
        ticker: 'AAPL',
        name: 'Apple',
        assetType: 'STOCK',
        underlyingTicker: 'AAPL',
        quantity: '10',
        marketValue: '$1800.00',
        averageCost: '$170.00',
        currentPrice: '$180.00',
        todayPnL: '$10.00',
        unrealizedPnL: '$100.00',
        pnlRatio: '5.88%',
        positionRatio: '18%',
        currency: 'USD',
      },
    ],
    risk: {
      concentrationRisk: 'test',
      largestPosition: 'AAPL',
      cashRatio: '40%',
      top30Overlap: 'test',
      warnings: [],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: 'dry-run',
    },
    missingCapabilities: [],
    warnings: [],
  }
}

runLlm('Longbridge live LLM decision integration', () => {
  it('真实调用大模型并返回可解析交易 JSON', async () => {
    const account = await loadLongbridgeLiveAccountDashboard()
    const marketData = await loadLongbridgeStrategyMarketData('AAPL.US', { klineCount: 30 })
    expect(marketData.ok).toBe(true)
    if (!marketData.ok) throw new Error(marketData.reason)

    const decision = await requestLongbridgeLiveTradingDecision({ symbol: marketData.symbol, account, marketData, dataWindow })

    expect(decision.ticker).toBe('AAPL')
    expect(['HOLD', 'BUY', 'SELL_SHORT', 'SELL_TO_CLOSE']).toContain(decision.action)
    expect(decision.dataWindowUsed.kline1mBars).toBeGreaterThanOrEqual(0)
    if (decision.action !== 'HOLD' && decision.approved) {
      expect(decision.orderQuantity).toBeGreaterThan(0)
      expect(decision.limitPrice).toBeGreaterThan(0)
      expect(decision.riskAssessment).toBeTruthy()
    }
  }, 120_000)
})
