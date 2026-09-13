const cents = value => Math.round(value * 100) / 100
export const rankingPolicy = {
  version: 'candidate-rank-v1',
  scope: '仅用于通过权限、证据时效、订单冲突与预算检查的开多候选；不是预测胜率或执行授权。',
  keys: [
    'netRewardRiskBps DESC', 'riskBudgetUsed ASC', 'absPriceDriftBps ASC',
    'firstSeenAt ASC', 'ticker ASCII ASC', 'candidateId ASCII ASC',
  ],
  rule: '按上述顺序逐项比较，前项不同时立即停止；完全同分才使用后一项。不按数组顺序、不按模型confidence排序，不另造优势。按排序逐笔检查剩余预算，不足则观察，不修改风险方案。',
  formula: 'risk=quantity*(entry-stop)+roundTripCost+slippageCost; netReward=quantity*(target-entry)-roundTripCost-slippageCost; netRewardRiskBps=floor(netReward/risk*10000)，不是预期收益。',
}

export function attachCandidateEvidence(facts) {
  if (!facts.candidatePool) return
  facts.portfolioContext.rankingPolicy = structuredClone(rankingPolicy)
  for (const c of facts.candidatePool) {
    const scale = c.ticker === 'AAPL' ? 1 : c.ticker === 'MSFT' ? 2 : null
    if (!scale) throw new Error('Unsupported synthetic ticker')
    const entry = 100 * scale
    const quantity = 10 / scale
    const sourceAt = facts.runtime.decisionAt
    const previous = c.ticker === 'AAPL' ? [92, 94, 93, 95, 97, 99, 100] : [183, 187, 190, 188, 194, 198, 200]
    const prices = c.ticker === 'AAPL' ? [99.4, 99.5, 99.6, 99.75, 99.9, 100] : [198.8, 199, 199.25, 199.4, 199.8, 200]
    const bars = prices.map((close, i) => ({
      time: new Date(Date.parse(sourceAt) - (5 - i) * 60000).toISOString(),
      open: i ? prices[i - 1] : cents(close - 0.1 * scale),
      close, high: cents(close + 0.05 * scale),
      low: cents((i ? prices[i - 1] : close - 0.1 * scale) - 0.05 * scale),
      volume: (c.ticker === 'AAPL' ? 60000 : 35000) + i * 1000,
    }))
    const evidence = {
      ticker: c.ticker, symbol: facts.runtime.broker === 'futu' ? `US.${c.ticker}` : `${c.ticker}.US`,
      currency: 'USD', source: `synthetic-${c.ticker}-v24`, sourceAt, receivedAt: sourceAt, valid: true, maxAgeSeconds: 60,
      quote: { ticker: c.ticker, sourceAt, lastPrice: entry, bid: cents(entry - scale * 0.01), ask: cents(entry + scale * 0.01), bidSize: 10000, askSize: 10000 },
      trend: {
        ticker: c.ticker, sourceAt, direction: 'UP',
        window: { tradingDates: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10'], values: previous, lastValueType: '当日截至sourceAt的价格，非未发生的收盘价' },
        support: 98 * scale, resistance: 104 * scale, recentBars: bars,
        barInterval: '1m', confirmationLevel: 99.5 * scale, confirmedCloses: bars.slice(-3).every(b => b.close > 99.5 * scale) ? 3 : 0,
      },
      plan: { riskPlanId: c.riskPlanId, ticker: c.ticker, action: 'BUY', quantity, limitPrice: entry, stopPrice: 98 * scale, targetPrice: 104 * scale, lotSize: 1, maxHoldingUntil: '2026-09-10T19:00:00.000Z', rule: '被动限价，未成交不能直接追价；止损为方案失效参考而非保证成交。' },
      costs: { ticker: c.ticker, currency: 'USD', sourceAt, roundTripCost: 1, slippageCost: 1, assumptions: '仅本合成数量与持有期适用的估算，非券商真实费率；现金多头融资成本0。' },
    }
    Object.assign(c, {
      firstSignalPrice: entry, latestSignalPrice: entry, latestMarketPrice: entry,
      proposedQuantity: quantity, proposedNotional: entry * quantity,
      marketEvidence: evidence, costEstimate: 2,
      recentReasons: [`${c.ticker}独立合成行情近期三根1分钟收盘高于确认位；详情见本候选marketEvidence。`],
      evidence: [`candidatePool.${facts.candidatePool.indexOf(c)}.marketEvidence`],
    })
    const metrics = candidateMetrics(c)
    c.riskBudgetUsed = metrics.riskBudgetUsed
    c.rankingMetrics = metrics
  }
}

export function candidateMetrics(c) {
  const { plan: p, costs, quote } = c.marketEvidence
  const cost = costs.roundTripCost + costs.slippageCost
  const riskBudgetUsed = cents(p.quantity * (p.limitPrice - p.stopPrice) + cost)
  const netReward = cents(p.quantity * (p.targetPrice - p.limitPrice) - cost)
  return {
    riskBudgetUsed, netReward,
    netRewardRiskBps: Math.floor(netReward / riskBudgetUsed * 10000),
    absPriceDriftBps: Math.round(Math.abs(quote.lastPrice / c.firstSignalPrice - 1) * 10000),
  }
}

const asciiCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0
export function compareCandidates(a, b) {
  const x = candidateMetrics(a), y = candidateMetrics(b)
  return y.netRewardRiskBps - x.netRewardRiskBps || x.riskBudgetUsed - y.riskBudgetUsed ||
    x.absPriceDriftBps - y.absPriceDriftBps || Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) ||
    asciiCompare(a.ticker, b.ticker) || asciiCompare(a.candidateId, b.candidateId)
}

