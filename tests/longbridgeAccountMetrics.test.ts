import { describe, expect, it } from 'vitest'
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
