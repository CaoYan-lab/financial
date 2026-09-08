import { describe, expect, it } from 'vitest'
import { estimatePreTradeFee, mergeFeeContext } from '../api/live/liveFeeService'
import { buildLiveDecisionPrompt, parseLiveTradingDecision } from '../api/live/liveTradingDecisionService'
import { closedHongKongMarketFailureReason, openingRiskRejectionReason, orderSessionForMarket, selectOrderTypeForDecision, stockPositionsByTicker } from '../api/live/liveTradingEngine'
import { LLM_SIMULATION_UNIVERSE } from '../api/simulation/simulationUniverse'
import { buildRiskModelDescription } from '../api/trade_strategy/tradeStrategyConfigService'
import type { LiveAccountDashboardResponse, LlmDataWindowRecommendation, Position, TradeStrategyConfig } from '../shared/types'

describe('live trading guardrails', () => {
  it('实盘 prompt 明确人工确认和 REAL 费用回填', () => {
    const prompt = buildLiveDecisionPrompt(decisionInput())
    const payload = JSON.parse(prompt[1].content)

    expect(prompt[0].content).toContain('Futu REAL 实盘')
    expect(prompt[0].content).toContain('待确认队列')
    expect(payload.hardConstraints).toContain('所有非 HOLD 建议只进入待确认队列，不直接提交')
    expect(payload.hardConstraints).toContain('提交前费用为 estimated_pre_trade；成交后才通过 Futu REAL order_fee_query 回填 actual_post_trade')
    expect(payload.portfolioContext.actionSemantics.SELL_SHORT).toContain('高风险')
  })

  it('实盘 prompt 使用 USD 交易资产和可用资金，而不是 HKD 展示资产', () => {
    const prompt = buildLiveDecisionPrompt({
      ...decisionInput(),
      account: account({
        currency: 'HKD',
        totalAssets: '$666,803.21',
        cash: '$411,398.38',
        buyingPower: '$53,918.22',
        tradingCurrency: 'USD',
        totalAssetsInTradingCurrency: '$74,623.47',
        cashInTradingCurrency: '$52,494.34',
        availableFundsInTradingCurrency: '$3,439.97',
        buyingPowerInTradingCurrency: '$53,918.22',
      }),
    })
    const payload = JSON.parse(prompt[1].content)

    expect(payload.account.displayCurrency).toBe('HKD')
    expect(payload.account.tradingCurrency).toBe('USD')
    expect(payload.account.displayTotalAssets).toBe('$666,803.21')
    expect(payload.account.totalAssets).toBe('$74,623.47')
    expect(payload.account.availableFunds).toBe('$3,439.97')
    expect(payload.account.buyingPower).toBe('$53,918.22')
    expect(payload.account.tradingCurrencyContext.availableFundsUsd).toBe('$3,439.97')
    expect(payload.account.tradingCurrencyContext.buyingPowerUsd).toBe('$53,918.22')
    expect(payload.account.tradingCurrencyContext.rule).toContain('不得用 displayCurrency/HKD')
    expect(payload.account.tradingCurrencyContext.rule).toContain('判断能否买入应优先看 buyingPowerUsd')
  })

  it('Futu 港股提示词使用真实每手股数和港币购买力', () => {
    const input = {
      ...decisionInput(),
      ticker: '07747',
      account: account({
        currency: 'HKD',
        tradingCurrency: 'HKD',
        totalAssetsInTradingCurrency: 'HK$771,354.99',
        cashInTradingCurrency: 'HK$87,898.88',
        availableFundsInTradingCurrency: 'HK$87,898.88',
        buyingPowerInTradingCurrency: 'HK$87,898.88',
      }),
      allPositions: [],
      position: undefined,
      marketData: {
        ...decisionInput().marketData,
        ticker: '07747',
        lastPrice: 82.54,
        lotSize: 100,
        marketState: 'MORNING',
      },
    }
    const payload = JSON.parse(buildLiveDecisionPrompt(input)[1].content)

    expect(payload.account.tradingCurrency).toBe('HKD')
    expect(payload.account.buyingPower).toBe('HK$87,898.88')
    expect(payload.account.tradingUnit.lotSize).toBe(100)
    expect(payload.account.tradingUnit.rule).toContain('每手 100 股')
  })

  it('Futu 拒绝港股非整手开仓数量但不影响美股按股交易', () => {
    const hkInput = {
      ...decisionInput(),
      ticker: '07747',
      allPositions: [],
      position: undefined,
      marketData: {
        ...decisionInput().marketData,
        ticker: '07747',
        lotSize: 100,
      },
    }
    const blocked = parseLiveTradingDecision(
      '{"approved":true,"action":"BUY","ticker":"07747","orderQuantity":3,"limitPrice":82.54}',
      hkInput,
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('每手 100 股')

    const accepted = parseLiveTradingDecision(
      '{"approved":true,"action":"BUY","ticker":"AMD","orderQuantity":3,"limitPrice":100}',
      decisionInput(),
    )
    expect(accepted.ok).toBe(true)
    expect(accepted.orderQuantity).toBe(3)
  })

  it('实盘 prompt 不把固定百分比集中度解释为禁止加仓或强制全平', () => {
    const prompt = buildLiveDecisionPrompt({
      ...decisionInput(),
      ticker: 'TSM',
      account: account({
        totalAssetsInTradingCurrency: '$74,623.47',
        availableFundsInTradingCurrency: '$3,419.85',
      }),
      allPositions: [position('TSM', 10)],
      position: {
        ...position('TSM', 10),
        marketValue: '$4,373.00',
        currentPrice: '$437.30',
        positionRatio: '5.79%',
      },
    })
    const payload = JSON.parse(prompt[1].content)

    expect(payload.portfolioContext.concentrationRule).toContain('不是固定硬上限')
    expect(payload.portfolioContext.concentrationRule).toContain('不得因为超过某个固定百分比就自动禁止加仓')
    expect(buildRiskModelDescription('live')).toContain('不得因为持仓超过某个固定百分比就自动禁止加仓或强制 SELL_TO_CLOSE')
    expect(buildRiskModelDescription('live')).toContain('不支持卖空美股杠杆做多 ETF')
  })

  it('实盘 BUY 不会因为单票集中度 advisory 阈值被硬拦截', () => {
    const reason = openingRiskRejectionReason(
      account({ totalAssetsInTradingCurrency: '$100,000.00', buyingPowerInTradingCurrency: '$100,000.00' }),
      {
        ok: true,
        approved: true,
        action: 'BUY',
        ticker: 'TSM',
        orderQuantity: 10,
        limitPrice: 1000,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
        rawText: '{}',
      },
      1000,
      strategy({ singleNameMode: 'advisory', singleNamePct: 0.05 }),
    )

    expect(reason).toBeUndefined()
  })

  it('实盘硬拦截卖空杠杆做多 ETF，避免 Futu REAL 提交失败', () => {
    const reason = openingRiskRejectionReason(
      account({ totalAssetsInTradingCurrency: '$100,000.00', buyingPowerInTradingCurrency: '$100,000.00' }),
      {
        ok: true,
        approved: true,
        action: 'SELL_SHORT',
        ticker: 'MULL',
        orderQuantity: 2,
        limitPrice: 850,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
        rawText: '{}',
      },
      850,
      strategy({ singleNameMode: 'advisory', singleNamePct: 0.5, shortExposureMode: 'hard_block', shortExposurePct: 0.1 }),
    )

    expect(reason).toContain('不支持卖空美股杠杆做多 ETF MULL')
  })

  it('实盘仍允许正股 SELL_SHORT 走常规风控', () => {
    const reason = openingRiskRejectionReason(
      account({ totalAssetsInTradingCurrency: '$100,000.00', buyingPowerInTradingCurrency: '$100,000.00' }),
      {
        ok: true,
        approved: true,
        action: 'SELL_SHORT',
        ticker: 'AMD',
        orderQuantity: 2,
        limitPrice: 100,
        confidence: 'medium',
        reason: 'test',
        riskAssessment: 'test',
        dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
        rawText: '{}',
      },
      100,
      strategy({ singleNameMode: 'advisory', singleNamePct: 0.5, shortExposureMode: 'hard_block', shortExposurePct: 0.1 }),
    )

    expect(reason).toBeUndefined()
  })

  it('实盘允许港股杠杆产品 SELL_SHORT，不套用美股杠杆 ETF 卖空限制', () => {
    for (const ticker of ['07709', '07747']) {
      const reason = openingRiskRejectionReason(
        account({ totalAssetsInTradingCurrency: '$100,000.00', buyingPowerInTradingCurrency: '$100,000.00' }),
        {
          ok: true,
          approved: true,
          action: 'SELL_SHORT',
          ticker,
          orderQuantity: 100,
          limitPrice: 10,
          confidence: 'medium',
          reason: 'test',
          riskAssessment: 'test',
          dataWindowUsed: { kline1mBars: 120, tickerPoints: 240, orderBookDepth: 5 },
          rawText: '{}',
        },
        10,
        strategy({ singleNameMode: 'advisory', singleNamePct: 0.5, shortExposureMode: 'hard_block', shortExposurePct: 0.1 }),
        100,
      )

      expect(reason).toBeUndefined()
    }
  })

  it('解析实盘 SELL_SHORT 决策但只作为候选建议', () => {
    const decision = parseLiveTradingDecision(
      '{"approved":true,"action":"SELL_SHORT","ticker":"AMD","orderQuantity":10,"limitPrice":100,"confidence":"medium","reason":"仅进入待确认队列","riskAssessment":"卖空保证金风险","dataWindowUsed":{"kline1mBars":120,"tickerPoints":240,"orderBookDepth":5}}',
      decisionInput(),
    )

    expect(decision.ok).toBe(true)
    expect(decision.action).toBe('SELL_SHORT')
    expect(decision.orderQuantity).toBe(10)
    expect(decision.reason).toContain('待确认')
  })

  it('实盘 prompt 不把卖空 PUT 误解为正股空头', () => {
    const input = {
      ...decisionInput(),
      ticker: 'MU',
      account: { ...account(), positions: [optionPosition('MU', -1, 'PUT')] },
      allPositions: [optionPosition('MU', -1, 'PUT')],
      position: undefined,
    }
    const prompt = buildLiveDecisionPrompt(input)
    const payload = JSON.parse(prompt[1].content)
    const option = payload.account.positions[0]

    expect(payload.portfolioContext.targetExposure.exposureSide).toBe('FLAT')
    expect(payload.portfolioContext.derivativePositionRule).toContain('SHORT_PUT')
    expect(option.assetType).toBe('OPTION')
    expect(option.optionPositionType).toBe('SHORT_PUT')
    expect(option.underlyingDirectionalExposure).toBe('BULLISH')
    expect(option.interpretation).toContain('not a direct short stock position')
  })

  it('实盘盘前盘后空头回补使用主动限价单', () => {
    expect(selectOrderTypeForDecision({ action: 'BUY' }, position('AMD', -5), 'ETH')).toBe('MARKETABLE_LIMIT')
    expect(selectOrderTypeForDecision({ action: 'BUY' }, position('AMD', -5), 'OVERNIGHT')).toBe('MARKETABLE_LIMIT')
    expect(selectOrderTypeForDecision({ action: 'BUY' }, position('AMD', -5), 'RTH')).toBe('MARKET')
  })

  it('实盘夜盘只允许策略研究，不生成真实订单时段', () => {
    expect(orderSessionForMarket({ state: 'OVERNIGHT', labelZh: '夜盘', labelEn: 'Overnight', tradable: true, allowsExtendedHours: true, updatedAt: new Date().toISOString() })).toBeUndefined()
    expect(orderSessionForMarket({ state: 'NIGHT_OPEN', labelZh: '夜盘', labelEn: 'Overnight', tradable: true, allowsExtendedHours: true, updatedAt: new Date().toISOString() })).toBeUndefined()
  })

    it('组合策略港股休市推进记录为提交失败原因', () => {
      expect(closedHongKongMarketFailureReason('07709', {
        ticker: '07709',
        code: 'HK.07709',
        state: 'CLOSED',
        labelZh: '休市',
        labelEn: 'Closed',
        tradable: false,
        allowsExtendedHours: false,
        updatedAt: new Date().toISOString(),
      })).toContain('港股休市')
      expect(closedHongKongMarketFailureReason('AMD', {
        ticker: 'AMD',
        code: 'US.AMD',
        state: 'CLOSED',
        labelZh: '休市',
        labelEn: 'Closed',
        tradable: false,
        allowsExtendedHours: false,
        updatedAt: new Date().toISOString(),
      })).toBeUndefined()
    })

  it('实盘可平仓识别兼容 Futu 将正股标记为 OTHER 的情况', () => {
    const positions = stockPositionsByTicker([
      position('TSM', 10, 'OTHER'),
      optionPosition('TSM', -1, 'PUT'),
    ])

    expect(positions.get('TSM')?.quantity).toBe('10')
    expect(positions.get('TSM')?.assetType).toBe('OTHER')
  })

  it('提交前费用为估算，真实费用可覆盖估算费用', () => {
    const estimated = estimatePreTradeFee(10, 100)
    const actual = mergeFeeContext({ orderId: '123' }, estimated, {
      source: 'actual_post_trade',
      orderId: '123',
      currency: 'USD',
      feeAmount: 1.23,
      feeDetails: [{ item: 'Commission', amount: 1.23 }],
    })

    expect(estimated.source).toBe('estimated_pre_trade')
    expect(actual.source).toBe('actual_post_trade')
    expect(actual.feeAmount).toBe(1.23)
  })
})

function decisionInput() {
  const dataWindow: LlmDataWindowRecommendation = {
    kline1mBars: 120,
    tickerPoints: 240,
    orderBookDepth: 5,
    pollIntervalSeconds: 60,
    reason: 'test',
    source: 'fallback',
  }
  return {
    ticker: 'AMD',
    universe: LLM_SIMULATION_UNIVERSE,
    account: account(),
    allPositions: [position('AMD', -5)],
    position: position('AMD', -5),
    marketData: {
      ok: true as const,
      ticker: 'AMD',
      lastPrice: 100,
      bars: Array.from({ length: 120 }, (_, index) => ({ time: `2026-06-17 10:${String(index % 60).padStart(2, '0')}:00`, open: 100, high: 101, low: 99, close: 100 })),
      tickerPoints: Array.from({ length: 240 }, (_, index) => ({ time: `2026-06-17 10:${String(index % 60).padStart(2, '0')}:00`, price: 100 })),
      asks: [{ price: '$100.01', size: '100', depth: 1 }],
      bids: [{ price: '$99.99', size: '100', depth: 1 }],
      bestAsk: 100.01,
      bestBid: 99.99,
      marketState: 'PRE_MARKET_BEGIN',
      updatedAt: '2026-06-17T10:00:00.000Z',
    },
    dataWindow,
    riskModel: 'live risk model',
  }
}

function account(summaryOverrides: Partial<LiveAccountDashboardResponse['summary']> = {}): LiveAccountDashboardResponse {
  return {
    ok: true,
    selectedAccountId: '123456',
    summary: {
      accountId: '123456',
      currency: 'USD',
      totalAssets: '$100,000.00',
      cash: '$50,000.00',
      availableFunds: '$50,000.00',
      buyingPower: '$50,000.00',
      tradingCurrency: 'USD',
      totalAssetsInTradingCurrency: '$100,000.00',
      cashInTradingCurrency: '$50,000.00',
      availableFundsInTradingCurrency: '$50,000.00',
      buyingPowerInTradingCurrency: '$50,000.00',
      dailyPnL: '$0.00',
      totalPnL: '$0.00',
      source: { source: 'test', accessedAt: '2026-06-17T10:00:00.000Z', timestamp: '2026-06-17T10:00:00.000Z' },
      ...summaryOverrides,
    },
    positions: [position('AMD', -5)],
    risk: {
      concentrationRisk: 'unavailable',
      largestPosition: 'AMD',
      cashRatio: 'unavailable',
      top30Overlap: 'unavailable',
      warnings: [],
    },
    trading: {
      environment: 'REAL',
      liveTradingEnabled: false,
      requiresConfirmation: true,
      warning: 'test',
    },
    missingCapabilities: [],
    warnings: [],
  }
}

function position(ticker: string, quantity: number, assetType: Position['assetType'] = 'STOCK'): Position {
  return {
    code: `US.${ticker}`,
    ticker,
    name: ticker,
    assetType,
    underlyingTicker: ticker,
    quantity: String(quantity),
    marketValue: '$500.00',
    averageCost: '$100.00',
    currentPrice: '$100.00',
    todayPnL: '$0.00',
    unrealizedPnL: '$0.00',
    pnlRatio: '0.00%',
    positionRatio: '1.00%',
    currency: 'USD',
  }
}

function optionPosition(underlyingTicker: string, quantity: number, optionType: 'PUT' | 'CALL'): Position {
  return {
    code: `US.${underlyingTicker}260117${optionType === 'PUT' ? 'P' : 'C'}00090000`,
    ticker: `${underlyingTicker}260117${optionType === 'PUT' ? 'P' : 'C'}00090000`,
    name: `${underlyingTicker} ${optionType}`,
    assetType: 'OPTION',
    underlyingTicker,
    optionType,
    strike: '$90.00',
    expirationDate: '2026-01-17',
    contractSummary: `${underlyingTicker} 2026-01-17 ${optionType} $90.00`,
    quantity: String(quantity),
    marketValue: '$500.00',
    averageCost: '$5.00',
    currentPrice: '$5.00',
    todayPnL: '$0.00',
    unrealizedPnL: '$0.00',
    pnlRatio: '0.00%',
    positionRatio: '1.00%',
    currency: 'USD',
  }
}

function strategy({
  singleNameMode,
  singleNamePct,
  shortExposureMode = 'hard_block',
  shortExposurePct = 0.03,
}: {
  singleNameMode: TradeStrategyConfig['riskControls']['singleNameExposure']['mode']
  singleNamePct: number
  shortExposureMode?: NonNullable<TradeStrategyConfig['riskControls']['shortExposure']>['mode']
  shortExposurePct?: number
}): TradeStrategyConfig {
  return {
    id: 'test_strategy',
    version: 1,
    label: 'test strategy',
    summary: 'test',
    enabledFor: ['live'],
    riskControls: {
      minNotional: { amount: 0, mode: 'warning' },
      singleNameExposure: { maxPctEquity: singleNamePct, mode: singleNameMode },
      shortExposure: { maxSingleNamePctEquity: shortExposurePct, mode: shortExposureMode },
      buyingPowerProtection: { maxPctBuyingPower: 0.95, mode: 'hard_block' },
      feeDrag: { maxRoundTripFeePctNotional: 0.02, mode: 'hard_block' },
    },
  }
}
