import { describe, expect, it } from 'vitest'
import { displayOrderType } from '../src/utils/simulationDisplay'

describe('simulationDisplay', () => {
  it('将 Futu 订单类型转换为中文', () => {
    expect(displayOrderType('NORMAL', 'zh')).toBe('限价单')
    expect(displayOrderType('MARKET', 'zh')).toBe('市价单')
    expect(displayOrderType('AUCTION_LIMIT', 'zh')).toBe('竞价限价单')
    expect(displayOrderType('SPECIAL_LIMIT', 'zh')).toBe('特别限价单')
  })
})
