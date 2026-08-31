import { describe, expect, it } from 'vitest'
import type { RawCompanyData } from '../shared/types'
import { buildOptionStrategy } from '../api/services/optionStrategyService'

const baseRow: RawCompanyData = {
  rank: 1,
  ticker: 'NVDA',
  companyName: 'NVIDIA',
  country: 'United States',
  currentPrice: '$100.00',
  marketCap: '$1T',
  peRatio: '30',
  rsi14: '45',
  ma50: '$95.00',
  ma200: '$80.00',
  ivRank: '20%',
  iv30: '40%',
  nextEarningsDate: '2099-01-01',
  capitalPerContract: '$9,200',
  sevenDayNews: 'No material news.',
  selectedOptionCode: 'US.NVDA260717P00092000',
  selectedOptionStrike: '$92.00',
  selectedOptionExpiry: '2026-07-17',
  selectedOptionPremium: '$2.10',
  selectedOptionDelta: '-0.30',
  selectedOptionPremiumSource: 'Futu option snapshot bid_price',
  source: {
    source: 'test',
    accessedAt: '2026-06-16T00:00:00.000Z',
    timestamp: '2026-06-16T00:00:00.000Z',
  },
}

describe('buildOptionStrategy', () => {
  it('只使用 Futu 期权链和快照字段生成策略，不生成 EST 权利金', () => {
    const strategy = buildOptionStrategy(baseRow, { verdict: 'Hold', track: 'B' })

    expect(strategy?.strike).toBe('$92.00')
    expect(strategy?.expirationDate).toBe('2026-07-17')
    expect(strategy?.premium).toBe('$2.10 (Futu option snapshot bid_price)')
    expect(strategy?.premium).not.toContain('EST')
    expect(strategy?.annualizedReturn).toContain('%')
    expect(strategy?.flags).toContain('Low IV - Acceptable for core position building')
    expect(strategy?.rationale).toContain('US.NVDA260717P00092000')
  })

  it('缺少 Futu 期权字段时不使用公式估算', () => {
    const strategy = buildOptionStrategy(
      {
        ...baseRow,
        selectedOptionCode: 'unavailable',
        selectedOptionStrike: 'unavailable',
        selectedOptionExpiry: 'unavailable',
        selectedOptionPremium: 'unavailable',
        selectedOptionDelta: 'unavailable',
        selectedOptionPremiumSource: 'unavailable',
      },
      { verdict: 'Hold', track: 'B' },
    )

    expect(strategy?.strike).toBe('unavailable')
    expect(strategy?.expirationDate).toBe('unavailable')
    expect(strategy?.premium).toBe('unavailable')
    expect(strategy?.annualizedReturn).toBe('unavailable')
    expect(strategy?.flags).toContain('Futu option chain or snapshot field unavailable; do not estimate')
    expect(strategy?.rationale).toContain('no formula-based strike, expiry or premium')
  })

  it('Trim 不生成卖 Put 策略', () => {
    expect(buildOptionStrategy(baseRow, { verdict: 'Trim', track: 'None' })).toBeUndefined()
  })
})
