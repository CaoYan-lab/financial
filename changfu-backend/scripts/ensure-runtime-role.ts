import { Pool } from 'pg'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('CHANGFU_DATABASE_URL_REQUIRED')

const runtimeRole = process.env.CHANGFU_RUNTIME_DB_ROLE
if (!runtimeRole || !/^[a-z_][a-z0-9_]*$/i.test(runtimeRole)) {
  throw new Error('CHANGFU_RUNTIME_DB_ROLE_INVALID')
}

const runtimePassword = process.env.CHANGFU_RUNTIME_DB_PASSWORD
if (!runtimePassword || runtimePassword.length < 24) {
  throw new Error('CHANGFU_RUNTIME_DB_PASSWORD_INVALID')
}

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'changfu-role-manager',
  max: 1,
  connectionTimeoutMillis: 10_000,
})

const client = await pool.connect()
try {
  const exists = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [runtimeRole],
  )
  const statement = await client.query<{ sql: string }>(
    `SELECT format(
       CASE WHEN $3::boolean
         THEN 'ALTER ROLE %I LOGIN PASSWORD %L INHERIT'
         ELSE 'CREATE ROLE %I LOGIN PASSWORD %L INHERIT'
       END,
       $1::text,
       $2::text
     ) AS sql`,
    [runtimeRole, runtimePassword, exists.rows[0]?.exists ?? false],
  )
  await client.query(statement.rows[0]!.sql)
  const attributes = await client.query<{
    rolsuper: boolean
    rolcreatedb: boolean
    rolcreaterole: boolean
    rolreplication: boolean
  }>(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles
      WHERE rolname = $1`,
    [runtimeRole],
  )
  const role = attributes.rows[0]
  if (!role || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication) {
    throw new Error('CHANGFU_RUNTIME_DB_ROLE_IS_PRIVILEGED')
  }
  process.stdout.write(JSON.stringify({ ok: true, role: runtimeRole }) + '\n')
} finally {
  client.release()
  await pool.end()
}
