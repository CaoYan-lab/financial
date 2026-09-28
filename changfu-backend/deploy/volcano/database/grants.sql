\if :{?changfu_runtime_role}
\else
\echo 'psql variable changfu_runtime_role is required'
\quit
\endif

BEGIN;

GRANT CONNECT ON DATABASE financial TO :"changfu_runtime_role";
GRANT USAGE ON SCHEMA public, multiuser, changfu TO :"changfu_runtime_role";

REVOKE ALL ON TABLE public.cloud_users FROM :"changfu_runtime_role";
REVOKE ALL ON TABLE multiuser.user_profiles FROM :"changfu_runtime_role";
GRANT SELECT ON TABLE public.cloud_users TO :"changfu_runtime_role";
GRANT UPDATE (last_login_at) ON TABLE public.cloud_users TO :"changfu_runtime_role";
GRANT SELECT ON TABLE multiuser.user_profiles TO :"changfu_runtime_role";

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA changfu TO :"changfu_runtime_role";
REVOKE INSERT, UPDATE, DELETE
  ON TABLE changfu.schema_migrations FROM :"changfu_runtime_role";
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA changfu TO :"changfu_runtime_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA changfu
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"changfu_runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA changfu
  GRANT USAGE, SELECT ON SEQUENCES TO :"changfu_runtime_role";

REVOKE CREATE ON SCHEMA public, multiuser FROM :"changfu_runtime_role";

COMMIT;
