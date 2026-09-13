import { createHash } from 'node:crypto'
import { attachCandidateEvidence, validateCandidateEvidence } from './candidateEvidence.mjs'

const now = '2026-09-10T14:30:00.000Z'
const validUntil = '2026-09-10T14:32:00.000Z'
const money = (value, currency = 'USD') => ({ value, currency, asOf: now })

function base(broker) {
  const instrument = { ticker: 'AAPL', symbol: broker === 'futu' ? 'US.AAPL' : 'AAPL.US', market: 'US', currency: 'USD', assetType: 'STOCK', lotSize: 1, tickSize: 0.01, shortable: true }
  const bars = Array.from({ length: 30 }, (_, i) => ({
    time: new Date(Date.parse(now) - (29 - i) * 60_000).toISOString(),
    open: +(98.5 + i * 0.05).toFixed(2), close: +(98.55 + i * 0.05).toFixed(2),
    high: +(98.6 + i * 0.05).toFixed(2), low: +(98.45 + i * 0.05).toFixed(2), volume: 50000 + i * 1000,
  }))
  const status = () => ({ valid: true, sourceAt: now, receivedAt: now, maxAgeSeconds: 60 })
  return {
    synthetic: true,
    schemaVersion: 'shadow-facts-v2.4',
    runtime: { broker, mode: 'RESEARCH', decisionAt: now, allowedActions: ['HOLD', 'BUY', 'SELL_SHORT', 'SELL_TO_CLOSE'], policyVersion: 'shadow-policy-2', maxValidUntil: validUntil, constraints: { maxPromotedOrdersPerReview: 2, minSignalConfirmations: 1, leveragedEtfCooldownMinutes: 5, sameGroupMutualExclusion: false, humanConfirmationRequired: false } },
    instrument,
    dataQuality: { account: status(), positions: status(), quote: status(), trend: status(), orders: status() },
    account: {
      money: { equity: money(10000), cash: money(10000), availableFunds: money(10000), buyingPower: money(20000) },
      financingRisk: {
        broker, rawLevel: broker === 'longbridge' ? 0 : null, level: broker === 'longbridge' ? 0 : null,
        label: '安全', valid: true, openingAllowed: true, initialMargin: money(0), maintenanceMargin: money(0), marginCall: money(0),
      },
      directPositions: [], derivativeExposure: [],
    },
    riskPolicy: { perTradeLossBudget: 50, maxOpeningNotional: 1000, maxOrderQuantity: 10, buyingPowerProtection: 0.95, allowReversal: false, allowScalp: false, blockOpeningWhenCashNegative: true, maxPriceDriftPct: 1, maxValidUntil: validUntil, currency: 'USD', requiredEventCoverage: false, cancelOpeningOnRiskUnknown: false },
    riskState: { openingRiskStatus: 'ALLOWED', availableRiskBudget: 80, reservedRisk: 0, requiresRefresh: false },
    costContext: { valid: true, currency: 'USD', roundTripFeePerShare: 0.1, exitFeePerShare: 0.05, slippageStressPerShare: 0.1, financingCostPerShare: 0, borrowCostPerShare: 0.05, assumptions: '合成预算模型，非真实券商报价；数量1至10股均适用。退出只计未来单边费用与滑点，不重复计入已付费用。' },
    eventContext: { available: true, knownEvents: [], scope: '合成场景覆盖当前时点至计划持有结束；非真实新闻' },
    marketData: {
      ticker: 'AAPL', symbol: instrument.symbol, marketState: 'RTH', lastPrice: 100,
      bestAsk: 100.01, bestBid: 99.99, recentKlineBars: bars,
      recentTickerPoints: [{ time: now, price: 100 }],
      asks: [{ price: '100.01', size: '10000', depth: 1 }], bids: [{ price: '99.99', size: '10000', depth: 1 }],
      updatedAt: now, warnings: [],
      trendContext: { ticker: 'AAPL', window: { available: true, lookbackTradingDays: 7, barInterval: '30m', source: 'synthetic', actualTradingDays: 7, barCount: 91 }, currentPrice: 100, sevenDayLow: 92, sevenDayHigh: 101, trendDirection: 'UP', trendStrength: 'STRONG', volatilityLevel: 'LOW', movingAverages: { short: 99.5, medium: 98, long: 96 }, supportLevels: [98], resistanceLevels: [104], summary: '合成场景：七个交易日上涨，价格突破99.5，近三根收盘站稳，成交量为此前均值1.5倍。', updatedAt: now },
      setup: { purpose: 'NEW_POSITION', referenceEntry: 100, invalidationPrice: 98, invalidationDirection: 'BELOW', evidence: '98为输入支撑位，跌破则突破假设失效', targetPrice: 104, maxHoldingUntil: '2026-09-10T19:00:00.000Z' },
    },
    portfolioContext: { orders: [], relationshipData: { available: true, groups: { AAPL: 'technology', MSFT: 'technology' }, correlation: null } },
  }
}

