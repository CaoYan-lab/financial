import { describe, expect, it } from 'vitest'
import { currentAshareSession } from '../api/ashare/aShareMarketSessionGate'
import {
  findAsharePositionQuantity,
  normalizeAshareOrderQuantity,
  parseAccountFunds,
  parsePositionQuantity,
  validateAshareDecision,
} from '../api/ashare/aShareRiskService'
import type { AccountSummary, Position } from '../shared/types'

describe('A 股 session gate', () => {
  it('连续竞价时段允许评估，午休、收盘和周末跳过 LLM', () => {
    expect(currentAshareSession(new Date('2026-06-29T01:30:00.000Z')).session).toBe('RTH')
    expect(currentAshareSession(new Date('2026-06-29T04:00:00.000Z'))).toMatchObject({
      session: 'LUNCH_BREAK',
      shouldSkipLlm: true,
    })
    expect(currentAshareSession(new Date('2026-06-29T07:01:00.000Z'))).toMatchObject({
      session: 'CLOSED',
      shouldSkipLlm: true,
    })
    expect(currentAshareSession(new Date('2026-06-28T02:00:00.000Z'))).toMatchObject({
      session: 'WEEKEND',
      shouldSkipLlm: true,
    })
  })
})

describe('A 股硬风控', () => {
  it('禁止 SELL_SHORT，且非 RTH 不允许生成可交易订单', () => {
    expect(validateAshareDecision('SELL_SHORT', 'RTH').blockedReason).toContain('禁止 SELL_SHORT')
    expect(validateAshareDecision('BUY', 'LUNCH_BREAK', {
      orderQuantity: 100,
      limitPrice: 10,
      accountSummary: accountSummary({ availableFundsInTradingCurrency: '¥10,000.00' }),
    }).blockedReason).toContain('连续竞价')
    expect(validateAshareDecision('HOLD', 'LUNCH_BREAK').ok).toBe(true)
  })

  it('BUY 必须满足一手整数倍、有效限价和可用资金约束', () => {
    expect(validateAshareDecision('BUY', 'RTH', {
      orderQuantity: 99,
      limitPrice: 10,
      accountSummary: accountSummary({ availableFundsInTradingCurrency: '¥10,000.00' }),
    }).blockedReason).toContain('不是一手 100 股的整数倍')

    expect(validateAshareDecision('BUY', 'RTH', {
      orderQuantity: 100,
      limitPrice: 0,
      accountSummary: accountSummary({ availableFundsInTradingCurrency: '¥10,000.00' }),
    }).blockedReason).toContain('缺少有效限价')

    expect(validateAshareDecision('BUY', 'RTH', {
      orderQuantity: 100,
      limitPrice: 10,
      accountSummary: accountSummary({ availableFundsInTradingCurrency: '¥999.00' }),
    }).blockedReason).toContain('超过可用资金')

    expect(validateAshareDecision('BUY', 'RTH', {
      orderQuantity: 100,
      limitPrice: 10,
      accountSummary: accountSummary({ availableFundsInTradingCurrency: '¥2,000.00' }),
    }).ok).toBe(true)
  })

  it('SELL_TO_CLOSE 只能卖出已有多头持仓且不能超过可识别持仓', () => {
    const positions = [position({ ticker: 'SH.688256', quantity: '300' })]

    expect(validateAshareDecision('SELL_TO_CLOSE', 'RTH', {
      ticker: 'SH.688256',
      orderQuantity: 200,
      positions,
    }).ok).toBe(true)
    expect(validateAshareDecision('SELL_TO_CLOSE', 'RTH', {
      ticker: 'SH.688256',
      orderQuantity: 400,
      positions,
    }).blockedReason).toContain('超过当前可识别持仓')
    expect(validateAshareDecision('SELL_TO_CLOSE', 'RTH', {
      ticker: 'SZ.000001',
      orderQuantity: 100,
      positions,
    }).blockedReason).toContain('没有 SZ.000001 多头持仓')
  })

  it('数量、持仓和资金解析兼容 A 股代码格式与 CNY 展示字段', () => {
    expect(normalizeAshareOrderQuantity('BUY', 358)).toBe(300)
    expect(normalizeAshareOrderQuantity('SELL_TO_CLOSE', 500, 260)).toBe(260)
    expect(parsePositionQuantity('¥1,200')).toBe(1200)
    expect(parseAccountFunds(accountSummary({
      availableFundsInTradingCurrency: 'unavailable',
      availableFunds: 'unavailable',
      buyingPowerInTradingCurrency: '¥12,345.67',
    }))).toBe(12345.67)
    expect(findAsharePositionQuantity([
      position({ ticker: '688256.SH', quantity: '100' }),
      position({ ticker: 'SZ.000001', quantity: '50' }),
      position({ ticker: 'US.NVDA', quantity: '10' }),
      position({ ticker: 'SH.688256', assetType: 'OPTION', quantity: '999' }),
    ], 'SH.688256')).toBe(100)
  })
})

function accountSummary(overrides: Partial<AccountSummary> = {}): AccountSummary {
  const now = new Date().toISOString()
  return {
    accountId: 'ashare-test',
    currency: 'CNY',
    totalAssets: '¥100,000.00',
    cash: '¥50,000.00',
    availableFunds: '¥50,000.00',
    buyingPower: '¥50,000.00',
    tradingCurrency: 'CNY',
    totalAssetsInTradingCurrency: '¥100,000.00',
    cashInTradingCurrency: '¥50,000.00',
    availableFundsInTradingCurrency: '¥50,000.00',
    buyingPowerInTradingCurrency: '¥50,000.00',
    dailyPnL: '¥0.00',
    totalPnL: '¥0.00',
    source: { source: 'test', accessedAt: now, timestamp: now },
    ...overrides,
  }
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    code: overrides.ticker ?? 'SH.688256',
    ticker: overrides.ticker ?? 'SH.688256',
    name: '寒武纪',
    assetType: overrides.assetType ?? 'STOCK',
    underlyingTicker: overrides.underlyingTicker ?? overrides.ticker ?? 'SH.688256',
    quantity: overrides.quantity ?? '100',
    marketValue: overrides.marketValue ?? '¥100,000.00',
    averageCost: overrides.averageCost ?? '¥1000.00',
    currentPrice: '¥1000.00',
    todayPnL: '¥0.00',
    unrealizedPnL: '¥0.00',
    pnlRatio: '0%',
    positionRatio: '10%',
    currency: 'CNY',
    ...overrides,
  }
}
