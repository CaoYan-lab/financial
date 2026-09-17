import { describe, expect, it, vi } from 'vitest'
import {
  loadLongbridgeAccountTodayPnl,
  loadLongbridgeAccountTotalPnl,
} from '../api/longbridge/longbridgeAccountTodayPnl.js'

describe('Longbridge 账户级当日盈亏', () => {
  const now = new Date('2026-09-16T16:20:00Z')

  it('读取同币种当日 sumProfit', async () => {
    const request = vi.fn().mockResolvedValue({
      currency: 'USD',
      start_date: '2026-09-16',
      end_date: '2026-09-16',
      sum_profit: '-42.18',
      updated_at: '2026-09-16T16:19:00Z',
    })

    const result = await loadLongbridgeAccountTodayPnl(
      { request },
      'USD',
      { now },
    )

    expect(request).toHaveBeenCalledWith(
      'GET',
      '/v1/portfolio/profit-analysis-summary?start=1789516800&end=1789603199',
    )
    expect(result).toEqual({
      value: -42.18,
      currency: 'USD',
      startDate: '2026-09-16',
      endDate: '2026-09-16',
      updatedAt: '2026-09-16T16:19:00Z',
    })
  })

  it('币种不一致时拒绝展示', async () => {
    const result = await loadLongbridgeAccountTodayPnl(
      {
        request: vi.fn().mockResolvedValue({
          currency: 'HKD',
          sum_profit: '100.00',
        }),
      },
      'USD',
      { now },
    )

    expect(result.value).toBeUndefined()
    expect(result.error).toContain('币种不匹配')
  })

  it('接口失败时返回不可用而不是持仓代理值', async () => {
    const result = await loadLongbridgeAccountTodayPnl(
      {
        request: vi.fn().mockRejectedValue(
          new Error('upstream unavailable'),
        ),
      },
      'USD',
      { now },
    )

    expect(result.value).toBeUndefined()
    expect(result.error).toBe('upstream unavailable')
  })

  it('并发请求复用同一个上游调用', async () => {
    const request = vi.fn().mockResolvedValue({
      currency: 'USD',
      sum_profit: '8.50',
    })
    const context = { request }

    const [first, second] = await Promise.all([
      loadLongbridgeAccountTodayPnl(context, 'USD', { now }),
      loadLongbridgeAccountTodayPnl(context, 'USD', { now }),
    ])

    expect(first.value).toBe(8.5)
    expect(second.value).toBe(8.5)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('账户总盈亏显式查询完整历史区间', async () => {
    const request = vi.fn().mockResolvedValue({
      currency: 'USD',
      start_date: '2026-09-01',
      end_date: '2026-09-16',
      sum_profit: '1250.75',
    })

    const result = await loadLongbridgeAccountTotalPnl(
      { request },
      'USD',
      { now },
    )

    expect(request).toHaveBeenCalledWith(
      'GET',
      '/v1/portfolio/profit-analysis-summary?start=1788220800&end=1789603199',
    )
    expect(result).toMatchObject({
      value: 1250.75,
      currency: 'USD',
      startDate: '2026-09-01',
      endDate: '2026-09-16',
    })
  })

  it('返回起始日与配置不一致时拒绝展示', async () => {
    const result = await loadLongbridgeAccountTotalPnl(
      {
        request: vi.fn().mockResolvedValue({
          currency: 'USD',
          start_date: '2026-09-02',
          end_date: '2026-09-16',
          sum_profit: '250.00',
        }),
      },
      'USD',
      { now },
    )

    expect(result.value).toBeUndefined()
    expect(result.error).toBe('账户盈亏日期不匹配')
  })
})