const position = (quantity) => ({ ticker: 'AAPL', assetType: 'STOCK', quantity, availableToClose: Math.abs(quantity), averageCost: quantity > 0 ? 104 : 98, currentPrice: 100, marketValue: quantity * 100, unrealizedPnL: quantity > 0 ? -40 : -20, currency: 'USD' })
const order = (effect = 'OPEN_LONG') => ({
  orderId: 'shadow-order-1', ticker: 'AAPL', positionEffect: effect, side: effect === 'REDUCE_LONG' ? 'SELL_TO_CLOSE' : 'BUY',
  orderType: 'LIMIT', status: 'NEW', stage: 'BROKER_OPEN', submittedQuantity: 10, executedQuantity: 0, remainingQuantity: 10,
  submittedPrice: 100, submittedAt: now, statusAt: now, cancellable: true, reservedRisk: 22,
})
const candidate = (id, ticker) => ({
  candidateId: id, riskPlanId: `plan-${id}`, ticker, action: 'BUY', positionEffect: 'OPEN_LONG',
  groupKey: 'technology', riskTags: [], firstSeenAt: now, lastSeenAt: now, signalCount: 2,
  firstSignalPrice: 100, latestSignalPrice: 100, latestMarketPrice: 100, priceDriftPct: 0,
  proposedQuantity: 10, proposedNotional: 1000, currency: 'USD', confidence: 'high', recentReasons: ['突破后连续收盘确认，成本已估算，趋势向上。'],
  riskBudgetUsed: 22, openingAllowed: true, validUntil, costEstimate: 2, evidence: ['marketData.trendContext'], counterEvidence: ['同组风险相关，不能视为完全分散'],
})

