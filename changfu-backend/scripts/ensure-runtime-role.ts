import { Pool } from 'pg'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('CHANGFU_DATABASE_URL_REQUIRED')

const roles = [
  {
    role: process.env.CHANGFU_RUNTIME_DB_ROLE,
    password: process.env.CHANGFU_RUNTIME_DB_PASSWORD,
    required: true,
    errorPrefix: 'CHANGFU_RUNTIME',
  },
  {
    role: process.env.CHANGFU_ADMIN_RUNTIME_DB_ROLE,
    password: process.env.CHANGFU_ADMIN_RUNTIME_DB_PASSWORD,
    required: false,
    errorPrefix: 'CHANGFU_ADMIN_RUNTIME',
  },
]

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'changfu-role-manager',
  max: 1,
  connectionTimeoutMillis: 10_000,
})

const client = await pool.connect()
try {
  const ensured: string[] = []
  for (const definition of roles) {
    if (!definition.role && !definition.password && !definition.required) continue
    if (!definition.role || !/^[a-z_][a-z0-9_]*$/i.test(definition.role)) {
      throw new Error(`${definition.errorPrefix}_DB_ROLE_INVALID`)
    }
    if (!definition.password || definition.password.length < 24) {
      throw new Error(`${definition.errorPrefix}_DB_PASSWORD_INVALID`)
    }
    const exists = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      [definition.role],
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
      [definition.role, definition.password, exists.rows[0]?.exists ?? false],
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
      [definition.role],
    )
    const attributesRow = attributes.rows[0]
    if (
      !attributesRow
      || attributesRow.rolsuper
      || attributesRow.rolcreatedb
      || attributesRow.rolcreaterole
      || attributesRow.rolreplication
    ) {
      throw new Error(`${definition.errorPrefix}_DB_ROLE_IS_PRIVILEGED`)
    }
    ensured.push(definition.role)
  }
  process.stdout.write(JSON.stringify({ ok: true, roles: ensured }) + '\n')
} finally {
  client.release()
  await pool.end()
}
