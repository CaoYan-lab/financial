import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PoolClient } from 'pg'
import {
  loadMigrations,
  migrationBody,
  migrationChecksum,
  runMigrations,
} from '../packages/runtime/src/migrations.js'

test('迁移正文由执行器统一管理外层事务', () => {
  assert.equal(
    migrationBody('BEGIN;\nCREATE TABLE example(id bigint);\nCOMMIT;\n'),
    'CREATE TABLE example(id bigint);',
  )
})

test('迁移 checksum 对内容变更敏感', () => {
  assert.equal(migrationChecksum('SELECT 1'), migrationChecksum('SELECT 1'))
  assert.notEqual(migrationChecksum('SELECT 1'), migrationChecksum('SELECT 2'))
})

test('迁移文件按版本排序并包含元数据迁移', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const migrations = await loadMigrations(resolve(root, 'migrations'))
  assert.equal(migrations[0]?.version, '000_migration_metadata')
  assert.equal(migrations.at(-1)?.version, '012_normalize_provider_pool_symbols')
  assert.equal(migrations.length, 13)
  assert.ok(migrations.every(migration => /^[a-f0-9]{64}$/.test(migration.checksum)))
})

test('已登记迁移内容变化时失败关闭并释放 advisory lock', async () => {
  const statements: string[] = []
  const client = {
    async query(sql: string) {
      statements.push(sql)
      if (sql.startsWith('SELECT checksum')) {
        return { rows: [{ checksum: '0'.repeat(64) }] }
      }
      return { rows: [] }
    },
  } as unknown as PoolClient
  await assert.rejects(
    runMigrations(client, [{
      version: '000_migration_metadata',
      checksum: '1'.repeat(64),
      sql: 'CREATE SCHEMA IF NOT EXISTS changfu',
      path: '000_migration_metadata.sql',
    }]),
    /MIGRATION_CHECKSUM_MISMATCH:000_migration_metadata/,
  )
  assert.ok(statements.includes('ROLLBACK'))
  assert.ok(statements.some(statement => statement.includes('pg_advisory_unlock')))
})