// Expectations stay outside model input. These are policy labels, not realized P&L.
export function createScenarios() {
  const result = []
  for (const broker of ['longbridge', 'futu']) {
    const add = (name, role, category, mutate, oracle = {}) => {
      const facts = base(broker)
      const id = `${broker}-${name}`
      facts.contextId = createHash('sha256').update(`shadow-context:${id}`).digest('hex').slice(0, 20)
      mutate(facts)
      finalizeFacts(facts)
      validateFacts(facts)
      result.push({ id, broker, role, category, facts, oracle: { ...oracle } })
    }
    add('financing-warning', 'single', 'blocked', f => {
      Object.assign(f.account.financingRisk, { rawLevel: broker === 'longbridge' ? 2 : null, level: broker === 'longbridge' ? 2 : null, label: '预警', openingAllowed: false })
      f.account.financingRisk.marginCall = money(100)
      f.riskState.openingRiskStatus = 'BLOCKED'
    }, { allowedActions: ['HOLD'] })
    add('account-stale', 'single', 'blocked', f => {
      f.dataQuality.account = { valid: false, sourceAt: '2026-09-10T12:00:00.000Z', receivedAt: now, maxAgeSeconds: 60 }
      f.riskState.openingRiskStatus = 'UNKNOWN'
      f.account.financingRisk.valid = false
    }, { allowedActions: ['HOLD'] })
    add('negative-net-edge', 'single', 'blocked', f => {
      f.marketData.setup.targetPrice = 100.15
      f.marketData.trendContext.resistanceLevels = [100.15]
      f.costContext.roundTripFeePerShare = 0.2
      f.costContext.slippageStressPerShare = 0.1
      f.marketData.trendContext.summary += ' 上方100.15阻力明确；场景未提供突破该阻力的证据。'
    }, { allowedActions: ['HOLD'] })
    add('budget-exhausted', 'single', 'blocked', f => {
      f.riskState.availableRiskBudget = 0
      f.riskState.reservedRisk = 80
    }, { allowedActions: ['HOLD'] })
    add('existing-pending', 'single', 'blocked', f => {
      f.portfolioContext.orders = [{ ...order(), stage: 'PENDING_CONFIRMATION', status: 'PENDING_CONFIRMATION' }]
    }, { allowedActions: ['HOLD'] })
    add('noise-only', 'single', 'blocked', f => {
      f.marketData.trendContext = { ...f.marketData.trendContext, trendDirection: 'SIDEWAYS', trendStrength: 'WEAK', movingAverages: { short: 100, medium: 100, long: 100 }, summary: '区间震荡；无突破，无反转确认，仅最后一分钟上涨0.05%，没有独立方向依据。' }
      f.marketData.recentKlineBars = f.marketData.recentKlineBars.map((b, i) => ({ ...b, open: 99.95, close: i % 2 ? 100 : 99.95, high: 100.1, low: 99.9, volume: 50000 }))
      f.marketData.setup = { ...f.marketData.setup, evidence: '尚无入场确认；支撑阻力不构成方向信号。' }
    }, { allowedActions: ['HOLD'] })
    add('qualified-long', 'single', 'opportunity', () => {}, { allowedActions: ['HOLD', 'BUY'], desiredAction: 'BUY', maxQuantity: 10 })
    add('hk-insufficient-lot', 'single', 'blocked', f => {
      f.instrument = { ...f.instrument, ticker: '00700', symbol: broker === 'futu' ? 'HK.00700' : '700.HK', market: 'HK', currency: 'HKD', lotSize: 100 }
      f.marketData.ticker = '00700'; f.marketData.symbol = f.instrument.symbol; f.marketData.marketState = 'MORNING'
      f.marketData.trendContext.ticker = '00700'
      const shiftTimes = value => {
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item)) value[key] = new Date(Date.parse(item) - 12 * 3600_000).toISOString()
          else if (item && typeof item === 'object') shiftTimes(item)
        }
      }
      shiftTimes(f)
      f.riskPolicy.currency = 'HKD'; f.costContext.currency = 'HKD'
      f.portfolioContext.relationshipData.groups = { '00700': 'technology' }
      for (const v of Object.values(f.account.money)) v.currency = 'HKD'
      for (const key of ['initialMargin', 'maintenanceMargin', 'marginCall']) f.account.financingRisk[key].currency = 'HKD'
    }, { allowedActions: ['HOLD'] })
    add('required-reduction', 'single', 'reduction', f => {
      f.account.directPositions = [position(10)]
      f.account.financingRisk.openingAllowed = false
      f.riskState.openingRiskStatus = 'BLOCKED'
      f.marketData.trendContext = { ...f.marketData.trendContext, sevenDayHigh: 108, trendDirection: 'DOWN', trendStrength: 'STRONG', summary: '七日从108附近下行，原多头失效价102已跌破至100；此前下跌放量，最近30分钟从98.5反弹至100但未收复102。', supportLevels: [95], resistanceLevels: [102], movingAverages: { short: 100.5, medium: 102, long: 104 } }
      f.marketData.setup = { ...f.marketData.setup, purpose: 'EXISTING_POSITION', referenceEntry: 104, evidence: '原多头失效价102已向下跌破，未收复；当前不提供新开仓信号。', invalidationPrice: 102, targetPrice: null }
    }, { allowedActions: ['HOLD', 'SELL_TO_CLOSE'], desiredAction: 'SELL_TO_CLOSE', maxQuantity: 10 })
    add('short-cover-zero-bp', 'single', 'reduction', f => {
      f.account.directPositions = [position(-10)]
      f.account.money.buyingPower = money(0)
      f.account.financingRisk.openingAllowed = false
      f.riskState.openingRiskStatus = 'BLOCKED'
      f.marketData.setup = { ...f.marketData.setup, purpose: 'EXISTING_POSITION', referenceEntry: 98, invalidationPrice: 99, invalidationDirection: 'ABOVE', targetPrice: null, evidence: '现有空头原失效价99已被向上突破至100；这是原空头退出条件，不是新开多头的止损价。' }
    }, { allowedActions: ['HOLD', 'BUY'], desiredAction: 'BUY', maxQuantity: 10 })
    add('aggregate-budget', 'portfolio', 'blocked', f => {
      // Reverse input order so a stable tie-break cannot pass by taking the first item.
      f.candidatePool = [candidate('c2', 'MSFT'), candidate('c1', 'AAPL')]
      f.riskState.availableRiskBudget = 30
    }, { maxPromoted: 1, expectedPromotedIds: ['c1'] })
    add('pending-replacement', 'portfolio', 'blocked', f => {
      f.candidatePool = [candidate('c1', 'AAPL')]
      f.portfolioContext.orders = [{ ...order(), stage: 'PENDING_CONFIRMATION', status: 'PENDING_CONFIRMATION' }]
    }, { maxPromoted: 0 })
    add('qualified-candidate', 'portfolio', 'opportunity', f => {
      f.candidatePool = [candidate('c1', 'AAPL')]
    }, { maxPromoted: 1, desiredPromoted: 1 })
    add('cancel-risk-opening', 'managed', 'risk_cancel', f => {
      f.portfolioContext.orders = [order()]
      f.riskState.openingRiskStatus = 'BLOCKED'
      f.account.financingRisk.openingAllowed = false
      f.account.financingRisk.marginCall = money(100)
      f.dataQuality.quote.valid = false
    }, { desiredAction: 'CANCEL' })
    add('keep-protective', 'managed', 'protective', f => {
      f.account.directPositions = [position(10)]
      f.portfolioContext.orders = [order('REDUCE_LONG')]
      f.riskState.openingRiskStatus = 'BLOCKED'
      f.account.financingRisk.openingAllowed = false
    }, { desiredAction: 'KEEP' })
    add('unknown-order-status', 'managed', 'protective', f => {
      f.portfolioContext.orders = [{ ...order(), status: 'UNKNOWN', cancellable: null }]
      f.dataQuality.orders.valid = false
      f.riskState.openingRiskStatus = 'BLOCKED'
    }, { desiredAction: 'KEEP' })
  }
  return result
}

