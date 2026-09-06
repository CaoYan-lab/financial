import { describe, expect, it } from 'vitest'
import { localizeLongbridgeOrderError } from '../shared/orderErrorMessages'

describe('长桥订单错误中文化', () => {
  it('将 602035 报价档位错误转换为明确中文提示', () => {
    expect(
      localizeLongbridgeOrderError(
        'openapi error: code=602035: Wrong bid size, please change the price',
      ),
    ).toBe('委托价格不符合该证券的最小报价单位，请调整价格（长桥错误码 602035）。')
  })

  it('保留未知错误的具体内容并替换英文前缀', () => {
    expect(
      localizeLongbridgeOrderError('openapi error: code=123: rejected'),
    ).toBe('长桥开放接口错误：code=123: rejected')
  })

  it('将未确认美股卖空风险声明转换为中文提示', () => {
    expect(
      localizeLongbridgeOrderError(
        'openapi error: code=602065: The account has not confirmed the risk disclaimer of US short-sell. Please go to App to finish the process.',
      ),
    ).toBe('账户尚未确认美股卖空风险声明，请先在长桥应用中完成确认（长桥错误码 602065）。')
  })

  it('将购买力不足的订单过程转换为中文提示', () => {
    expect(
      localizeLongbridgeOrderError('The order amount exceeds the maximum buying power'),
    ).toBe('订单金额超过账户最大购买力。')
  })
})
