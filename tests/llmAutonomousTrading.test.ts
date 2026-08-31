import { describe, expect, it } from 'vitest'
import { realtimeStore } from '../api/realtime/realtimeStore'
import { buildPositionFeeContext } from '../api/simulation/feeContextService'
import { parseRecommendation } from '../api/simulation/llmDataWindowAdvisor'
import { buildDecisionPrompt, parseTradingDecision } from '../api/simulation/llmTradingDecisionService'
import { loadStrategyMarketData } from '../api/simulation/realtimeDataAdapter'
import { selectOrderTypeForDecision } from '../api/simulation/simulationTradingEngine'
import { LLM_SIMULATION_UNIVERSE, isInLlmSimulationUniverse, llmSimulationTickers } from '../api/simulation/simulationUniverse'
import { buildTrendContextSummary } from '../api/simulation/trendContextService'
import type { LlmDataWindowRecommendation, Position, RealtimeBar, SimulationAccountDashboardResponse } from '../shared/types'

describe('llm autonomous simulation trading', () => {
  it('使用用户指定的大模型模拟盘正股/ETF票池', () => {
    expect(llmSimulationTickers()).toEqual([
      'MU',
      'MULL',
      'NVDA',
      'AMD',
      'AMDL',
      'INTC',
      'INTW',
      'GOOG',
      'AAPL',
      'TSM',
      'TSMU',
      'TSLA',
      'SPCX',
      'SPCU',
      'SNDK',
      'SNDU',
      'TQQQ',
      '09660',
      '07709',
      '07747',
    ])
    expect(isInLlmSimulationUniverse('GOOG')).toBe(true)
    expect(isInLlmSimulationUniverse('TQQQ')).toBe(true)
    expect(isInLlmSimulationUniverse('MULL')).toBe(true)
    expect(isInLlmSimulationUniverse('SPCU')).toBe(true)
    expect(isInLlmSimulationUniverse('SPAL')).toBe(false)
    expect(isInLlmSimulationUniverse('09660')).toBe(true)
    expect(isInLlmSimulationUniverse('07709')).toBe(true)
    expect(isInLlmSimulationUniverse('07747')).toBe(true)
    expect(isInLlmSimulationUniverse('AMD')).toBe(true)
    expect(isInLlmSimulationUniverse('INTC')).toBe(true)
    expect(isInLlmSimulationUniverse('MSFT')).toBe(false)
  })

  it('解析并裁剪大模型数据窗口建议', () => {
    const recommendation = parseRecommendation('{"kline1mBars":999,"tickerPoints":10,"orderBookDepth":20,"pollIntervalSeconds":5,"reason":"test"}')
    expect(recommendation.kline1mBars).toBe(240)
    expect(recommendation.tickerPoints).toBe(60)
    expect(recommendation.orderBookDepth).toBe(10)
    expect(recommendation.pollIntervalSeconds).toBe(30)
    expect(recommendation.trendLookbackTradingDays).toBe(7)
    expect(recommendation.trendBarInterval).toBe('30m')
    expect(recommendation.strategyHorizon).toBe('SWING_1_TO_7_DAYS')
    expect(recommendation.source).toBe('llm')
  })

  it('按当前实时缓存可用性裁剪大模型数据窗口建议', () => {
    const recommendation = parseRecommendation('{"kline1mBars":120,"tickerPoints":500,"orderBookDepth":10,"pollIntervalSeconds":60,"reason":"test"}', {
      minKline1mBars: 45,
      minTickerPoints: 300,
      minOrderBookDepth: 5,
    })

    expect(recommendation.kline1mBars).toBe(45)
    expect(recommendation.tickerPoints).toBe(300)
    expect(recommendation.orderBookDepth).toBe(5)
  })

  it('解析大模型交易决策 JSON', () => {
    const input = decisionInput()
    const decision = parseTradingDecision(
      '{"approved":true,"action":"BUY","ticker":"GOOG","orderQuantity":3,"limitPrice":100.5,"confidence":"medium","reason":"分时走强","riskAssessment":"控制仓位","dataWindowUsed":{"kline1mBars":120,"tickerPoints":240,"orderBookDepth":5}}',
      input,
    )

    expect(decision.ok).toBe(true)
    expect(decision.approved).toBe(true)
    expect(decision.action).toBe('BUY')
    expect(decision.orderQuantity).toBe(3)
    expect(decision.trendAlignment).toBe('UNAVAILABLE')
    expect(decision.tradeHorizon).toBe('INTRADAY')
    expect(decision.whyNotNoise).toContain('未说明')
  })

  it('模型返回目标 ticker 不一致时默认阻断', () => {
    const decision = parseTradingDecision('{"approved":true,"action":"BUY","ticker":"MSFT","orderQuantity":3,"limitPrice":100}', decisionInput())
    expect(decision.ok).toBe(false)
    expect(decision.approved).toBe(false)
    expect(decision.action).toBe('HOLD')
  })

  it('兼容解析旧 quantity 字段为 orderQuantity', () => {
    const decision = parseTradingDecision('{"approved":true,"action":"BUY","ticker":"GOOG","quantity":2,"limitPrice":100}', decisionInput())
    expect(decision.ok).toBe(true)
    expect(decision.orderQuantity).toBe(2)
  })

  it('允许大模型返回 SIMULATE 正股卖空决策', () => {
    const decision = parseTradingDecision(
      '{"approved":true,"action":"SELL_SHORT","ticker":"GOOG","orderQuantity":5,"limitPrice":99.5,"confidence":"medium","reason":"弱势下破","riskAssessment":"控制卖空仓位","dataWindowUsed":{"kline1mBars":120,"tickerPoints":240,"orderBookDepth":5}}',
      decisionInput(),
    )
    expect(decision.ok).toBe(true)
    expect(decision.approved).toBe(true)
    expect(decision.action).toBe('SELL_SHORT')
    expect(decision.orderQuantity).toBe(5)
  })

  it('交易决策 prompt 包含 K 线、分时、摆盘、账户和费用模型', () => {
    const prompt = buildDecisionPrompt(decisionInput())
    const payload = JSON.parse(prompt[1].content)
    expect(payload.universe).toHaveLength(20)
    expect(payload.universe.find((item: { ticker: string }) => item.ticker === 'TQQQ')?.assetType).toBe('ETF')
    expect(payload.universe.find((item: { ticker: string }) => item.ticker === 'MULL')?.underlyingTicker).toBe('MU')
    expect(payload.universe.find((item: { ticker: string }) => item.ticker === '07709')?.market).toBe('HK')
    expect(payload.universe.find((item: { ticker: string }) => item.ticker === '07747')?.tradingCurrency).toBe('HKD')
    expect(payload.hardConstraints).toContain('只允许 HOLD、BUY、SELL_SHORT、SELL_TO_CLOSE')
    expect(payload.marketData.executionWindow.recentKlineBars).toHaveLength(30)
    expect(payload.marketData.executionWindow.recentTickerPoints).toHaveLength(2)
    expect(payload.marketData.executionWindow.asks).toHaveLength(1)
    expect(payload.marketData.trendContext.trendDirection).toBe('UP')
    expect(payload.account.totalAssets).toBe('$50,000.00')
    expect(payload.account.positions).toHaveLength(2)
    expect(payload.portfolioContext.allPositions[0].exposureSide).toBe('SHORT')
    expect(payload.portfolioContext.allPositions[0].numericPositionQuantity).toBe(-5)
    expect(payload.requiredJson.orderQuantity).toBe(0)
    expect(payload.portfolioContext.targetExposure.instruction).toContain('Do not assume no position')
    expect(payload.feeModel).toContain('fee')
    expect(payload.portfolioContext.feeContextRules.netPnLRule).toContain('estimatedNetUnrealizedPnL')
    expect(payload.currentPosition.estimatedFeeContext.source).toBe('estimated')
    expect(payload.currentPosition.estimatedFeeContext.estimatedNetUnrealizedPnL).toBeLessThan(0)
    expect(payload.requiredJson.reason).toContain('预估费用')
    expect(payload.requiredJson.trendAlignment).toContain('WITH_TREND')
    expect(payload.requiredJson.whyNotNoise).toContain('短周期噪声')
  })

  it('趋势摘要能识别上涨趋势和价格区间位置', () => {
    const summary = buildTrendContextSummary('TREND', { lookbackTradingDays: 7, barInterval: '30m', currentPrice: 126 }, risingBars(30))

    expect(summary.window.available).toBe(true)
    expect(summary.trendDirection).toBe('UP')
    expect(summary.sevenDayHigh).toBeGreaterThan(summary.sevenDayLow ?? 0)
    expect(summary.pricePositionInRange).toBeGreaterThan(0.8)
    expect(summary.summary).toContain('TREND')
  })

  it('趋势摘要在 K 线不足时返回不可用', () => {
    const summary = buildTrendContextSummary('SHORT', { lookbackTradingDays: 7, barInterval: '30m', currentPrice: 100 }, bars(3))

    expect(summary.window.available).toBe(false)
    expect(summary.trendDirection).toBe('UNKNOWN')
    expect(summary.summary).toContain('不可用')
  })

  it('持仓费用上下文识别毛浮盈为正但扣费后亏损', () => {
    const feeContext = buildPositionFeeContext({
      ...position('FEE', 1),
      averageCost: '$20,000.00',
      currentPrice: '$20,004.00',
      unrealizedPnL: '$4.00',
    })

    expect(feeContext.estimatedEntryFee).toBe(3)
    expect(feeContext.estimatedExitFee).toBe(3)
    expect(feeContext.estimatedRoundTripFee).toBe(6)
    expect(feeContext.estimatedNetUnrealizedPnL).toBe(-2)
    expect(feeContext.grossProfitButNetLoss).toBe(true)
  })

  it('行情数据不足模型窗口要求时不会进入交易决策请求', () => {
    realtimeStore.setSubscribedTickers(['STRICT'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'STRICT',
      updatedAt: '2026-06-16T10:00:00',
      quote: {
        ticker: 'STRICT',
        code: 'US.STRICT',
        name: 'Strict',
        price: '$100.00',
        change: '+$0.00',
        changePercent: '+0.00%',
        open: '$100.00',
        high: '$100.00',
        low: '$100.00',
        volume: '1000',
        updatedAt: '2026-06-16T10:00:00',
      },
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'STRICT',
      updatedAt: '2026-06-16T10:30:00',
      bars: bars(30),
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'STRICT',
      updatedAt: '2026-06-16T10:01:00',
      points: [{ time: '2026-06-16 10:00:00', price: 100 }],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: 'STRICT',
      updatedAt: '2026-06-16T10:01:00',
      asks: [{ price: '$100.10', size: '100', depth: 100 }],
      bids: [{ price: '$99.90', size: '100', depth: 100 }],
    })

    const marketData = loadStrategyMarketData('STRICT', {
      kline1mBars: 30,
      tickerPoints: 60,
      orderBookDepth: 5,
    })

    expect(marketData.ok).toBe(false)
    if (marketData.ok === false) {
      expect(marketData.reason).toContain('分时点不足：当前 30 / 要求 60')
    }
  })

  it('策略取价优先使用 Futu quote 最新价，避免被旧分时点覆盖', () => {
    realtimeStore.setSubscribedTickers(['SPCU_PRICE'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'SPCU_PRICE',
      updatedAt: '2026-06-23T12:14:46',
      quote: {
        ticker: 'SPCU_PRICE',
        code: 'US.SPCU',
        name: 'SPCU',
        price: '$18.85',
        change: '+$1.79',
        changePercent: '+10.49%',
        open: '$16.15',
        high: '$19.03',
        low: '$15.39',
        volume: '2995275',
        marketState: 'AFTERNOON',
        updatedAt: '2026-06-23T12:14:46',
      },
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'SPCU_PRICE',
      updatedAt: '2026-06-23T10:31:00',
      points: [{ time: '2026-06-23 10:31:00.000', price: 17.6 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'SPCU_PRICE',
      updatedAt: '2026-06-23T10:31:00',
      bars: [{ time: '2026-06-23 10:31:00', open: 17.5, high: 17.7, low: 17.4, close: 17.6 }],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: 'SPCU_PRICE',
      updatedAt: '2026-06-23T12:14:46',
      asks: [{ price: '$18.85', size: '100', depth: 100 }],
      bids: [{ price: '$18.80', size: '100', depth: 100 }],
    })

    const marketData = loadStrategyMarketData('SPCU_PRICE', {
      kline1mBars: 1,
      tickerPoints: 1,
      orderBookDepth: 1,
    })

    expect(marketData.ok).toBe(true)
    if (marketData.ok) expect(marketData.lastPrice).toBe(18.85)
  })

  it('策略取价按最新时间选择 quote、分时或 K 线价格', () => {
    realtimeStore.setSubscribedTickers(['SNDU_PRICE'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'SNDU_PRICE',
      updatedAt: '2026-06-24T16:03:57',
      quote: {
        ticker: 'SNDU_PRICE',
        code: 'US.SNDU',
        name: 'SNDU',
        price: '$54.40',
        change: '+$2.71',
        changePercent: '+5.24%',
        open: '$55.14',
        high: '$54.50',
        low: '$50.99',
        volume: '7264',
        marketState: 'AFTER_HOURS_BEGIN',
        updatedAt: '2026-06-24T16:03:57',
      },
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'SNDU_PRICE',
      updatedAt: '2026-06-24T16:20:00',
      points: [{ time: '2026-06-24T16:20:00', price: 51.2 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'SNDU_PRICE',
      updatedAt: '2026-06-24T16:04:00',
      bars: [{ time: '2026-06-24T16:04:00', open: 53.979, high: 54.5, low: 53.5, close: 54.4 }],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: 'SNDU_PRICE',
      updatedAt: '2026-06-24T16:20:00',
      asks: [{ price: '$51.25', size: '100', depth: 100 }],
      bids: [{ price: '$51.15', size: '100', depth: 100 }],
    })

    const marketData = loadStrategyMarketData('SNDU_PRICE', {
      kline1mBars: 1,
      tickerPoints: 1,
      orderBookDepth: 1,
    })

    expect(marketData.ok).toBe(true)
    if (marketData.ok) expect(marketData.lastPrice).toBe(51.2)
  })

  it('实盘策略数据拒绝过期的 Futu 实时缓存', () => {
    realtimeStore.setSubscribedTickers(['SNDU_STALE'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'SNDU_STALE',
      updatedAt: '2026-06-24T16:03:57',
      quote: {
        ticker: 'SNDU_STALE',
        code: 'US.SNDU',
        name: 'SNDU',
        price: '$54.40',
        change: '+$2.71',
        changePercent: '+5.24%',
        open: '$55.14',
        high: '$54.50',
        low: '$50.99',
        volume: '7264',
        marketState: 'AFTER_HOURS_BEGIN',
        updatedAt: '2026-06-24T16:03:57',
      },
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'SNDU_STALE',
      updatedAt: '2026-06-24T16:03:57',
      points: [{ time: '2026-06-24T16:03:57', price: 54.4 }],
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'SNDU_STALE',
      updatedAt: '2026-06-24T16:03:57',
      bars: [{ time: '2026-06-24T16:03:00', open: 53.979, high: 54.5, low: 53.5, close: 54.4 }],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: 'SNDU_STALE',
      updatedAt: '2026-06-24T16:03:57',
      asks: [{ price: '$54.40', size: '100', depth: 100 }],
      bids: [{ price: '$54.00', size: '100', depth: 100 }],
    })

    const marketData = loadStrategyMarketData('SNDU_STALE', {
      kline1mBars: 1,
      tickerPoints: 1,
      orderBookDepth: 1,
      maxCacheAgeMs: 90_000,
      now: new Date('2026-06-24T16:20:00'),
    })

    expect(marketData.ok).toBe(false)
    if (!marketData.ok) expect(marketData.reason).toContain('Futu 实时缓存已过期')
  })

  it('策略窗口拒绝跨交易日拼接的 1 分钟 K 线，避免把旧高价误判为盘中急跌', () => {
    realtimeStore.setSubscribedTickers(['SPCU_GAP'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'SPCU_GAP',
      updatedAt: '2026-06-23T12:49:00',
      quote: {
        ticker: 'SPCU_GAP',
        code: 'US.SPCU',
        name: 'SPCU',
        price: '$18.64',
        change: '-$0.20',
        changePercent: '-1.06%',
        open: '$18.83',
        high: '$18.90',
        low: '$18.63',
        volume: '1000',
        marketState: 'AFTERNOON',
        updatedAt: '2026-06-23T12:49:00',
      },
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'SPCU_GAP',
      updatedAt: '2026-06-23T12:49:00',
      bars: [
        { time: '2026-06-18 13:02:00', open: 22.79, high: 23.04, low: 22.76, close: 23.04 },
        { time: '2026-06-18 13:03:00', open: 23.06, high: 23.25, low: 23.06, close: 23.23 },
        { time: '2026-06-23 12:48:00', open: 18.7, high: 18.7, low: 18.63, close: 18.64 },
      ],
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'SPCU_GAP',
      updatedAt: '2026-06-23T12:49:00',
      points: [
        { time: '2026-06-23 12:48:30.000', price: 18.65 },
        { time: '2026-06-23 12:49:00.000', price: 18.64 },
      ],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: 'SPCU_GAP',
      updatedAt: '2026-06-23T12:49:00',
      asks: [{ price: '$18.65', size: '100', depth: 100 }],
      bids: [{ price: '$18.63', size: '100', depth: 100 }],
    })

    const marketData = loadStrategyMarketData('SPCU_GAP', {
      kline1mBars: 2,
      tickerPoints: 2,
      orderBookDepth: 1,
    })

    expect(marketData.ok).toBe(false)
    if (!marketData.ok) {
      expect(marketData.reason).toContain('当前会话 1 分钟 K 线不足：当前 1 / 要求 2')
    }
  })

  it('美股夜盘允许使用同日常规盘和夜盘 K 线补足窗口', () => {
    realtimeStore.setSubscribedTickers(['AMZZ'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'AMZZ',
      updatedAt: '2026-06-23T21:26:00',
      quote: {
        ticker: 'AMZZ',
        code: 'US.AMZZ',
        name: 'AMZZ',
        price: '$10.10',
        change: '+$0.10',
        changePercent: '+1.00%',
        open: '$10.00',
        high: '$10.20',
        low: '$9.90',
        volume: '1000',
        marketState: 'NIGHT_OPEN',
        updatedAt: '2026-06-23T21:26:00',
      },
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'AMZZ',
      updatedAt: '2026-06-23T21:26:00',
      bars: [
        { time: '2026-06-23 15:59:00', open: 10, high: 10.1, low: 9.9, close: 10 },
        { time: '2026-06-23 21:25:00', open: 10, high: 10.2, low: 10, close: 10.1 },
      ],
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'AMZZ',
      updatedAt: '2026-06-23T21:26:00',
      points: [{ time: '2026-06-23 21:25:30.000', price: 10.1 }],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: 'AMZZ',
      updatedAt: '2026-06-23T21:26:00',
      asks: [{ price: '$10.11', size: '100', depth: 1 }],
      bids: [{ price: '$10.09', size: '100', depth: 1 }],
    })

    const marketData = loadStrategyMarketData('AMZZ', { kline1mBars: 2, tickerPoints: 2, orderBookDepth: 1 })
    expect(marketData.ok).toBe(true)
    if (marketData.ok) {
      expect(marketData.bars.map((bar) => bar.time)).toEqual(['2026-06-23 15:59:00', '2026-06-23 21:25:00'])
      expect(marketData.tickerPoints).toHaveLength(3)
    }
  })

  it('港股盘前当前日 K 线不足时允许带上最近上一交易日窗口', () => {
    realtimeStore.setSubscribedTickers(['07709'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: '07709',
      updatedAt: '2026-06-24T09:26:00+08:00',
      quote: {
        ticker: '07709',
        code: 'HK.07709',
        name: '07709',
        price: 'HK$10.10',
        change: '+HK$0.10',
        changePercent: '+1.00%',
        open: 'HK$10.00',
        high: 'HK$10.20',
        low: 'HK$9.90',
        volume: '1000',
        marketState: 'PRE_MARKET_BEGIN',
        updatedAt: '2026-06-24T09:26:00+08:00',
      },
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: '07709',
      updatedAt: '2026-06-24T09:26:00+08:00',
      bars: [
        { time: '2026-06-23 15:59:00', open: 10, high: 10.1, low: 9.9, close: 10 },
        { time: '2026-06-24 09:25:00', open: 10, high: 10.2, low: 10, close: 10.1 },
      ],
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: '07709',
      updatedAt: '2026-06-24T09:26:00+08:00',
      points: [{ time: '2026-06-24 09:25:30.000', price: 10.1 }],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: '07709',
      updatedAt: '2026-06-24T09:26:00+08:00',
      asks: [{ price: 'HK$10.11', size: '100', depth: 1 }],
      bids: [{ price: 'HK$10.09', size: '100', depth: 1 }],
    })

    const marketData = loadStrategyMarketData('07709', { kline1mBars: 2, tickerPoints: 2, orderBookDepth: 1 })
    expect(marketData.ok).toBe(true)
    if (marketData.ok) {
      expect(marketData.bars.map((bar) => bar.time)).toEqual(['2026-06-23 15:59:00', '2026-06-24 09:25:00'])
      expect(marketData.tickerPoints).toHaveLength(3)
    }
  })

  it('美股开盘初期当前日 K 线不足时允许带上最近上一交易日窗口', () => {
    realtimeStore.setSubscribedTickers(['TSM'])
    realtimeStore.applyEvent({
      kind: 'quote',
      ticker: 'TSM',
      updatedAt: '2026-06-24T09:34:00-04:00',
      quote: {
        ticker: 'TSM',
        code: 'US.TSM',
        name: 'TSM',
        price: '$225.10',
        change: '+$0.10',
        changePercent: '+0.04%',
        open: '$225.00',
        high: '$225.20',
        low: '$224.90',
        volume: '1000',
        marketState: 'NORMAL',
        updatedAt: '2026-06-24T09:34:00-04:00',
      },
    })
    realtimeStore.applyEvent({
      kind: 'kline',
      ticker: 'TSM',
      updatedAt: '2026-06-24T09:34:00-04:00',
      bars: [
        { time: '2026-06-23 15:59:00', open: 224, high: 225, low: 223, close: 224.5 },
        { time: '2026-06-24 09:33:00', open: 225, high: 225.2, low: 224.9, close: 225.1 },
      ],
    })
    realtimeStore.applyEvent({
      kind: 'ticker',
      ticker: 'TSM',
      updatedAt: '2026-06-24T09:34:00-04:00',
      points: [{ time: '2026-06-24 09:33:30.000', price: 225.1 }],
    })
    realtimeStore.applyEvent({
      kind: 'orderBook',
      ticker: 'TSM',
      updatedAt: '2026-06-24T09:34:00-04:00',
      asks: [{ price: '$225.11', size: '100', depth: 1 }],
      bids: [{ price: '$225.09', size: '100', depth: 1 }],
    })

    const marketData = loadStrategyMarketData('TSM', { kline1mBars: 2, tickerPoints: 2, orderBookDepth: 1 })
    expect(marketData.ok).toBe(true)
    if (marketData.ok) {
      expect(marketData.bars.map((bar) => bar.time)).toEqual(['2026-06-23 15:59:00', '2026-06-24 09:33:00'])
      expect(marketData.tickerPoints).toHaveLength(3)
    }
  })

  it('用户股票池内被标记为 OTHER 的空头持仓也会传给模型', () => {
    const input = {
      ...decisionInput(),
      allPositions: [position('SPCX', -63, 'OTHER'), position('BRK.B', 0, 'OTHER')],
      position: position('SPCX', -63, 'OTHER'),
      ticker: 'SPCX',
    }
    const prompt = buildDecisionPrompt(input)
    const payload = JSON.parse(prompt[1].content)

    expect(payload.account.positions).toHaveLength(1)
    expect(payload.account.positions[0].ticker).toBe('SPCX')
    expect(payload.account.positions[0].numericPositionQuantity).toBe(-63)
    expect(payload.currentPosition.exposureSide).toBe('SHORT')
    expect(payload.portfolioContext.actionSemantics.BUY).toContain('回补空头')
    expect(payload.portfolioContext.actionSemantics.BUY).toContain('buyingPower 为 0')
  })

  it('空头标的的模型理由会清理购买力回补表述', () => {
    const input = {
      ...decisionInput(),
      position: position('GOOG', -5),
    }
    const decision = parseTradingDecision(
      '{"approved":true,"action":"BUY","ticker":"GOOG","orderQuantity":2,"limitPrice":100,"confidence":"medium","reason":"购买力足以覆盖2股买入成本，因此回补2股。价格反弹风险升高。","riskAssessment":"账户购买力有限，无法大规模回补。剩余空头仍需观察。","dataWindowUsed":{"kline1mBars":30,"tickerPoints":60,"orderBookDepth":5}}',
      input,
    )

    expect(decision.action).toBe('BUY')
    expect(decision.orderQuantity).toBe(2)
    expect(decision.reason).not.toContain('购买力')
    expect(decision.riskAssessment).not.toContain('购买力')
    expect(decision.reason).toContain('买入平仓')
  })

  it('盘前盘后时段的卖空回补使用主动限价单而不是市价单', () => {
    const decision = parseTradingDecision(
      '{"approved":true,"action":"BUY","ticker":"GOOG","orderQuantity":2,"limitPrice":100,"confidence":"high","reason":"空头风险控制","riskAssessment":"买入平仓"}',
      { ...decisionInput(), position: position('GOOG', -5) },
    )

    expect(selectOrderTypeForDecision(decision, position('GOOG', -5), 'ETH')).toBe('MARKETABLE_LIMIT')
    expect(selectOrderTypeForDecision(decision, position('GOOG', -5), 'RTH')).toBe('MARKET')
  })
})

function decisionInput() {
  const dataWindow: LlmDataWindowRecommendation = {
    kline1mBars: 30,
    tickerPoints: 60,
    orderBookDepth: 5,
    pollIntervalSeconds: 60,
    trendLookbackTradingDays: 7,
    trendBarInterval: '30m',
    strategyHorizon: 'SWING_1_TO_7_DAYS',
    reason: 'test',
    source: 'fallback',
  }
  return {
    ticker: 'GOOG',
    universe: LLM_SIMULATION_UNIVERSE,
    account: account(),
    allPositions: [position('GOOG', -5), position('AAPL', 3)],
    marketData: {
      ok: true as const,
      ticker: 'GOOG',
      lastPrice: 100,
      bars: bars(30),
      tickerPoints: [
        { time: '2026-06-16 10:00:00', price: 100 },
        { time: '2026-06-16 10:01:00', price: 101 },
      ],
      asks: [{ price: '$100.10', size: '100', depth: 1 }],
      bids: [{ price: '$99.90', size: '100', depth: 1 }],
      bestAsk: 100.1,
      bestBid: 99.9,
      updatedAt: '2026-06-16T10:00:00Z',
    },
    position: position('GOOG', -5),
    dataWindow,
    trendContext: buildTrendContextSummary('GOOG', { lookbackTradingDays: 7, barInterval: '30m', currentPrice: 100 }, risingBars(30)),
    feeModel: 'test fee model',
    riskModel: 'test risk model',
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

function bars(count: number): RealtimeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-06-16 10:${String(index).padStart(2, '0')}:00`,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
  }))
}

function risingBars(count: number): RealtimeBar[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index
    return {
      time: `2026-06-16 10:${String(index).padStart(2, '0')}:00`,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.5,
    }
  })
}

function account(): SimulationAccountDashboardResponse {
  const source = { source: 'test', accessedAt: '2026-06-16T10:00:00Z', timestamp: '2026-06-16T10:00:00Z' }
  return {
    ok: true,
    accounts: [],
    selectedAccountId: '123',
    summary: {
      accountId: '123',
      currency: 'USD',
      totalAssets: '$50,000.00',
      cash: '$20,000.00',
      availableFunds: '$20,000.00',
      buyingPower: '$100,000.00',
      dailyPnL: '$0.00',
      totalPnL: '$0.00',
      source,
    },
    positions: [],
    trading: {
      environment: 'SIMULATE',
      liveTradingEnabled: false,
      requiresConfirmation: false,
      warning: 'SIMULATE only',
    },
    warnings: [],
  }
}