function finalizeFacts(f) {
  attachCandidateEvidence(f)
  const marketValue = f.account.directPositions.reduce((sum, p) => sum + p.marketValue, 0)
  f.account.money.cash.value = f.account.money.equity.value - marketValue
  if (marketValue) {
    f.account.financingRisk.initialMargin.value = Math.abs(marketValue) * 0.5
    f.account.financingRisk.maintenanceMargin.value = Math.abs(marketValue) * 0.3
  }
  f.riskState.reason = f.riskState.openingRiskStatus === 'BLOCKED'
    ? f.account.financingRisk.marginCall.value > 0 ? '保证金追缴，禁止开仓' : '后端处于仅减仓模式，非券商原始风险等级变化'
    : f.riskState.openingRiskStatus === 'UNKNOWN' ? '账户风险数据过期待核验' : '允许按预算评估开仓'
  f.riskState.reservedRisk = Math.max(f.riskState.reservedRisk, f.portfolioContext.orders.reduce((sum, o) => sum + o.reservedRisk, 0))
  f.riskState.availableRiskBudget = Math.min(f.riskState.availableRiskBudget, 80 - f.riskState.reservedRisk)
  if (!f.dataQuality.account.valid) {
    for (const value of Object.values(f.account.money)) value.asOf = f.dataQuality.account.sourceAt
  }
  if (!f.dataQuality.quote.valid) {
    const stale = new Date(Date.parse(f.runtime.decisionAt) - 120_000).toISOString()
    f.dataQuality.quote.sourceAt = stale
    f.marketData.updatedAt = stale
    f.marketData.recentTickerPoints.forEach(p => { p.time = stale })
    f.marketData.recentKlineBars.forEach(b => { b.time = new Date(Date.parse(b.time) - 120_000).toISOString() })
  }
  if (!f.dataQuality.orders.valid) {
    f.dataQuality.orders.sourceAt = new Date(Date.parse(f.runtime.decisionAt) - 120_000).toISOString()
    f.portfolioContext.orders.forEach(o => { o.statusAt = f.dataQuality.orders.sourceAt })
  }
}

