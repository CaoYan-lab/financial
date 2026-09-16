import { describe, expect, it } from 'vitest'
import {
  formatLongbridgeAccountPnl,
  formatLongbridgePnl,
  formatLongbridgePrice,
  parseLongbridgeDisplayNumber,
} from '../src/utils/longbridgePositionDisplay'

describe('Longbridge position display', () => {
  it('normalizes supported price currencies to two decimal places', () => {
    expect(formatLongbridgePrice('418', 'USD')).toBe('$418.00')
    expect(formatLongbridgePrice('HK$1,024.5', 'HKD')).toBe('HK$1,024.50')
  })

  it('formats profit with a leading plus and the red tone key', () => {
    expect(formatLongbridgePnl('$21.2')).toEqual({
      label: '+21.20',
      tone: 'profit',
    })
  })

  it('formats loss with one minus sign and the green tone key', () => {
    expect(formatLongbridgePnl('HK$-14.19')).toEqual({
      label: '-14.19',
      tone: 'loss',
    })
    expect(formatLongbridgePnl('(14.19)')).toEqual({
      label: '-14.19',
      tone: 'loss',
    })
  })

  it('uses neutral output for zero and unavailable values', () => {
    expect(formatLongbridgePnl('0')).toEqual({
      label: '0.00',
      tone: 'neutral',
    })
    expect(formatLongbridgePnl('暂无')).toEqual({
      label: '不可用',
      tone: 'neutral',
    })
    expect(formatLongbridgePrice('unavailable', 'USD')).toBe('不可用')
  })

  it('retains the account currency symbol and adds an explicit sign', () => {
    expect(formatLongbridgeAccountPnl('$1,234.5')).toEqual({
      label: '+$1,234.50',
      tone: 'profit',
    })
    expect(formatLongbridgeAccountPnl('HK$-14.19')).toEqual({
      label: '-HK$14.19',
      tone: 'loss',
    })
  })

  it('parses signed values returned with currency decorations', () => {
    expect(parseLongbridgeDisplayNumber('USD +1,234.56')).toBe(1234.56)
    expect(parseLongbridgeDisplayNumber('$-14.19')).toBe(-14.19)
  })
})
