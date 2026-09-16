import { describe, expect, it } from 'vitest'
import { financingOpeningStatus, finalAccountOrderFailure, livePromptMarketFailure, shadowOrderExecutionFailure, verifiedCloseQuantity } from '../api/live/brokerFinancingRisk'
import { parseLongbridgeRiskLevel } from '../api/longbridge/longbridgeRiskService'

const summary = () => ({
  accountId: 'a', currency: 'USD', tradingCurrency: 'USD', financingCurrency: 'USD',
  financingEquity: '$1000', initialMargin: '$100', maintenanceMargin: '$50',
  futuExposureLevel: 'SAFE', futuRiskStatus: 'LEVEL1', financingRiskLevel: 0,
  totalAssetsInTradingCurrency: '$1000', buyingPowerInTradingCurrency: '$2000',
  source: { accessedAt: new Date().toISOString() },
} as any)
const intent = () => ({ ticker: 'AAPL', side: 'BUY', quantity: 1, limitPrice: 100 } as any)
const account = () => ({ ok: true, selectedAccountId: 'a', summary: summary(), positions: [] } as any)

describe('券商融资与最终提交保护', () => {
  it.each([null, undefined, '', ' ', 'NaN', NaN, Infinity, -1, 4, 0.5, false])('拒绝错误长桥等级 %s', value => {
    expect(parseLongbridgeRiskLevel(value)).toBeUndefined()
  })
  it.each([0, 1, 2, 3])('规范化长桥风险等级 %s', level => {
    expect(parseLongbridgeRiskLevel(String(level))).toBe(level)
    expect(financingOpeningStatus('longbridge', { ...summary(), financingRiskLevel: level })).toBe(level >= 2 ? 'BLOCKED' : 'ALLOWED')
  })
  it('富途语义与长桥独立，未知、虚拟资产限额状态不当安全', () => {
    expect(financingOpeningStatus('futu', summary())).toBe('ALLOWED')
    for (const status of ['LEVEL7', 'LEVEL8', 'LEVEL9']) expect(financingOpeningStatus('futu', { ...summary(), futuRiskStatus: status })).toBe('BLOCKED')
    for (const exposure of ['WARNING', 'MARGIN_CALL']) expect(financingOpeningStatus('futu', { ...summary(), futuExposureLevel: exposure })).toBe('BLOCKED')
    for (const exposure of ['NORMAL', 'RESTRICTED', 'NEAR_LIMIT', 'bad']) expect(financingOpeningStatus('futu', { ...summary(), futuExposureLevel: exposure })).toBe('UNKNOWN')
    expect(financingOpeningStatus('futu', { ...summary(), initialMargin: '不可用' })).toBe('UNKNOWN')
    expect(financingOpeningStatus('futu', { ...summary(), financingCurrency: 'HKD' })).toBe('UNKNOWN')
    expect(financingOpeningStatus('futu', { ...summary(), financingEquity: '$49' })).toBe('BLOCKED')
  })
  it.each([null, undefined, 3, Infinity, NaN, '2'])('可平量无效 %s', raw => {
    expect(verifiedCloseQuantity(raw, -2)).toBeNull()
  })
  it('兼容长桥空头持仓返回的带符号可平量', () => {
    expect(verifiedCloseQuantity(-1, -1)).toBe(1)
    expect(verifiedCloseQuantity(-2, -1)).toBeNull()
    expect(verifiedCloseQuantity(-1, 1)).toBeNull()
  })
  it('零可平量保留，必要减仓不受融资预警影响', () => {
    expect(verifiedCloseQuantity(0, 2)).toBe(0)
    const a = account()
    a.summary.futuExposureLevel = 'WARNING'
    a.positions = [{ ticker: 'AAPL', assetType: 'STOCK', quantity: '2', currency: 'USD', availableToClose: 1 }]
    expect(finalAccountOrderFailure('futu', a, { ...intent(), side: 'SELL_TO_CLOSE' }, 'USD')).toBeUndefined()
    expect(finalAccountOrderFailure('futu', a, { ...intent(), side: 'SELL_TO_CLOSE', quantity: 2 }, 'USD')).toContain('超限')
    a.positions[0].assetType = 'OPTION'
    expect(finalAccountOrderFailure('futu', a, { ...intent(), side: 'SELL_TO_CLOSE' }, 'USD')).toContain('没有可平')
  })
  it('拒绝过期、账户错配、币种错配、未知风险与超购买力', () => {
    const a = account()
    expect(finalAccountOrderFailure('futu', a, intent(), 'USD')).toBeUndefined()
    expect(finalAccountOrderFailure('futu', a, intent(), 'HKD')).toContain('币种')
    expect(finalAccountOrderFailure('futu', { ...a, selectedAccountId: 'b' }, intent(), 'USD')).toContain('不匹配')
    expect(finalAccountOrderFailure('futu', a, { ...intent(), quantity: 30 }, 'USD')).toContain('购买力')
    expect(finalAccountOrderFailure('futu', a, { ...intent(), side: 'SELL_SHORT' }, 'USD')).toContain('最大可卖')
    a.summary.source.accessedAt = '2020-01-01T00:00:00Z'
    expect(finalAccountOrderFailure('futu', a, intent(), 'USD')).toContain('过期')
  })
  it('回补不得跨过零持仓反向开多', () => {
    const a = account()
    a.positions = [{ ticker: 'AAPL', assetType: 'STOCK', quantity: '-2', currency: 'USD', availableToClose: 2 }]
    expect(finalAccountOrderFailure('longbridge', a, { ...intent(), quantity: 3 }, 'USD')).toContain('反向开仓')
  })
  it('长桥空头的带符号可平量允许等量自动回补', () => {
    const a = account()
    a.positions = [{ ticker: 'GOOG', assetType: 'STOCK', quantity: '-1', currency: 'USD', availableToClose: -1 }]
    expect(finalAccountOrderFailure(
      'longbridge',
      a,
      { ...intent(), ticker: 'GOOG', quantity: 1 },
      'USD',
    )).toBeUndefined()
  })
  it('新版实盘审计和提交前行情必须同时有效', () => {
    const order = {
      intent: intent(),
      llmDecision: { promptAudit: {
        mode: 'live', ordersEnabled: true, contractValid: true, policyValid: true,
        contextUsableAtResponse: true, sourceValidUntil: new Date(Date.now() + 30_000).toISOString(),
      } },
    } as any
    expect(shadowOrderExecutionFailure(order)).toBeUndefined()
    expect(livePromptMarketFailure(order, 101, new Date().toISOString())).toBeUndefined()
    expect(livePromptMarketFailure(order, 104, new Date().toISOString())).toContain('偏离')
    order.llmDecision.promptAudit.policyValid = false
    expect(shadowOrderExecutionFailure(order)).toContain('未通过')
    order.llmDecision.promptAudit.mode = 'shadow'
    expect(shadowOrderExecutionFailure(order)).toContain('影子')
  })
})
