import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTradingPromptComparisonResult,
  createTradingPromptComparisonRun,
  finishTradingPromptComparisonRun,
  latestTradingPromptComparison,
} from '../api/live/tradingPromptComparisonStore'

describe('提示词版本对比本地库', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'prompt-comparison-'))
    vi.stubEnv('TRADING_PROMPT_COMPARISON_DB_PATH', join(directory, 'comparison.sqlite3'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it('保存运行及两券商版本结果并按券商查询', () => {
    createTradingPromptComparisonRun({
      id: 'run-1', startedAt: '2026-09-13T00:00:00Z', completedAt: null,
      status: 'RUNNING', universeCount: 1, totalCases: 4, completedCases: 0,
      passedCases: 0, failedCases: 0, reportPath: null, error: null,
    })
    for (const broker of ['futu', 'longbridge'] as const) {
      for (const mode of ['legacy', 'live'] as const) {
        appendTradingPromptComparisonResult({
          runId: 'run-1', broker, mode, ticker: 'AAPL', modelRequested: true,
          contextOk: true, marketPrice: 180, marketUpdatedAt: '2026-09-13T00:00:00Z',
          action: 'HOLD', approved: false, requestOk: true,
          contractValid: mode === 'live' ? true : null, policyValid: mode === 'live' ? true : null,
          contextUsableAtResponse: mode === 'live' ? true : null, durationMs: 100,
          reason: '测试', riskAssessment: '测试', errors: [], rawOutput: { action: 'HOLD' },
          contextSummary: { bars: 10 }, createdAt: '2026-09-13T00:00:01Z',
        })
      }
    }
    finishTradingPromptComparisonRun('run-1', { status: 'COMPLETED', reportPath: '/tmp/report.md' })
    const all = latestTradingPromptComparison()
    expect(all.run).toMatchObject({ completedCases: 4, passedCases: 4, failedCases: 0, status: 'COMPLETED' })
    expect(all.results).toHaveLength(4)
    expect(latestTradingPromptComparison('futu').results).toHaveLength(2)
  })
})
