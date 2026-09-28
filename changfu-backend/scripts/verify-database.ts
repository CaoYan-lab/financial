import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { loadMigrations } from '../packages/runtime/src/migrations.js'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('CHANGFU_DATABASE_URL_REQUIRED')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrations = await loadMigrations(resolve(root, 'migrations'))
const combinedSql = migrations.map(migration => migration.sql).join('\n')
const expectedTables = [...combinedSql.matchAll(
  /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+changfu\.([a-z0-9_]+)/gi,
)].map(match => match[1]!)
const expectedIndexes = [...combinedSql.matchAll(
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi,
)].map(match => match[1]!)
const droppedCheckConstraints = (
  combinedSql.match(/\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?[a-z0-9_]*_check\b/gi) ?? []
).length
const expectedConstraintMinimums = {
  p: (combinedSql.match(/\bPRIMARY\s+KEY\b/gi) ?? []).length,
  f: (combinedSql.match(/\bREFERENCES\s+(?:public|multiuser|changfu)\./gi) ?? []).length,
  c: (combinedSql.match(/\bCHECK\s*\(/gi) ?? []).length - droppedCheckConstraints,
  u: (combinedSql.match(/\bUNIQUE\s*\(/gi) ?? []).length,
}

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'changfu-database-verifier',
  max: 1,
  connectionTimeoutMillis: 10_000,
})

const failures: string[] = []
const client = await pool.connect()
try {
  const externalRelations = await client.query<{ relation: string | null }>(
    `SELECT to_regclass(name) AS relation
       FROM unnest(ARRAY['public.cloud_users', 'multiuser.user_profiles']) AS name`,
  )
  if (externalRelations.rows.some(row => row.relation === null)) {
    failures.push('required identity tables are missing')
  }

  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'changfu'`,
  )
  const actualTables = new Set(tables.rows.map(row => row.table_name))
  const missingTables = expectedTables.filter(table => !actualTables.has(table))
  if (missingTables.length > 0) failures.push(`missing tables: ${missingTables.join(', ')}`)

  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'changfu'`,
  )
  const actualIndexes = new Set(indexes.rows.map(row => row.indexname))
  const missingIndexes = expectedIndexes.filter(index => !actualIndexes.has(index))
  if (missingIndexes.length > 0) failures.push(`missing indexes: ${missingIndexes.join(', ')}`)

  const constraints = await client.query<{ contype: keyof typeof expectedConstraintMinimums; count: string }>(
    `SELECT con.contype, count(*)::text AS count
       FROM pg_constraint AS con
       JOIN pg_namespace AS namespace ON namespace.oid = con.connamespace
      WHERE namespace.nspname = 'changfu'
      GROUP BY con.contype`,
  )
  const actualConstraintCounts = new Map(
    constraints.rows.map(row => [row.contype, Number(row.count)]),
  )
  for (const [type, minimum] of Object.entries(expectedConstraintMinimums)) {
    if ((actualConstraintCounts.get(type as keyof typeof expectedConstraintMinimums) ?? 0) < minimum) {
      failures.push(`constraint count below expected minimum for type ${type}`)
    }
  }
  const invalidConstraints = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_constraint AS con
       JOIN pg_namespace AS namespace ON namespace.oid = con.connamespace
      WHERE namespace.nspname = 'changfu'
        AND NOT con.convalidated`,
  )
  if (Number(invalidConstraints.rows[0]?.count ?? 0) > 0) {
    failures.push('unvalidated constraints found')
  }

  const applied = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM changfu.schema_migrations ORDER BY version',
  )
  const appliedByVersion = new Map(applied.rows.map(row => [row.version, row.checksum]))
  for (const migration of migrations) {
    const checksum = appliedByVersion.get(migration.version)
    if (checksum === undefined) failures.push(`migration not applied: ${migration.version}`)
    else if (checksum !== migration.checksum) failures.push(`migration checksum mismatch: ${migration.version}`)
  }
  const knownVersions = new Set(migrations.map(migration => migration.version))
  const unknownVersions = applied.rows
    .map(row => row.version)
    .filter(version => !knownVersions.has(version))
  if (unknownVersions.length > 0) failures.push(`unknown applied migrations: ${unknownVersions.join(', ')}`)

  const schemaPrivileges = await client.query<{ public_create: boolean; multiuser_create: boolean }>(
    `SELECT
       has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
       has_schema_privilege(current_user, 'multiuser', 'CREATE') AS multiuser_create`,
  )
  if (schemaPrivileges.rows[0]?.public_create || schemaPrivileges.rows[0]?.multiuser_create) {
    failures.push('runtime role has DDL privileges on identity schemas')
  }

  for (const relation of ['public.cloud_users', 'multiuser.user_profiles']) {
    const privilege = await client.query<{ allowed: boolean }>(
      'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
      [relation, 'SELECT'],
    )
    if (!privilege.rows[0]?.allowed) failures.push(`runtime role cannot SELECT ${relation}`)
  }

  for (const table of expectedTables.filter(name => name !== 'schema_migrations')) {
    const privilege = await client.query<{ allowed: boolean }>(
      'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
      [`changfu.${table}`, 'SELECT, INSERT, UPDATE, DELETE'],
    )
    if (!privilege.rows[0]?.allowed) failures.push(`runtime role lacks DML on changfu.${table}`)
  }

  const cloudUserColumns = await client.query<{ column_name: string; can_update: boolean }>(
    `SELECT column_name,
            has_column_privilege(
              current_user,
              'public.cloud_users',
              column_name,
              'UPDATE'
            ) AS can_update
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'cloud_users'`,
  )
  for (const column of cloudUserColumns.rows) {
    const expected = column.column_name === 'last_login_at'
    if (column.can_update !== expected) {
      failures.push(`unexpected UPDATE privilege on public.cloud_users.${column.column_name}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`DATABASE_VERIFICATION_FAILED\n${failures.join('\n')}`)
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    migrations: migrations.length,
    tables: expectedTables.length,
    indexes: expectedIndexes.length,
  }) + '\n')
} finally {
  client.release()
  await pool.end()
}
