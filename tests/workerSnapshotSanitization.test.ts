import { describe, expect, it } from 'vitest'
import {
  mergeEngineSnapshot,
  sanitizeWorkerSnapshot,
} from '../api/cloud/jobs/jobHandlers.js'

describe('worker snapshot sanitization', () => {
  it('preserves every market status while trimming oversized detail arrays', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ticker: `TICKER-${index}`,
      marketState: index < 10 ? 'CLOSED' : 'WAITING_OPEN',
      reason: '休市期间不评估',
    }))
    const oversized = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      detail: 'x'.repeat(10_000),
    }))

    const result = sanitizeWorkerSnapshot({
      evaluationStatus: { items },
      latestSignals: oversized,
    }) as {
      evaluationStatus: { items: typeof items }
      latestSignals: typeof oversized
    }

    expect(result.evaluationStatus.items).toHaveLength(20)
    expect(result.evaluationStatus.items.map((item) => item.ticker)).toEqual(
      items.map((item) => item.ticker),
    )
    expect(result.latestSignals).toHaveLength(40)
  })

  it('uses the latest engine state while preserving the last complete broker snapshot', () => {
    const result = mergeEngineSnapshot(
      {
        engine: { running: false, lastError: '' },
        sourceStatus: { authStatus: 'authenticated', accountDataAvailable: true },
        account: { ok: true },
        workbench: { ok: true },
      },
      {
        engine: { running: true, lastError: '' },
        evaluationStatus: { state: 'WAITING_MARKET' },
        updatedAt: '2026-09-12T06:43:12.000Z',
      },
    )

    expect(result).toMatchObject({
      engine: { running: true, lastError: '' },
      evaluationStatus: { state: 'WAITING_MARKET' },
      sourceStatus: { authStatus: 'authenticated', accountDataAvailable: true },
      account: { ok: true },
      workbench: { ok: true },
    })
  })
})
