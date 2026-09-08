import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AShareTradingAgentRun } from '../shared/types'

const dbPath = join(tmpdir(), `financial-a-share-persistence-${process.pid}.sqlite3`)
process.env.ASHARE_LIVE_HISTORY_DB_PATH = dbPath

const { aSharePersistence } = await import('../api/ashare/aSharePersistence')

describe('A 股 agent_runs persistence', { timeout: 30_000 }, () => {
  beforeEach(() => {
    rmSync(dbPath, { force: true })
  })

  it('独立落库 Trading Agent 运行记录并按完成时间分页读取', () => {
    const first = agentRun('ashare-agent-1', '2026-06-29T01:00:00.000Z')
    const second = agentRun('ashare-agent-2', '2026-06-29T01:01:00.000Z')

    aSharePersistence.appendAgentRun(first)
    aSharePersistence.appendAgentRun(second)

    const page = aSharePersistence.paginateAgentRuns(1, 1)
    const latest = aSharePersistence.readLatest('agent_runs', 2)

    expect(page.total).toBe(2)
    expect(page.totalPages).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.items[0].agentRunId).toBe('ashare-agent-2')
    expect(page.items[0].historyId).toEqual(expect.any(Number))
    expect(latest.map((item) => item.agentRunId)).toEqual(['ashare-agent-2', 'ashare-agent-1'])
    expect(sqlKindCount('agent_runs')).toBe(2)
  })

  it('分页参数会被归一化，避免异常页码影响读取', () => {
    aSharePersistence.appendAgentRun(agentRun('ashare-agent-normalized', '2026-06-29T01:00:00.000Z'))

    const page = aSharePersistence.paginateAgentRuns(-10, 999)

    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(100)
    expect(page.items[0].agentRunId).toBe('ashare-agent-normalized')
  })
})

function agentRun(agentRunId: string, completedAt: string): AShareTradingAgentRun {
  return {
    agentRunId,
    ticker: 'SH.688256',
    decisionMode: 'trading_agent',
    executionMode: 'trading_agent',
    startedAt: completedAt,
    completedAt,
    status: 'SUCCESS',
    llmPresetId: 'deepseek_v4',
    llmPresetLabel: 'DeepSeek v4',
    llmProvider: 'openai-compatible',
    quickThinkLlm: 'deepseek-v4',
    deepThinkLlm: 'deepseek-v4',
    marketDataContext: { source: 'futu-callback', status: 'OK' },
    futuStockContext: { source: 'futu-openapi', status: 'OK', sections: { capitalFlow: [] } },
    stockNewsContext: { source: 'futu-news', status: 'OK', articles: [] },
    macroNewsContext: { source: 'Doubao Search Custom shared snapshot', snapshot: { riskLevel: 'HIGH' } },
    aShareRulesContext: {
      allowedActions: ['HOLD', 'BUY', 'SELL_TO_CLOSE'],
      forbiddenActions: ['SELL_SHORT'],
    },
    sizingContext: {
      lotSize: 100,
      currency: 'CNY',
    },
    universeContext: { tickers: ['SH.688256'] },
    dataQualityContext: { status: 'OK', warnings: [] },
    roleReports: [
      {
        role: 'portfolio_manager',
        status: 'OK',
        summary: 'HOLD',
        recommendation: 'HOLD',
      },
    ],
    finalDecision: { action: 'HOLD' },
    rawUpstreamOutput: { ok: true },
    adapterWarnings: [],
  }
}

function sqlKindCount(kind: string) {
  const script = `import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
row = conn.execute("select count(*) from live_events where kind = ?", (sys.argv[2],)).fetchone()
print(row[0])
`
  const result = spawnSync('python3', ['-c', script, dbPath, kind], { encoding: 'utf8' })
  return Number(result.stdout.trim() || 0)
}
