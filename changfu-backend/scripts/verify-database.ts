import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { loadMigrations } from '../packages/runtime/src/migrations.js'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('CHANGFU_DATABASE_URL_REQUIRED')
const roleKind = process.env.CHANGFU_VERIFY_ROLE_KIND ?? 'runtime'
if (roleKind !== 'runtime' && roleKind !== 'admin') {
  throw new Error('CHANGFU_VERIFY_ROLE_KIND_INVALID')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrations = await loadMigrations(resolve(root, 'migrations'))
const combinedSql = migrations.map(migration => migration.sql).join('\n')
const expectedTables = [...combinedSql.matchAll(
  /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(changfu(?:_admin)?)\.([a-z0-9_]+)/gi,
)].map(match => ({ schema: match[1]!, table: match[2]! }))
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

  const tables = await client.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_schema IN ('changfu', 'changfu_admin')`,
  )
  const actualTables = new Set(
    tables.rows.map(row => `${row.table_schema}.${row.table_name}`),
  )
  const adminChangfuTables = new Set([
    'broker_connections',
    'broker_provider_catalog',
    'devices',
    'device_sessions',
    'provider_research_pool_items',
    'provider_research_pools',
    'subscription_broker_binding_history',
    'subscription_broker_slots',
    'subscription_catalog_releases',
    'subscription_events',
    'subscription_pending_provider_selections',
    'subscription_plan_versions',
    'subscription_prices',
    'user_subscriptions',
  ])
  const visibleExpectedTables = expectedTables.filter(({ schema, table }) => (
    roleKind === 'runtime'
      ? schema === 'changfu'
        || (schema === 'changfu_admin' && table === 'official_model_config_versions')
      : schema === 'changfu_admin'
        || (schema === 'changfu' && adminChangfuTables.has(table))
  ))
  const missingTables = visibleExpectedTables
    .map(({ schema, table }) => `${schema}.${table}`)
    .filter(table => !actualTables.has(table))
  if (missingTables.length > 0) failures.push(`missing tables: ${missingTables.join(', ')}`)

  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname IN ('changfu', 'changfu_admin')`,
  )
  const actualIndexes = new Set(indexes.rows.map(row => row.indexname))
  const missingIndexes = expectedIndexes.filter(index => !actualIndexes.has(index))
  if (missingIndexes.length > 0) failures.push(`missing indexes: ${missingIndexes.join(', ')}`)

  const constraints = await client.query<{ contype: keyof typeof expectedConstraintMinimums; count: string }>(
    `SELECT con.contype, count(*)::text AS count
       FROM pg_constraint AS con
       JOIN pg_namespace AS namespace ON namespace.oid = con.connamespace
      WHERE namespace.nspname IN ('changfu', 'changfu_admin')
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
      WHERE namespace.nspname IN ('changfu', 'changfu_admin')
        AND NOT con.convalidated`,
  )
  if (Number(invalidConstraints.rows[0]?.count ?? 0) > 0) {
    failures.push('unvalidated constraints found')
  }

  if (roleKind === 'runtime') {
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
    if (unknownVersions.length > 0) {
      failures.push(`unknown applied migrations: ${unknownVersions.join(', ')}`)
    }
  } else {
    const migrationLedgerRead = await client.query<{ allowed: boolean }>(
      `SELECT has_table_privilege(
         current_user,
         'changfu.schema_migrations',
         'SELECT'
       ) AS allowed`,
    )
    if (migrationLedgerRead.rows[0]?.allowed) {
      failures.push('admin role can read the migration ledger')
    }
  }

  const schemaPrivileges = await client.query<{
    public_create: boolean
    multiuser_create: boolean
    changfu_create: boolean
    admin_create: boolean
  }>(
    `SELECT
       has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
       has_schema_privilege(current_user, 'multiuser', 'CREATE') AS multiuser_create,
       has_schema_privilege(current_user, 'changfu', 'CREATE') AS changfu_create,
       has_schema_privilege(current_user, 'changfu_admin', 'CREATE') AS admin_create`,
  )
  if (Object.values(schemaPrivileges.rows[0] ?? {}).some(Boolean)) {
    failures.push(`${roleKind} role has DDL privileges`)
  }

  for (const relation of ['public.cloud_users', 'multiuser.user_profiles']) {
    const privilege = await client.query<{ allowed: boolean }>(
      'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
      [relation, 'SELECT'],
    )
    if (!privilege.rows[0]?.allowed) failures.push(`runtime role cannot SELECT ${relation}`)
  }

  if (roleKind === 'runtime') {
    for (const { schema, table } of expectedTables.filter(
      item => item.schema === 'changfu' && item.table !== 'schema_migrations',
    )) {
      const privilege = await client.query<{ allowed: boolean }>(
        'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
        [`${schema}.${table}`, 'SELECT, INSERT, UPDATE, DELETE'],
      )
      if (!privilege.rows[0]?.allowed) {
        failures.push(`runtime role lacks DML on ${schema}.${table}`)
      }
    }
    const officialModelRead = await client.query<{ allowed: boolean }>(
      `SELECT has_table_privilege(
         current_user,
         'changfu_admin.official_model_config_versions',
         'SELECT'
       ) AS allowed`,
    )
    if (!officialModelRead.rows[0]?.allowed) {
      failures.push('runtime role cannot read the active official model config')
    }
  } else {
    const adminTables = expectedTables.filter(item => item.schema === 'changfu_admin')
    for (const { schema, table } of adminTables) {
      const privilege = await client.query<{ allowed: boolean }>(
        'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
        [`${schema}.${table}`, 'SELECT, INSERT, UPDATE, DELETE'],
      )
      if (!privilege.rows[0]?.allowed) {
        failures.push(`admin role lacks DML on ${schema}.${table}`)
      }
    }
    for (const relation of [
      'changfu.subscription_plan_versions',
      'changfu.subscription_prices',
      'changfu.user_subscriptions',
      'changfu.subscription_events',
      'changfu.subscription_broker_slots',
      'changfu.subscription_broker_binding_history',
      'changfu.provider_research_pools',
      'changfu.provider_research_pool_items',
      'changfu.device_sessions',
    ]) {
      const privilege = await client.query<{ allowed: boolean }>(
        'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
        [relation, 'SELECT, INSERT, UPDATE'],
      )
      if (!privilege.rows[0]?.allowed) failures.push(`admin role lacks required DML on ${relation}`)
    }
    for (const relation of [
      'changfu.order_executions',
      'changfu.pending_orders',
      'changfu.model_runs',
      'changfu.signals',
      'changfu.reports',
    ]) {
      const privilege = await client.query<{ allowed: boolean }>(
        'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
        [relation, 'INSERT, UPDATE, DELETE'],
      )
      if (privilege.rows[0]?.allowed) failures.push(`admin role has excessive DML on ${relation}`)
    }
    for (const relation of [
      'changfu.devices',
      'changfu.broker_provider_catalog',
      'changfu.broker_connections',
      'multiuser.broker_connections',
    ]) {
      const privilege = await client.query<{ allowed: boolean }>(
        'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
        [relation, 'SELECT'],
      )
      if (!privilege.rows[0]?.allowed) failures.push(`admin role cannot read ${relation}`)
    }
    const identitySequences = await client.query<{
      sequence_schema: string
      sequence_name: string
      allowed: boolean
    }>(
      `SELECT sequence_schema, sequence_name,
              has_sequence_privilege(
                current_user,
                format('%I.%I', sequence_schema, sequence_name),
                'USAGE'
              ) AS allowed
         FROM information_schema.sequences
        WHERE sequence_schema IN ('public', 'multiuser')`,
    )
    for (const sequence of identitySequences.rows) {
      const qualified = `${sequence.sequence_schema}.${sequence.sequence_name}`
      const expected = qualified === 'public.cloud_users_id_seq'
      if (sequence.allowed !== expected) {
        failures.push(`unexpected sequence privilege on ${qualified}`)
      }
    }
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
  const allowedCloudUserUpdates = roleKind === 'admin'
    ? new Set(['username', 'password_hash', 'last_login_at'])
    : new Set(['last_login_at'])
  for (const column of cloudUserColumns.rows) {
    const expected = allowedCloudUserUpdates.has(column.column_name)
    if (column.can_update !== expected) {
      failures.push(`unexpected UPDATE privilege on public.cloud_users.${column.column_name}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`DATABASE_VERIFICATION_FAILED\n${failures.join('\n')}`)
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    roleKind,
    migrations: migrations.length,
    tables: expectedTables.length,
    indexes: expectedIndexes.length,
  }) + '\n')
} finally {
  client.release()
  await pool.end()
}
