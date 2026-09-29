\if :{?changfu_runtime_role}
\else
\echo 'psql variable changfu_runtime_role is required'
\quit
\endif
\if :{?changfu_admin_runtime_role}
\else
\echo 'psql variable changfu_admin_runtime_role is required'
\quit
\endif

BEGIN;

GRANT CONNECT ON DATABASE financial TO :"changfu_runtime_role";
GRANT USAGE ON SCHEMA public, multiuser, changfu, changfu_admin TO :"changfu_runtime_role";

REVOKE ALL ON TABLE public.cloud_users FROM :"changfu_runtime_role";
REVOKE ALL ON TABLE multiuser.user_profiles FROM :"changfu_runtime_role";
GRANT SELECT ON TABLE public.cloud_users TO :"changfu_runtime_role";
GRANT UPDATE (password_hash, last_login_at)
  ON TABLE public.cloud_users TO :"changfu_runtime_role";
GRANT SELECT ON TABLE multiuser.user_profiles TO :"changfu_runtime_role";
GRANT UPDATE (must_change_password, sessions_valid_after, updated_at)
  ON TABLE multiuser.user_profiles TO :"changfu_runtime_role";

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA changfu TO :"changfu_runtime_role";
REVOKE INSERT, UPDATE, DELETE
  ON TABLE changfu.schema_migrations FROM :"changfu_runtime_role";
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA changfu TO :"changfu_runtime_role";
GRANT SELECT
  ON TABLE changfu_admin.official_model_config_versions
  TO :"changfu_runtime_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA changfu
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"changfu_runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA changfu
  GRANT USAGE, SELECT ON SEQUENCES TO :"changfu_runtime_role";

REVOKE CREATE ON SCHEMA public, multiuser FROM :"changfu_runtime_role";

GRANT CONNECT ON DATABASE financial TO :"changfu_admin_runtime_role";
GRANT USAGE ON SCHEMA public, multiuser, changfu, changfu_admin
  TO :"changfu_admin_runtime_role";

REVOKE ALL ON TABLE public.cloud_users FROM :"changfu_admin_runtime_role";
REVOKE ALL ON TABLE multiuser.user_profiles FROM :"changfu_admin_runtime_role";
GRANT SELECT, INSERT ON TABLE public.cloud_users TO :"changfu_admin_runtime_role";
GRANT UPDATE (username, password_hash, last_login_at)
  ON TABLE public.cloud_users TO :"changfu_admin_runtime_role";
GRANT SELECT, INSERT ON TABLE multiuser.user_profiles TO :"changfu_admin_runtime_role";
GRANT UPDATE (
  display_name, active, must_change_password, sessions_valid_after, updated_at
) ON TABLE multiuser.user_profiles TO :"changfu_admin_runtime_role";

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA changfu_admin TO :"changfu_admin_runtime_role";
GRANT SELECT, INSERT, UPDATE
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
  TO :"changfu_admin_runtime_role";
GRANT SELECT
  ON TABLE changfu.devices,
           changfu.broker_provider_catalog,
           changfu.broker_connections,
           multiuser.broker_connections
  TO :"changfu_admin_runtime_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, multiuser
  FROM :"changfu_admin_runtime_role";
GRANT USAGE, SELECT ON SEQUENCE public.cloud_users_id_seq
  TO :"changfu_admin_runtime_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA changfu, changfu_admin
  TO :"changfu_admin_runtime_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA changfu_admin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"changfu_admin_runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA changfu_admin
  GRANT USAGE, SELECT ON SEQUENCES TO :"changfu_admin_runtime_role";

REVOKE CREATE ON SCHEMA public, multiuser, changfu, changfu_admin
  FROM :"changfu_admin_runtime_role";

COMMIT;
