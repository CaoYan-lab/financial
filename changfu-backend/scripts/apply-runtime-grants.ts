import { Pool } from 'pg'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('CHANGFU_DATABASE_URL_REQUIRED')

const runtimeRole = process.env.CHANGFU_RUNTIME_DB_ROLE
if (!runtimeRole || !/^[a-z_][a-z0-9_]*$/i.test(runtimeRole)) {
  throw new Error('CHANGFU_RUNTIME_DB_ROLE_INVALID')
}

const role = `"${runtimeRole.replaceAll('"', '""')}"`
const adminRuntimeRole = process.env.CHANGFU_ADMIN_RUNTIME_DB_ROLE
if (adminRuntimeRole && !/^[a-z_][a-z0-9_]*$/i.test(adminRuntimeRole)) {
  throw new Error('CHANGFU_ADMIN_RUNTIME_DB_ROLE_INVALID')
}
const adminRole = adminRuntimeRole
  ? `"${adminRuntimeRole.replaceAll('"', '""')}"`
  : null
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
  await client.query(`GRANT USAGE ON SCHEMA public, multiuser, changfu, changfu_admin TO ${role}`)
  await client.query(`REVOKE ALL ON TABLE public.cloud_users FROM ${role}`)
  await client.query(`REVOKE ALL ON TABLE multiuser.user_profiles FROM ${role}`)
  await client.query(`GRANT SELECT ON TABLE public.cloud_users TO ${role}`)
  await client.query(
    `GRANT UPDATE (password_hash, last_login_at) ON TABLE public.cloud_users TO ${role}`,
  )
  await client.query(`GRANT SELECT ON TABLE multiuser.user_profiles TO ${role}`)
  await client.query(
    `GRANT UPDATE (must_change_password, sessions_valid_after, updated_at)
       ON TABLE multiuser.user_profiles TO ${role}`,
  )
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
    `GRANT SELECT ON TABLE changfu_admin.official_model_config_versions TO ${role}`,
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
  if (adminRole) {
    await client.query(`GRANT CONNECT ON DATABASE financial TO ${adminRole}`)
    await client.query(
      `GRANT USAGE ON SCHEMA public, multiuser, changfu, changfu_admin TO ${adminRole}`,
    )
    await client.query(`REVOKE ALL ON TABLE public.cloud_users FROM ${adminRole}`)
    await client.query(`REVOKE ALL ON TABLE multiuser.user_profiles FROM ${adminRole}`)
    await client.query(
      `GRANT SELECT, INSERT ON TABLE public.cloud_users TO ${adminRole}`,
    )
    await client.query(
      `GRANT UPDATE (username, password_hash, last_login_at)
         ON TABLE public.cloud_users TO ${adminRole}`,
    )
    await client.query(
      `GRANT SELECT, INSERT ON TABLE multiuser.user_profiles TO ${adminRole}`,
    )
    await client.query(
      `GRANT UPDATE (display_name, active, must_change_password, sessions_valid_after, updated_at)
         ON TABLE multiuser.user_profiles TO ${adminRole}`,
    )
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE
         ON ALL TABLES IN SCHEMA changfu_admin TO ${adminRole}`,
    )
    await client.query(
      `GRANT SELECT, INSERT, UPDATE
         ON TABLE changfu.subscription_catalog_releases,
                  changfu.subscription_plan_versions,
                  changfu.subscription_prices,
                  changfu.user_subscriptions,
                  changfu.subscription_events,
                  changfu.subscription_broker_slots,
                  changfu.subscription_broker_binding_history,
                  changfu.subscription_pending_provider_selections,
                  changfu.provider_research_pools,
                  changfu.provider_research_pool_items,
                  changfu.device_sessions
         TO ${adminRole}`,
    )
    await client.query(
      `GRANT SELECT ON TABLE changfu.devices,
                             changfu.broker_provider_catalog,
                             changfu.broker_connections,
                             multiuser.broker_connections
         TO ${adminRole}`,
    )
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, multiuser FROM ${adminRole}`,
    )
    await client.query(
      `GRANT USAGE, SELECT ON SEQUENCE public.cloud_users_id_seq TO ${adminRole}`,
    )
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA changfu, changfu_admin
         TO ${adminRole}`,
    )
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA changfu_admin
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${adminRole}`,
    )
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA changfu_admin
         GRANT USAGE, SELECT ON SEQUENCES TO ${adminRole}`,
    )
    await client.query(
      `REVOKE CREATE ON SCHEMA public, multiuser, changfu, changfu_admin FROM ${adminRole}`,
    )
  }
  await client.query('COMMIT')
  process.stdout.write(JSON.stringify({
    ok: true,
    role: runtimeRole,
    adminRole: adminRuntimeRole ?? null,
  }) + '\n')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}
