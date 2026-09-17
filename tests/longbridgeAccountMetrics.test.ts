import { describe, expect, it } from 'vitest'
import { buildLongbridgeAccountMetrics } from '../api/longbridge/longbridgeAdapter'
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
      { label: '今日盈亏', value: 'unavailable', helper: '长桥账户级当日盈亏，包含已实现盈亏与费用' },
      { label: '账户总盈亏', value: 'unavailable', helper: '长桥全量历史账户级累计盈亏' },
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

  it('使用 Longbridge 账户级期间盈亏', () => {
    const metrics = buildLongbridgeAccountMetrics({
      account_today_pnl: '21.20',
      account_total_pnl: '1250.75',
      account_total_pnl_start_date: '2026-09-01',
    })

    expect(metrics.find((item) => item.label === '今日盈亏')?.value).toBe('$21.20')
    expect(metrics.find((item) => item.label === '账户总盈亏')?.value).toBe('$1,250.75')
    expect(metrics.find((item) => item.label === '账户总盈亏')?.helper).toBe(
      '2026-09-01 至今的长桥账户级累计盈亏',
    )
  })

  it('未提供账户级字段时不以持仓涨跌冒充账户今日盈亏', () => {
    const metrics = buildLongbridgeAccountMetrics({})

    expect(metrics.find((item) => item.label === '今日盈亏')?.value).toBe('unavailable')
  })
})
