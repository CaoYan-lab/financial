import { describe, expect, it, vi } from 'vitest'
import { createLongbridgeSdkScheduler } from '../api/longbridge/longbridgeSdkRateLimiter.js'

describe('Longbridge SDK 调用限频器', () => {
  it('跨 Context 串行执行并满足最小调用间隔', async () => {
    vi.useFakeTimers()
    const starts: number[] = []
    const scheduler = createLongbridgeSdkScheduler(20)
    const quote = scheduler.wrap({
      request: vi.fn(async () => {
        starts.push(Date.now())
        return 'quote'
      }),
    })
    const trade = scheduler.wrap({
      request: vi.fn(async () => {
        starts.push(Date.now())
        return 'trade'
      }),
    })

    const requests = [quote.request(), trade.request(), quote.request()]
    await vi.runAllTimersAsync()

    await expect(Promise.all(requests)).resolves.toEqual(['quote', 'trade', 'quote'])
    expect(starts).toHaveLength(3)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(20)
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(20)
    vi.useRealTimers()
  })

  it('单次请求失败后仍继续处理后续请求', async () => {
    const scheduler = createLongbridgeSdkScheduler(20)
    const context = scheduler.wrap({
      request: vi.fn()
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValueOnce('recovered'),
    })

    await expect(context.request()).rejects.toThrow('rate limited')
    await expect(context.request()).resolves.toBe('recovered')
  })
})