export function validateFacts(f) {
  validateCandidateEvidence(f)
  const fail = reason => { throw new Error(`Inconsistent synthetic facts: ${reason}`) }
  const positions = f.account.directPositions
  const value = positions.reduce((sum, p) => sum + p.marketValue, 0)
  if (f.account.money.cash.value + value !== f.account.money.equity.value) fail('account reconciliation')
  for (const p of positions) {
    if (p.quantity * p.currentPrice !== p.marketValue || p.quantity * (p.currentPrice - p.averageCost) !== p.unrealizedPnL) fail('position reconciliation')
    if (p.availableToClose > Math.abs(p.quantity)) fail('close quantity')
  }
  const setup = f.marketData.setup
  if (setup.purpose === 'EXISTING_POSITION') {
    const p = positions[0]
    if (!p || setup.referenceEntry !== p.averageCost || !setup.evidence.includes(String(setup.invalidationPrice))) fail('position setup')
    if (p.quantity < 0 && (setup.invalidationDirection !== 'ABOVE' || setup.invalidationPrice <= p.averageCost)) fail('short stop direction')
    if (p.quantity > 0 && (setup.invalidationDirection !== 'BELOW' || setup.invalidationPrice >= p.averageCost)) fail('long stop direction')
  }
  const trend = f.marketData.trendContext
  for (const average of Object.values(trend.movingAverages)) {
    if (average < trend.sevenDayLow || average > trend.sevenDayHigh) fail('moving average outside window range')
  }
  if (f.marketData.recentKlineBars.at(-1).close !== f.marketData.lastPrice) fail('last quote versus bar')
  for (const [key, status] of Object.entries(f.dataQuality)) {
    const age = (Date.parse(f.runtime.decisionAt) - Date.parse(status.sourceAt)) / 1000
    if (age < 0 || (status.valid && age > status.maxAgeSeconds)) fail(`${key} freshness`)
  }
  if (f.riskState.availableRiskBudget + f.riskState.reservedRisk > 80) fail('risk ledger')
  for (const item of Object.values(f.account.money)) if (item.currency !== f.instrument.currency) fail('currency')
}

export function legacyInputs(scenario) {
  const f = scenario.facts
  const dollars = (v) => `${f.instrument.currency === 'HKD' ? 'HK$' : '$'}${v}`
  const positions = f.account.directPositions.map(p => ({
    ...p, code: p.ticker, quantity: String(p.quantity), marketValue: dollars(p.marketValue), currentPrice: dollars(p.currentPrice),
    averageCost: dollars(p.averageCost),
    unrealizedPnL: dollars(p.unrealizedPnL), todayPnL: '$0', positionSide: p.quantity < 0 ? 'SHORT' : 'LONG',
  }))
  const a = f.account.money
  const financing = f.account.financingRisk
  const account = {
    ok: f.dataQuality.account.valid, selectedAccountId: 'synthetic-account',
    summary: {
      currency: f.instrument.currency, tradingCurrency: f.instrument.currency,
      totalAssets: dollars(a.equity.value), cash: dollars(a.cash.value),
      availableFunds: dollars(a.availableFunds.value), buyingPower: dollars(a.buyingPower.value),
      ...(scenario.broker === 'longbridge' ? {
        financingRiskLevel: financing.valid ? financing.level : undefined,
        financingRiskLabel: financing.label, financingOpeningRestricted: !financing.openingAllowed,
        initialMargin: dollars(financing.initialMargin.value), maintenanceMargin: dollars(financing.maintenanceMargin.value), marginCall: dollars(financing.marginCall.value),
      } : {}),
    },
    positions, warnings: [],
  }
  const marketData = { ...f.marketData, ok: true, source: scenario.broker === 'longbridge' ? 'longbridge-sdk-cache' : 'futu', bars: f.marketData.recentKlineBars, tickerPoints: f.marketData.recentTickerPoints, lotSize: f.instrument.lotSize }
  const managedOrders = f.portfolioContext.orders.filter(o => o.stage === 'BROKER_OPEN').map(o => ({ ...o, platform: scenario.broker }))
  return {
    single: {
      symbol: f.instrument.symbol, ticker: f.instrument.ticker, account, marketData,
      universe: [{ ticker: f.instrument.ticker, name: '合成测试标的', market: f.instrument.market, assetType: 'STOCK', tradingCurrency: f.instrument.currency }],
      position: positions[0], allPositions: positions, dataWindow: { kline1mBars: 30, tickerPoints: 1, orderBookDepth: 1 },
      trendContext: f.marketData.trendContext, managedOpenOrders: managedOrders,
      riskModel: '购买力保护95%；费用拖累不高于2%；单票集中度不是自动平仓理由。',
    },
    portfolio: { candidates: f.candidatePool ?? [], account, positions, pendingOrders: f.portfolioContext.orders.map(o => ({ id: o.orderId, ticker: o.ticker, side: o.side, createdAt: o.submittedAt })), constraints: f.runtime.constraints },
    managed: { platform: scenario.broker, orders: managedOrders.map(o => ({ order: o, account: { totalAssets: account.summary.totalAssets, buyingPower: account.summary.buyingPower, positions }, marketData: f.dataQuality.quote.valid ? marketData : { ok: false, reason: '报价过期' } })) },
  }
}
