-- 多用户账户与券商数据隔离。独立 schema，避免改动现有业务表。
CREATE SCHEMA IF NOT EXISTS multiuser;

CREATE TABLE IF NOT EXISTS multiuser.user_profiles (
    user_id BIGINT PRIMARY KEY REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    sessions_valid_after TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
    created_by BIGINT REFERENCES public.cloud_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_multiuser_single_owner
    ON multiuser.user_profiles(role) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS multiuser.broker_connections (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('longbridge')),
    credential_source TEXT NOT NULL CHECK (credential_source IN ('legacy_env', 'encrypted_bundle')),
    credential_ciphertext TEXT,
    credential_iv TEXT,
    credential_auth_tag TEXT,
    key_version INTEGER NOT NULL DEFAULT 1,
    account_fingerprint TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'invalid', 'disabled')),
    token_expires_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_multiuser_active_connection
    ON multiuser.broker_connections(user_id, platform)
    WHERE status = 'verified';

CREATE TABLE IF NOT EXISTS multiuser.futu_owner_secret (
    owner_user_id BIGINT PRIMARY KEY REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS multiuser.futu_unlock_sessions (
    id TEXT PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    ip_hash TEXT,
    user_agent_hash TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_futu_unlock_active
    ON multiuser.futu_unlock_sessions(owner_user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS multiuser.longbridge_engine_state (
    user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES multiuser.broker_connections(id) ON DELETE CASCADE,
    desired TEXT NOT NULL DEFAULT 'stopped' CHECK (desired IN ('running', 'stopped')),
    mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
    live_trading_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    auto_submit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    auto_cancel_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    shadow_verified_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, binding_id)
);

CREATE TABLE IF NOT EXISTS multiuser.longbridge_jobs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES multiuser.broker_connections(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    claimed_by TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_multiuser_jobs_claim
    ON multiuser.longbridge_jobs(status, run_after, id);
CREATE INDEX IF NOT EXISTS idx_multiuser_jobs_tenant
    ON multiuser.longbridge_jobs(user_id, binding_id, created_at DESC);

CREATE TABLE IF NOT EXISTS multiuser.longbridge_worker_snapshots (
    user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES multiuser.broker_connections(id) ON DELETE CASCADE,
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, binding_id)
);

CREATE TABLE IF NOT EXISTS multiuser.longbridge_events (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES multiuser.broker_connections(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ticker TEXT,
    side TEXT,
    status TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_multiuser_events_tenant
    ON multiuser.longbridge_events(user_id, binding_id, kind, created_at DESC, id DESC);

DELETE FROM multiuser.longbridge_events
WHERE kind = 'signals'
  AND status = 'SKIPPED'
  AND payload->>'lifecycleStatus' = 'SKIPPED'
  AND upper(COALESCE(payload->>'marketState', '')) IN (
      'CLOSED', 'REST', 'NONE', 'UNAVAILABLE', 'OVERNIGHT', 'NIGHT', 'NIGHT_OPEN'
  )
  AND (
      COALESCE(payload->>'lifecycleReason', payload->>'reason', '') LIKE '%LLM 请求已关闭%'
      OR COALESCE(payload->>'lifecycleReason', payload->>'reason', '') LIKE '%周末、节假日或休市状态%'
  );

CREATE TABLE IF NOT EXISTS multiuser.longbridge_managed_orders (
    user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES multiuser.broker_connections(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    pending_order_id TEXT,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    status TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, binding_id, order_id)
);

CREATE TABLE IF NOT EXISTS multiuser.longbridge_order_events (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES multiuser.broker_connections(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    request_id TEXT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, binding_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_multiuser_order_events
    ON multiuser.longbridge_order_events(user_id, binding_id, order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS multiuser.security_audit (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id BIGINT REFERENCES public.cloud_users(id),
    target_user_id BIGINT REFERENCES public.cloud_users(id),
    event_type TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    success BOOLEAN NOT NULL,
    ip_hash TEXT,
    user_agent_hash TEXT,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_multiuser_audit_actor
    ON multiuser.security_audit(actor_user_id, created_at DESC);
