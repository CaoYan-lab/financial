import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export default async function globalTeardown(): Promise<void> {
  const root = resolve(import.meta.dirname, '..', '..')
  const python = resolve(root, '.venv-cloud/bin/python')
  const script = resolve(root, 'deploy/volcano/pg/local_test_pg.py')
  const result = spawnSync(python, [script, 'drop'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || '清理 financial_test 失败')
  }
}
