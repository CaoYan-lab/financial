BEGIN;

ALTER TABLE changfu.broker_connections
  DROP CONSTRAINT IF EXISTS broker_connections_broker_check;
ALTER TABLE changfu.broker_connections
  ADD CONSTRAINT broker_connections_broker_check
  CHECK (broker IN ('FUTU', 'LONGBRIDGE'));

CREATE TABLE IF NOT EXISTS changfu.trading_catalog_versions (
  catalog_version varchar(64) PRIMARY KEY,
  content_hash char(64) NOT NULL UNIQUE,
  published_at timestamptz NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.research_entitlements (
  user_id bigint PRIMARY KEY REFERENCES public.cloud_users(id),
  status varchar(20) NOT NULL CHECK (status IN ('UNAVAILABLE', 'ACTIVE', 'EXPIRED')),
  plan_name varchar(64),
  capacity smallint NOT NULL CHECK (capacity BETWEEN 0 AND 100),
  replacement_limit smallint NOT NULL DEFAULT 0 CHECK (replacement_limit BETWEEN 0 AND 1000),
  replacement_used smallint NOT NULL DEFAULT 0 CHECK (replacement_used BETWEEN 0 AND 1000),
  renews_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.research_pools (
  user_id bigint PRIMARY KEY REFERENCES public.cloud_users(id),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.research_pool_items (
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  symbol varchar(32) NOT NULL,
  market varchar(8) NOT NULL CHECK (market IN ('US', 'HK')),
  instrument_type varchar(16) NOT NULL CHECK (instrument_type IN ('STOCK', 'ETF')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS changfu.trading_configs (
  broker_connection_id uuid PRIMARY KEY REFERENCES changfu.broker_connections(broker_connection_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider varchar(16) NOT NULL CHECK (provider IN ('FUTU', 'LONGBRIDGE')),
  version bigint NOT NULL CHECK (version >= 1),
  catalog_version varchar(64) NOT NULL REFERENCES changfu.trading_catalog_versions(catalog_version),
  execution_mode varchar(24) NOT NULL CHECK (execution_mode IN ('DIRECT', 'CANDIDATE_POOL')),
  confirmation_mode varchar(32) NOT NULL CHECK (
    confirmation_mode IN ('MANUAL_CONFIRM', 'AUTO_EXECUTE_PREFERENCE')
  ),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (config ?| ARRAY['promptBody', 'providerDeploymentId', 'apiKey', 'secret']))
);

CREATE TABLE IF NOT EXISTS changfu.trading_config_versions (
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  version bigint NOT NULL CHECK (version >= 1),
  catalog_version varchar(64) NOT NULL REFERENCES changfu.trading_catalog_versions(catalog_version),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (broker_connection_id, version),
  CHECK (NOT (config ?| ARRAY['promptBody', 'providerDeploymentId', 'apiKey', 'secret']))
);

CREATE TABLE IF NOT EXISTS changfu.trading_sessions (
  session_id uuid PRIMARY KEY,
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  app_session_id uuid NOT NULL,
  mode varchar(20) NOT NULL CHECK (mode = 'AUTO_EXECUTE'),
  status varchar(20) NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'DEACTIVATED')),
  config_version bigint NOT NULL CHECK (config_version >= 1),
  risk_policy_version varchar(64) NOT NULL,
  confirmation_digest char(64) NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_trading_sessions_active_idx
  ON changfu.trading_sessions (broker_connection_id)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS changfu.candidate_pool_items (
  candidate_id uuid PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES changfu.signals(signal_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  symbol varchar(32) NOT NULL,
  side varchar(8) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  status varchar(20) NOT NULL CHECK (
    status IN ('PENDING', 'PROMOTED', 'WATCH', 'SUPPRESSED', 'EXPIRED')
  ),
  rank integer CHECK (rank IS NULL OR rank >= 1),
  pool_version bigint NOT NULL CHECK (pool_version >= 1),
  config_version bigint NOT NULL CHECK (config_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS changfu_candidates_account_status_idx
  ON changfu.candidate_pool_items (broker_connection_id, status, expires_at);

ALTER TABLE changfu.pending_orders
  ADD COLUMN IF NOT EXISTS provider varchar(16),
  ADD COLUMN IF NOT EXISTS trading_session_id uuid REFERENCES changfu.trading_sessions(session_id),
  ADD COLUMN IF NOT EXISTS research_pool_version bigint,
  ADD COLUMN IF NOT EXISTS trading_config_version bigint,
  ADD COLUMN IF NOT EXISTS risk_policy_version varchar(64),
  ADD COLUMN IF NOT EXISTS execution_mode varchar(20),
  ADD COLUMN IF NOT EXISTS client_revalidation jsonb;

COMMIT;
