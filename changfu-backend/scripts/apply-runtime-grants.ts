import { Pool } from 'pg'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('CHANGFU_DATABASE_URL_REQUIRED')

const runtimeRole = process.env.CHANGFU_RUNTIME_DB_ROLE
if (!runtimeRole || !/^[a-z_][a-z0-9_]*$/i.test(runtimeRole)) {
  throw new Error('CHANGFU_RUNTIME_DB_ROLE_INVALID')
}

const role = `"${runtimeRole.replaceAll('"', '""')}"`
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'changfu-grant-manager',
  max: 1,
  connectionTimeoutMillis: 10_000,
})

const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query(`GRANT CONNECT ON DATABASE financial TO ${role}`)
  await client.query(`GRANT USAGE ON SCHEMA public, multiuser, changfu TO ${role}`)
  await client.query(`REVOKE ALL ON TABLE public.cloud_users FROM ${role}`)
  await client.query(`REVOKE ALL ON TABLE multiuser.user_profiles FROM ${role}`)
  await client.query(`GRANT SELECT ON TABLE public.cloud_users TO ${role}`)
  await client.query(`GRANT UPDATE (last_login_at) ON TABLE public.cloud_users TO ${role}`)
  await client.query(`GRANT SELECT ON TABLE multiuser.user_profiles TO ${role}`)
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
       ON ALL TABLES IN SCHEMA changfu TO ${role}`,
  )
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE
       ON TABLE changfu.schema_migrations FROM ${role}`,
  )
  await client.query(
    `GRANT USAGE, SELECT
       ON ALL SEQUENCES IN SCHEMA changfu TO ${role}`,
  )
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA changfu
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
  )
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA changfu
       GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
  )
  await client.query(`REVOKE CREATE ON SCHEMA public, multiuser FROM ${role}`)
  await client.query('COMMIT')
  process.stdout.write(JSON.stringify({ ok: true, role: runtimeRole }) + '\n')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}
