BEGIN;

CREATE SCHEMA IF NOT EXISTS changfu;

CREATE TABLE IF NOT EXISTS changfu.devices (
  device_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  display_name varchar(120) NOT NULL,
  platform varchar(16) NOT NULL CHECK (platform IN ('MACOS', 'WINDOWS')),
  app_version varchar(32) NOT NULL,
  public_key text NOT NULL,
  fingerprint_hash char(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS changfu_devices_user_idx ON changfu.devices (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS changfu_devices_user_fingerprint_idx
  ON changfu.devices (user_id, fingerprint_hash);

CREATE TABLE IF NOT EXISTS changfu.device_sessions (
  session_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  refresh_token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.broker_connections (
  broker_connection_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  broker varchar(16) NOT NULL CHECK (broker = 'FUTU'),
  display_name varchar(120) NOT NULL,
  account_id_hash char(64) NOT NULL,
  environment varchar(16) NOT NULL CHECK (environment IN ('SIMULATE', 'REAL')),
  status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, broker, account_id_hash, environment)
);

CREATE TABLE IF NOT EXISTS changfu.trading_leases (
  broker_connection_id uuid PRIMARY KEY REFERENCES changfu.broker_connections(broker_connection_id),
  lease_id uuid NOT NULL UNIQUE,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  version bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.strategy_configs (
  strategy_config_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  version varchar(64) NOT NULL,
  prompt_version varchar(64) NOT NULL,
  config jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, broker_connection_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_strategy_active_idx
  ON changfu.strategy_configs (user_id, broker_connection_id)
  WHERE active;

CREATE TABLE IF NOT EXISTS changfu.model_runs (
  request_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  purpose varchar(32) NOT NULL,
  content_hash char(64) NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 2097152),
  item_counts jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  source_expires_at timestamptz NOT NULL,
  requested_symbols varchar(32)[] NOT NULL DEFAULT '{}',
  model varchar(120) NOT NULL,
  prompt_version varchar(64) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'REJECTED', 'INTERRUPTED')),
  result jsonb,
  error_code varchar(100),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (NOT (result ?| ARRAY['account', 'positions', 'quotes', 'minuteBars', 'tickerPoints', 'orderBooks']))
);

CREATE INDEX IF NOT EXISTS changfu_model_runs_user_time_idx
  ON changfu.model_runs (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS changfu.signals (
  signal_id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES changfu.model_runs(request_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  symbol varchar(32) NOT NULL,
  action varchar(32) NOT NULL,
  evidence_summary jsonb NOT NULL,
  risk_summary jsonb NOT NULL,
  exit_condition text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.pending_orders (
  intent_id uuid PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES changfu.signals(signal_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  account_id_hash char(64) NOT NULL,
  context_hash char(64) NOT NULL,
  strategy_version varchar(64) NOT NULL,
  order_spec jsonb NOT NULL,
  state varchar(32) NOT NULL CHECK (state IN (
    'PENDING_CONFIRMATION', 'CLAIMED', 'SUBMITTING', 'SUBMITTED',
    'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED',
    'REJECTED', 'FAILED', 'EXPIRED'
  )),
  signature text NOT NULL,
  signing_key_id varchar(64) NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claim_token_hash char(64),
  claim_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS changfu_pending_orders_user_state_idx
  ON changfu.pending_orders (user_id, state, issued_at DESC);

CREATE TABLE IF NOT EXISTS changfu.order_executions (
  execution_id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES changfu.pending_orders(intent_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  idempotency_key varchar(128) NOT NULL,
  broker_order_id varchar(128),
  broker_request_hash char(64) NOT NULL,
  result_code varchar(100),
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (intent_id)
);

CREATE TABLE IF NOT EXISTS changfu.order_events (
  event_id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES changfu.pending_orders(intent_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  broker_order_id varchar(128),
  event_type varchar(32) NOT NULL,
  quantity numeric(28, 10) NOT NULL,
  filled_quantity numeric(28, 10) NOT NULL,
  average_price numeric(28, 10),
  reason_code varchar(100),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS changfu_order_events_intent_time_idx
  ON changfu.order_events (intent_id, occurred_at);

CREATE TABLE IF NOT EXISTS changfu.reports (
  report_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  broker_connection_id uuid REFERENCES changfu.broker_connections(broker_connection_id),
  title varchar(200) NOT NULL,
  report_type varchar(40) NOT NULL,
  parameters jsonb NOT NULL,
  body jsonb NOT NULL,
  model varchar(120),
  prompt_version varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.conversations (
  conversation_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  title varchar(120) NOT NULL,
  platform varchar(20) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS changfu_conversations_user_time_idx
  ON changfu.conversations (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS changfu.messages (
  message_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES changfu.conversations(conversation_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  role varchar(16) NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'SYSTEM')),
  content text NOT NULL,
  reference_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS changfu_messages_conversation_time_idx
  ON changfu.messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS changfu.ad_configs (
  campaign_id uuid PRIMARY KEY,
  placement varchar(16) NOT NULL CHECK (placement IN ('startup', 'overlay')),
  enabled boolean NOT NULL DEFAULT false,
  duration_seconds smallint NOT NULL CHECK (duration_seconds BETWEEN 1 AND 30),
  local_asset_id varchar(64) NOT NULL CHECK (local_asset_id IN ('startup_default', 'overlay_default')),
  priority integer NOT NULL DEFAULT 0,
  version integer NOT NULL CHECK (version >= 1),
  starts_at timestamptz,
  ends_at timestamptz,
  created_by bigint NOT NULL REFERENCES public.cloud_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS changfu_ad_configs_active_idx
  ON changfu.ad_configs (placement, enabled, priority DESC);

CREATE TABLE IF NOT EXISTS changfu.ad_deliveries (
  delivery_id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES changfu.ad_configs(campaign_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  campaign_version integer NOT NULL,
  event_type varchar(20) NOT NULL CHECK (event_type IN ('SHOWN', 'SKIPPED', 'AUTO_CLOSED', 'DEFERRED')),
  occurred_at timestamptz NOT NULL,
  UNIQUE (campaign_id, campaign_version, device_id, event_type)
);

CREATE TABLE IF NOT EXISTS changfu.security_audit (
  audit_id uuid PRIMARY KEY,
  user_id bigint REFERENCES public.cloud_users(id),
  device_id uuid,
  event_type varchar(80) NOT NULL,
  outcome varchar(20) NOT NULL,
  request_id uuid,
  source_ip inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (metadata ?| ARRAY['password', 'token', 'refreshToken', 'context', 'prompt']))
);

CREATE TABLE IF NOT EXISTS changfu.idempotency_records (
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  operation varchar(80) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation, idempotency_key),
  CHECK (NOT (response_body ?| ARRAY['account', 'positions', 'quotes', 'minuteBars', 'tickerPoints', 'orderBooks']))
);

CREATE INDEX IF NOT EXISTS changfu_idempotency_expiry_idx
  ON changfu.idempotency_records (expires_at);

COMMIT;
