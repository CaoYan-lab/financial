import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PoolClient } from 'pg'

const migrationPattern = /^\d{3}_[a-z0-9_]+\.sql$/

export type Migration = {
  version: string
  checksum: string
  sql: string
  path: string
}

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

export function migrationBody(sql: string): string {
  const withoutBegin = sql.replace(/^\s*BEGIN\s*;\s*/i, '')
  return withoutBegin.replace(/\s*COMMIT\s*;\s*$/i, '').trim()
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter(name => migrationPattern.test(name))
    .sort((left, right) => left.localeCompare(right))
  return Promise.all(names.map(async name => {
    const path = join(directory, name)
    const sql = await readFile(path, 'utf8')
    return {
      version: basename(name, '.sql'),
      checksum: migrationChecksum(sql),
      sql: migrationBody(sql),
      path,
    }
  }))
}

async function appliedChecksum(client: PoolClient, version: string): Promise<string | null> {
  const result = await client.query<{ checksum: string }>(
    'SELECT checksum FROM changfu.schema_migrations WHERE version = $1',
    [version],
  )
  return result.rows[0]?.checksum ?? null
}

async function applyMigration(client: PoolClient, migration: Migration): Promise<boolean> {
  await client.query('BEGIN')
  try {
    const existing = await appliedChecksum(client, migration.version)
    if (existing !== null) {
      if (existing !== migration.checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.version}`)
      }
      await client.query('COMMIT')
      return false
    }
    if (migration.sql.length > 0) await client.query(migration.sql)
    await client.query(
      `INSERT INTO changfu.schema_migrations (version, checksum)
       VALUES ($1, $2)`,
      [migration.version, migration.checksum],
    )
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export async function runMigrations(
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<string[]> {
  if (migrations[0]?.version !== '000_migration_metadata') {
    throw new Error('MIGRATION_METADATA_MISSING')
  }
  await client.query(`SELECT pg_advisory_lock(hashtext('changfu-schema-migrations'))`)
  try {
    await client.query('BEGIN')
    try {
      if (migrations[0].sql.length > 0) await client.query(migrations[0].sql)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }

    const applied: string[] = []
    for (const migration of migrations) {
      if (await applyMigration(client, migration)) applied.push(migration.version)
    }
    return applied
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('changfu-schema-migrations'))`)
  }
}
