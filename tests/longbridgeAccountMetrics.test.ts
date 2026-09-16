import { describe, expect, it } from 'vitest'
import { buildLongbridgeAccountMetrics } from '../api/longbridge/longbridgeAdapter'
import { sumLongbridgePositionTodayPnl } from '../api/longbridge/longbridgePositionPnl'
import { resolveLongbridgeUsdOverview } from '../src/pages/longbridge/longbridgeAccountMetrics'

describe('长桥实盘美金总览', () => {
  it('优先使用旧全局接口的美金总览字段', () => {
    expect(resolveLongbridgeUsdOverview({
      美金总览: '$12.34',
      账户净资产: '$56.78',
    })).toBe('$12.34')
  })

  it('多用户租户接口回退到账户净资产字段', () => {
    expect(resolveLongbridgeUsdOverview({
      账户净资产: '$0.77',
      最大购买力: '$0.76',
    })).toBe('$0.77')
  })

  it('账户指标缺失时显示不可用', () => {
    expect(resolveLongbridgeUsdOverview({})).toBe('不可用')
  })
})

describe('长桥账户资产对账口径', () => {
  it('同时展示账户现金和融资占用后的可用现金', () => {
    expect(buildLongbridgeAccountMetrics({
      net_assets: '14465.42',
      total_cash: '11725.75',
      available_cash: '-1410.38',
      buy_power: '13158.72',
      risk_level: 0,
    })).toEqual([
      { label: '美金总览', value: '$14,465.42', helper: '账户净资产，USD' },
      { label: '账户现金', value: '$11,725.75', helper: '现金余额；与持仓市值共同构成净资产，USD' },
      { label: '现金可用', value: '$-1,410.38', helper: '扣除融资与冻结占用后的可用现金，USD' },
      { label: '最大购买力', value: '$13,158.72', helper: '最大购买力，USD' },
      { label: '今日盈亏', value: 'unavailable', helper: '美元持仓按现价与昨收价汇总，未含费用' },
      { label: '风险等级', value: '0', helper: '账户风险等级' },
    ])
  })

  it('缺少总现金时不再用可用现金冒充', () => {
    const metrics = buildLongbridgeAccountMetrics({
      net_assets: '14465.42',
      available_cash: '-1410.38',
    })

    expect(metrics.find((item) => item.label === '账户现金')?.value).toBe('unavailable')
    expect(metrics.find((item) => item.label === '现金可用')?.value).toBe('$-1,410.38')
  })

  it('优先使用 Longbridge portfolio 返回的今日盈亏', () => {
    const metrics = buildLongbridgeAccountMetrics({
      total_today_pl: '21.20',
    })

    expect(metrics.find((item) => item.label === '今日盈亏')?.value).toBe('$21.20')
  })

  it('未提供账户级字段时汇总同币种持仓今日盈亏', () => {
    const metrics = buildLongbridgeAccountMetrics({}, [
      position({ symbol: 'TSM.US', todayPnL: '$21.20' }),
      position({ symbol: 'TSLA.US', todayPnL: '$-14.19' }),
    ])

    expect(metrics.find((item) => item.label === '今日盈亏')?.value).toBe('$7.01')
  })
})

describe('长桥持仓今日盈亏汇总', () => {
  it('空仓为零，任一同币种持仓缺失数据时返回不可用', () => {
    expect(sumLongbridgePositionTodayPnl([], 'USD')).toBe(0)
    expect(sumLongbridgePositionTodayPnl([
      position({ todayPnL: '不可用' }),
    ], 'USD')).toBeUndefined()
  })

  it('只汇总当前账户币种，不混加其他币种', () => {
    expect(sumLongbridgePositionTodayPnl([
      position({ todayPnL: '$10.00' }),
      position({ currency: 'HKD', todayPnL: 'HK$20.00' }),
    ], 'USD')).toBe(10)
  })
})

function position(overrides: Partial<Parameters<typeof sumLongbridgePositionTodayPnl>[0][number]> = {}) {
  return {
    symbol: 'AAPL.US',
    name: 'Apple',
    quantity: '1',
    marketValue: '$100.00',
    averageCost: '$90.00',
    currentPrice: '$100.00',
    todayPnL: '$2.00',
    unrealizedPnL: '$10.00',
    currency: 'USD',
    ...overrides,
  }
}