export function validateCandidateEvidence(f) {
  const fail = reason => { throw new Error(`Invalid candidate evidence: ${reason}`) }
  const used = new Set()
  for (const c of f.candidatePool ?? []) {
    const e = c.marketEvidence
    if (!e || used.has(c.candidateId)) fail('missing evidence or duplicate candidate')
    used.add(c.candidateId)
    for (const data of [e, e.quote, e.trend, e.plan, e.costs]) if (data.ticker !== c.ticker) fail('ticker ownership')
    if (e.symbol !== (f.runtime.broker === 'futu' ? `US.${c.ticker}` : `${c.ticker}.US`)) fail('symbol')
    for (const data of [e, e.quote, e.trend, e.costs]) {
      const age = (Date.parse(f.runtime.decisionAt) - Date.parse(data.sourceAt)) / 1000
      if (!Number.isFinite(age) || age < 0 || age > e.maxAgeSeconds || !e.valid) fail('freshness')
    }
    if ([e.currency, e.costs.currency].some(currency => currency !== c.currency)) fail('currency')
    const p = e.plan
    if (p.riskPlanId !== c.riskPlanId || p.quantity !== c.proposedQuantity || p.limitPrice * p.quantity !== c.proposedNotional ||
      p.quantity <= 0 || p.quantity % p.lotSize || p.stopPrice >= p.limitPrice || p.targetPrice <= p.limitPrice) fail('plan')
    if (e.quote.lastPrice !== c.latestMarketPrice || e.quote.bid > e.quote.ask || e.trend.recentBars.at(-1).close !== e.quote.lastPrice) fail('quote')
    for (const b of e.trend.recentBars) {
      if (Date.parse(b.time) > Date.parse(f.runtime.decisionAt) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) fail('bars')
    }
    if (e.trend.window.values.length !== e.trend.window.tradingDates.length ||
      e.trend.window.values.at(-1) !== e.quote.lastPrice) fail('window')
    const m = candidateMetrics(c)
    if (Object.values(m).some(v => !Number.isFinite(v)) || m.riskBudgetUsed <= 0 ||
      JSON.stringify(m) !== JSON.stringify(c.rankingMetrics) || m.riskBudgetUsed !== c.riskBudgetUsed) fail('metrics')
  }
  if (f.candidatePool && JSON.stringify(f.portfolioContext.rankingPolicy) !== JSON.stringify(rankingPolicy)) fail('ranking policy')
}
