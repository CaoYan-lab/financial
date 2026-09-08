import { describe, expect, it, vi } from 'vitest'
import {
  fallbackLotSize,
  loadLongbridgeLotSize,
  longbridgeOpeningLotSizeFailureReason,
} from '../api/longbridge/longbridgeLotSizeService.js'

describe('Longbridge lot size', () => {
  it('reads the actual HK lot size from Longbridge static info', async () => {
    const staticInfo = vi.fn().mockResolvedValue([
      { symbol: '9660.HK', lotSize: 600 },
    ])

    await expect(loadLongbridgeLotSize({ staticInfo }, '09660')).resolves.toBe(600)
    expect(staticInfo).toHaveBeenCalledWith(['9660.HK'])
  })

  it('falls back to 100 shares for HK and one share for US', () => {
    expect(fallbackLotSize('07709')).toBe(100)
    expect(fallbackLotSize('AAPL.US')).toBe(1)
  })

  it('blocks non-lot HK opening quantities without affecting US shares', () => {
    expect(longbridgeOpeningLotSizeFailureReason({
      symbol: '7709.HK',
      action: 'BUY',
      quantity: 3,
      lotSize: 100,
    })).toContain('每手 100 股')
    expect(longbridgeOpeningLotSizeFailureReason({
      symbol: '9660.HK',
      action: 'BUY',
      quantity: 100,
      lotSize: 600,
    })).toContain('每手 600 股')
    expect(longbridgeOpeningLotSizeFailureReason({
      symbol: '7709.HK',
      action: 'BUY',
      quantity: 200,
      lotSize: 100,
    })).toBeUndefined()
    expect(longbridgeOpeningLotSizeFailureReason({
      symbol: 'AAPL.US',
      action: 'BUY',
      quantity: 3,
      lotSize: 1,
    })).toBeUndefined()
  })

  it('allows odd-lot closing sales', () => {
    expect(longbridgeOpeningLotSizeFailureReason({
      symbol: '7709.HK',
      action: 'SELL_TO_CLOSE',
      quantity: 3,
      lotSize: 100,
    })).toBeUndefined()
  })
})
