import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool } from '../../api/cloud/db/pgClient'
import { resolveTradingPromptMode, saveTradingPromptMode, tradingPromptReleaseStatus } from '../../api/live/tradingPromptReleaseService'

describe.skipIf(process.env.RUN_PG_INTEGRATION !== '1')('提示词配置PostgreSQL并发隔离', () => {
  beforeAll(() => {
    expect(process.env.DATABASE_URL).toContain('/financial_test')
  })
  afterAll(closePool)
  it('同版本并发写入只有一次成功，租户不共享模式', async () => {
    const results = await Promise.allSettled([
      saveTradingPromptMode('longbridge', 'test:a', { mode: 'shadow', expectedRevision: 0, confirmed: true }),
      saveTradingPromptMode('longbridge', 'test:a', { mode: 'legacy', expectedRevision: 0, confirmed: true }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await tradingPromptReleaseStatus('longbridge', 'test:a')).revision).toBe(1)
    expect(await resolveTradingPromptMode('longbridge', 'single', 'test:b')).toBe('legacy')
    const current = await tradingPromptReleaseStatus('longbridge', 'test:a')
    const live = await saveTradingPromptMode('longbridge', 'test:a', {
      mode: 'live',
      expectedRevision: current.revision,
      confirmed: true,
    })
    expect(live.effectiveModes.managed).toBe('live')
  })
})
