import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { loadMigrations, runMigrations } from '../packages/runtime/src/migrations.js'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('CHANGFU_DATABASE_URL_REQUIRED')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrations = await loadMigrations(resolve(root, 'migrations'))
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'changfu-migrator',
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
})

const client = await pool.connect()
try {
  const applied = await runMigrations(client, migrations)
  process.stdout.write(JSON.stringify({
    ok: true,
    migrationCount: migrations.length,
    applied,
  }) + '\n')
} finally {
  client.release()
  await pool.end()
}
