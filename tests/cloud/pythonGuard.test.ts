import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..', '..')

const guardedScripts = [
  'api/futu_bridge/live_history_db.py',
  'api/futu_bridge/simulation_history_db.py',
  'api/futu_bridge/report_history_db.py',
  'api/longbridge/longbridge_live_history_db.py',
]

describe('云端 PG 驱动 env 守卫（不破坏既有 sqlite 路径）', () => {
  for (const script of guardedScripts) {
    it(`${script} 顶部包含 PG_HISTORY_DRIVER 守卫`, () => {
      const content = readFileSync(resolve(root, script), 'utf-8')
      const head = content.slice(0, 600)
      expect(head).toContain('PG_HISTORY_DRIVER')
      expect(head).toContain('pg_history_driver')
      // 守卫必须在业务 import 之前
      expect(head.indexOf('PG_HISTORY_DRIVER')).toBeLessThan(head.indexOf('import sqlite3'))
    })
  }

  it('未设置环境变量时守卫不触发（脚本顶部为条件判断）', () => {
    for (const script of guardedScripts) {
      const content = readFileSync(resolve(root, script), 'utf-8')
      expect(content).toMatch(/if _os\.environ\.get\("PG_HISTORY_DRIVER"\) == "1"/)
    }
  })

  it('云端 PG 交付物齐全', () => {
    expect(existsSync(resolve(root, 'deploy/volcano/pg/python/pg_history_driver.py'))).toBe(true)
    expect(existsSync(resolve(root, 'deploy/volcano/pg/schema.sql'))).toBe(true)
    expect(existsSync(resolve(root, 'deploy/volcano/pg/migrate_sqlite_to_pg.py'))).toBe(true)
    expect(existsSync(resolve(root, 'deploy/volcano/pg/verify_row_counts.py'))).toBe(true)
    expect(existsSync(resolve(root, 'api/cloud/db/pgClient.ts'))).toBe(true)
    expect(existsSync(resolve(root, 'api/cloud/auth/authService.ts'))).toBe(true)
    expect(existsSync(resolve(root, 'api/cloud/http/cloudWebApp.ts'))).toBe(true)
  })
})
