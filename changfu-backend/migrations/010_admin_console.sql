BEGIN;

CREATE SCHEMA IF NOT EXISTS changfu_admin;

CREATE TABLE IF NOT EXISTS changfu_admin.admin_users (
  admin_user_id uuid PRIMARY KEY,
  username varchar(80) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role varchar(32) NOT NULL DEFAULT 'SUPER_ADMIN'
    CHECK (role = 'SUPER_ADMIN'),
  enabled boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (username = lower(username)),
  CHECK (length(username) BETWEEN 3 AND 80),
  CHECK (length(password_hash) BETWEEN 32 AND 512)
);

CREATE TABLE IF NOT EXISTS changfu_admin.admin_sessions (
  admin_session_id uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL
    REFERENCES changfu_admin.admin_users(admin_user_id) ON DELETE CASCADE,
  session_token_hash char(64) NOT NULL UNIQUE,
  csrf_token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= expires_at)
);

CREATE INDEX IF NOT EXISTS changfu_admin_sessions_active_idx
  ON changfu_admin.admin_sessions (admin_user_id, idle_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS changfu_admin.audit_events (
  audit_event_id uuid PRIMARY KEY,
  actor_admin_user_id uuid
    REFERENCES changfu_admin.admin_users(admin_user_id),
  action varchar(100) NOT NULL,
  resource_type varchar(80) NOT NULL,
  resource_id varchar(160),
  outcome varchar(16) NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
  request_id uuid NOT NULL,
  source_ip inet,
  before_summary jsonb,
  after_summary jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (before_summary IS NULL OR NOT (before_summary ?| ARRAY[
    'password', 'passwordHash', 'token', 'sessionToken', 'csrfToken',
    'apiKey', 'secret', 'authorization', 'ciphertext', 'nonce', 'authTag'
  ])),
  CHECK (after_summary IS NULL OR NOT (after_summary ?| ARRAY[
    'password', 'passwordHash', 'token', 'sessionToken', 'csrfToken',
    'apiKey', 'secret', 'authorization', 'ciphertext', 'nonce', 'authTag'
  ]))
);

CREATE INDEX IF NOT EXISTS changfu_admin_audit_events_time_idx
  ON changfu_admin.audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS changfu_admin_audit_events_actor_idx
  ON changfu_admin.audit_events (actor_admin_user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS changfu_admin.subscription_grants (
  grant_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  subscription_id uuid NOT NULL
    REFERENCES changfu.user_subscriptions(subscription_id),
  previous_plan_version_id uuid
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  next_plan_version_id uuid NOT NULL
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  billing_period varchar(16) NOT NULL
    CHECK (billing_period IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status varchar(16) NOT NULL
    CHECK (status IN ('GRANTED', 'ADJUSTED', 'FROZEN', 'RESTORED', 'CANCELLED')),
  retained_providers varchar(32)[] NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  request_version bigint NOT NULL CHECK (request_version >= 0),
  actor_admin_user_id uuid NOT NULL
    REFERENCES changfu_admin.admin_users(admin_user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (length(trim(reason)) BETWEEN 3 AND 1000)
);

CREATE INDEX IF NOT EXISTS changfu_admin_subscription_grants_user_idx
  ON changfu_admin.subscription_grants (user_id, created_at DESC);

ALTER TABLE changfu.user_subscriptions
  ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'PAYMENT';
ALTER TABLE changfu.user_subscriptions
  ADD COLUMN IF NOT EXISTS latest_grant_id uuid;
ALTER TABLE changfu.user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_source_check;
ALTER TABLE changfu.user_subscriptions
  ADD CONSTRAINT user_subscriptions_source_check
  CHECK (source IN ('PAYMENT', 'ADMIN_GRANT'));
ALTER TABLE changfu.user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_latest_grant_id_fkey;
ALTER TABLE changfu.user_subscriptions
  ADD CONSTRAINT user_subscriptions_latest_grant_id_fkey
  FOREIGN KEY (latest_grant_id)
  REFERENCES changfu_admin.subscription_grants(grant_id);

ALTER TABLE changfu.subscription_events
  DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
ALTER TABLE changfu.subscription_events
  ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN (
    'PURCHASED', 'RENEWED', 'UPGRADED', 'CHANGE_SCHEDULED',
    'DOWNGRADED', 'EXPIRED', 'RESTORED',
    'ADMIN_GRANTED', 'ADMIN_ADJUSTED', 'ADMIN_FROZEN',
    'ADMIN_RESTORED', 'ADMIN_CANCELLED'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS changfu_subscription_plan_one_active_idx
  ON changfu.subscription_plan_versions (plan_code)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS changfu_admin.official_model_config_versions (
  config_version_id uuid PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version >= 1),
  display_name varchar(80) NOT NULL,
  protocol varchar(32) NOT NULL
    CHECK (protocol IN ('OPENAI_RESPONSES', 'OPENAI_CHAT_COMPLETIONS')),
  endpoint varchar(2048) NOT NULL,
  model varchar(200) NOT NULL,
  api_key_ciphertext bytea NOT NULL,
  api_key_nonce bytea NOT NULL,
  api_key_auth_tag bytea NOT NULL,
  api_key_last_four varchar(4) NOT NULL,
  key_version smallint NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  status varchar(16) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  test_status varchar(16) NOT NULL DEFAULT 'UNTESTED'
    CHECK (test_status IN ('UNTESTED', 'SUCCEEDED', 'FAILED')),
  test_error_code varchar(100),
  tested_at timestamptz,
  created_by uuid NOT NULL
    REFERENCES changfu_admin.admin_users(admin_user_id),
  activated_by uuid
    REFERENCES changfu_admin.admin_users(admin_user_id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  CHECK (length(trim(endpoint)) BETWEEN 1 AND 2048),
  CHECK (length(trim(model)) BETWEEN 1 AND 200),
  CHECK (octet_length(api_key_ciphertext) BETWEEN 8 AND 8192),
  CHECK (octet_length(api_key_nonce) = 12),
  CHECK (octet_length(api_key_auth_tag) = 16),
  CHECK (length(api_key_last_four) = 4),
  CHECK (
    (status = 'ACTIVE' AND test_status = 'SUCCEEDED'
      AND activated_by IS NOT NULL AND activated_at IS NOT NULL)
    OR status <> 'ACTIVE'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_admin_official_model_one_active_idx
  ON changfu_admin.official_model_config_versions ((true))
  WHERE status = 'ACTIVE';

REVOKE ALL ON SCHEMA changfu_admin FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA changfu_admin FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA changfu_admin FROM PUBLIC;

COMMIT;
