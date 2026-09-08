import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..', '..')
const venvPython = resolve(root, '.venv-cloud/bin/python')
const driverPath = resolve(root, 'deploy/volcano/pg/python')
const urlFile = resolve(root, '.data/cloud-pg/database_url')

const pgAvailable =
  process.env.RUN_PG_INTEGRATION === '1'
  && existsSync(venvPython)
  && existsSync(urlFile)
const describeIfPg = pgAvailable ? describe : describe.skip

const stamp = `vitest-cloud-${process.pid}-${Date.now()}`

function runScript(scriptRelPath: string, payload: Record<string, unknown>, pg: boolean) {
  const scriptPath = resolve(root, scriptRelPath)
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  if (pg) {
    env.PG_HISTORY_DRIVER = '1'
    env.VOLCANO_CLOUD_PYTHONPATH = driverPath
    env.DATABASE_URL = readFileSync(urlFile, 'utf-8').trim()
  }
  const result = spawnSync(venvPython, [scriptPath], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const line = result.stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line ?? '{}') as { ok?: boolean; items?: unknown[]; found?: boolean; value?: unknown }
}

function cleanupPg() {
  const dsn = readFileSync(urlFile, 'utf-8').trim()
  spawnSync(
    venvPython,
    [
      '-c',
      `
import psycopg
with psycopg.connect(${JSON.stringify(dsn)}) as conn:
    for table in ['live_events','ashare_events','simulation_events','longbridge_live_signals']:
        conn.execute(f"DELETE FROM {table} WHERE payload->>'id' LIKE %s", ('vitest-cloud-%',))
    conn.execute("DELETE FROM simulation_config WHERE key LIKE 'vitest-cloud-%'")
    conn.commit()
`,
    ],
    { encoding: 'utf-8' },
  )
}

describeIfPg('PG 历史驱动垫片集成测试（本地 PG 可用时运行）', () => {
  beforeAll(() => {
    cleanupPg()
  })
  afterAll(() => {
    cleanupPg()
  })

  it('live_history_db：PG 写入后可读回，且带 historyId', () => {
    const signalId = `${stamp}-live`
    const append = runScript(
      'api/futu_bridge/live_history_db.py',
      {
        dbPath: join('.data', 'live-trading-history.sqlite3'),
        action: 'append',
        kind: 'signals',
        createdAt: '2026-08-31T15:00:00Z',
        payload: { id: signalId, ticker: 'NVDA', side: 'BUY', strategy: 'VITEST', generatedAt: '2026-08-31T15:00:00Z', ok: true },
      },
      true,
    )
    expect(append.ok).toBe(true)

    const read = runScript(
      'api/futu_bridge/live_history_db.py',
      { dbPath: join('.data', 'live-trading-history.sqlite3'), action: 'read_latest', kind: 'signals', limit: 20 },
      true,
    )
    const found = (read.items as Array<{ id: string; historyId?: number }>).find((item) => item.id === signalId)
    expect(found).toBeTruthy()
    expect(typeof found?.historyId).toBe('number')
  })

  it('A 股复用 live 脚本时路由到 ashare_events，与 live_events 隔离', () => {
    const signalId = `${stamp}-ashare`
    const append = runScript(
      'api/futu_bridge/live_history_db.py',
      {
        dbPath: join('.data', 'a-share-live-history.sqlite3'),
        action: 'append',
        kind: 'signals',
        createdAt: '2026-08-31T15:01:00Z',
        payload: { id: signalId, ticker: '600519', side: 'BUY', strategy: 'VITEST', generatedAt: '2026-08-31T15:01:00Z', ok: true },
      },
      true,
    )
    expect(append.ok).toBe(true)

    const ashareRead = runScript(
      'api/futu_bridge/live_history_db.py',
      { dbPath: join('.data', 'a-share-live-history.sqlite3'), action: 'read_latest', kind: 'signals', limit: 20 },
      true,
    )
    const liveRead = runScript(
      'api/futu_bridge/live_history_db.py',
      { dbPath: join('.data', 'live-trading-history.sqlite3'), action: 'read_latest', kind: 'signals', limit: 20 },
      true,
    )
    const ashareItems = ashareRead.items as Array<{ id: string }>
    const liveItems = liveRead.items as Array<{ id: string }>
    expect(ashareItems.some((item) => item.id === signalId)).toBe(true)
    expect(liveItems.some((item) => item.id === signalId)).toBe(false)
  })

  it('simulation_config：PG set_config/get_config 往返一致', () => {
    const key = `${stamp}-config`
    const setResult = runScript(
      'api/futu_bridge/simulation_history_db.py',
      {
        dbPath: join('.data', 'simulation-history.sqlite3'),
        action: 'set_config',
        key,
        value: { model: 'vitest-model', threshold: 3 },
        updatedAt: '2026-08-31T15:02:00Z',
      },
      true,
    )
    expect(setResult.ok).toBe(true)
    const getResult = runScript(
      'api/futu_bridge/simulation_history_db.py',
      { dbPath: join('.data', 'simulation-history.sqlite3'), action: 'get_config', key },
      true,
    )
    expect(getResult.found).toBe(true)
    expect((getResult.value as { model?: string }).model).toBe('vitest-model')
  })

  it('longbridge 分表：PG 写入 longbridge_live_signals 可读回', () => {
    const signalId = `${stamp}-longbridge`
    const append = runScript(
      'api/longbridge/longbridge_live_history_db.py',
      {
        dbPath: join('.data', 'live-trading-history.sqlite3'),
        action: 'append',
        kind: 'signals',
        createdAt: '2026-08-31T15:03:00Z',
        payload: { id: signalId, ticker: '700.HK', side: 'HOLD', strategy: 'VITEST' },
      },
      true,
    )
    expect(append.ok).toBe(true)
    const read = runScript(
      'api/longbridge/longbridge_live_history_db.py',
      { dbPath: join('.data', 'live-trading-history.sqlite3'), action: 'read_latest', kind: 'signals', limit: 20 },
      true,
    )
    const found = (read.items as Array<{ id: string }>).find((item) => item.id === signalId)
    expect(found).toBeTruthy()
  })
})
