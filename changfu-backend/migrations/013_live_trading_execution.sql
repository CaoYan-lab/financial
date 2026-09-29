BEGIN;

CREATE TABLE IF NOT EXISTS changfu.user_provider_execution_settings (
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider varchar(16) NOT NULL CHECK (provider IN ('FUTU', 'LONGBRIDGE')),
  auto_submit_enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

ALTER TABLE changfu.candidate_pool_items
  ADD COLUMN IF NOT EXISTS order_draft jsonb;

ALTER TABLE changfu.signals
  ADD COLUMN IF NOT EXISTS lifecycle_status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_signal_id uuid REFERENCES changfu.signals(signal_id),
  ADD COLUMN IF NOT EXISTS valid_until timestamptz;

ALTER TABLE changfu.signals
  DROP CONSTRAINT IF EXISTS signals_lifecycle_status_check;
ALTER TABLE changfu.signals
  ADD CONSTRAINT signals_lifecycle_status_check
  CHECK (lifecycle_status IN ('ACTIVE', 'SUPERSEDED', 'EXPIRED'));

ALTER TABLE changfu.pending_orders
  ADD COLUMN IF NOT EXISTS symbol varchar(32),
  ADD COLUMN IF NOT EXISTS normalized_symbol varchar(32),
  ADD COLUMN IF NOT EXISTS side varchar(16),
  ADD COLUMN IF NOT EXISTS position_effect varchar(20),
  ADD COLUMN IF NOT EXISTS submission_mode varchar(20),
  ADD COLUMN IF NOT EXISTS signal_valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_signal_id uuid REFERENCES changfu.signals(signal_id),
  ADD COLUMN IF NOT EXISTS cancel_reason_code varchar(100),
  ADD COLUMN IF NOT EXISTS last_cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_uncertain_since timestamptz,
  ADD COLUMN IF NOT EXISTS reconcile_deadline timestamptz;

UPDATE changfu.pending_orders AS pending
   SET provider = COALESCE(pending.provider, connection.broker),
       symbol = COALESCE(pending.symbol, pending.order_spec ->> 'symbol'),
       normalized_symbol = COALESCE(
         pending.normalized_symbol,
         CASE
           WHEN upper(COALESCE(pending.symbol, pending.order_spec ->> 'symbol')) ~ '^(US|HK)\.'
             THEN upper(COALESCE(pending.symbol, pending.order_spec ->> 'symbol'))
           WHEN upper(COALESCE(pending.symbol, pending.order_spec ->> 'symbol')) ~ '\.(US|HK)$'
             THEN regexp_replace(
               upper(COALESCE(pending.symbol, pending.order_spec ->> 'symbol')),
               '^(.+)\.(US|HK)$',
               '\2.\1'
             )
           ELSE upper(COALESCE(pending.symbol, pending.order_spec ->> 'symbol'))
         END
       ),
       side = upper(COALESCE(pending.side, pending.order_spec ->> 'side')),
       position_effect = upper(COALESCE(
         pending.position_effect,
         pending.order_spec ->> 'positionEffect'
       )),
       submission_mode = COALESCE(
         pending.submission_mode,
         CASE pending.execution_mode
           WHEN 'AUTO_EXECUTE' THEN 'AUTO_EXECUTE'
           ELSE 'MANUAL_CONFIRM'
         END
       ),
       signal_valid_until = COALESCE(pending.signal_valid_until, pending.expires_at)
  FROM changfu.broker_connections AS connection
 WHERE connection.broker_connection_id = pending.broker_connection_id
   AND (
     pending.provider IS NULL
     OR pending.symbol IS NULL
     OR pending.normalized_symbol IS NULL
     OR pending.side IS NULL
     OR pending.position_effect IS NULL
     OR pending.submission_mode IS NULL
     OR pending.signal_valid_until IS NULL
   );

DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*)
    INTO invalid_count
    FROM changfu.pending_orders
   WHERE provider IS NULL
      OR symbol IS NULL
      OR normalized_symbol IS NULL
      OR side NOT IN ('BUY', 'SELL')
      OR position_effect NOT IN (
        'OPEN_LONG', 'ADD_LONG', 'REDUCE_LONG',
        'OPEN_SHORT', 'ADD_SHORT', 'COVER_SHORT'
      )
      OR submission_mode NOT IN ('MANUAL_CONFIRM', 'AUTO_EXECUTE')
      OR signal_valid_until IS NULL;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'migration 013 found % pending_orders rows requiring manual reconciliation',
      invalid_count;
  END IF;
END
$$;

ALTER TABLE changfu.pending_orders
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN symbol SET NOT NULL,
  ALTER COLUMN normalized_symbol SET NOT NULL,
  ALTER COLUMN side SET NOT NULL,
  ALTER COLUMN position_effect SET NOT NULL,
  ALTER COLUMN submission_mode SET NOT NULL,
  ALTER COLUMN signal_valid_until SET NOT NULL;

ALTER TABLE changfu.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_state_check;
ALTER TABLE changfu.pending_orders
  ADD CONSTRAINT pending_orders_state_check CHECK (state IN (
    'PENDING_CONFIRMATION', 'CLAIMED', 'SUBMITTING', 'SUBMITTED', 'TRACKING',
    'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'CANCEL_PENDING', 'CANCEL_UNCERTAIN',
    'UNKNOWN', 'SUPERSEDED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'EXPIRED'
  ));

ALTER TABLE changfu.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_side_check;
ALTER TABLE changfu.pending_orders
  ADD CONSTRAINT pending_orders_side_check
  CHECK (side IN ('BUY', 'SELL'));

ALTER TABLE changfu.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_position_effect_check;
ALTER TABLE changfu.pending_orders
  ADD CONSTRAINT pending_orders_position_effect_check CHECK (position_effect IN (
    'OPEN_LONG', 'ADD_LONG', 'REDUCE_LONG', 'OPEN_SHORT', 'ADD_SHORT', 'COVER_SHORT'
  ));

ALTER TABLE changfu.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_submission_mode_check;
ALTER TABLE changfu.pending_orders
  ADD CONSTRAINT pending_orders_submission_mode_check
  CHECK (submission_mode IN ('MANUAL_CONFIRM', 'AUTO_EXECUTE'));

ALTER TABLE changfu.pending_orders
  ADD COLUMN IF NOT EXISTS is_terminal boolean GENERATED ALWAYS AS (
    state IN ('SUPERSEDED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'EXPIRED')
  ) STORED;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM changfu.pending_orders
     WHERE NOT is_terminal
     GROUP BY user_id, broker_connection_id, normalized_symbol
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'migration 013 requires reconciliation of duplicate active system orders';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS changfu_pending_orders_active_symbol_idx
  ON changfu.pending_orders (user_id, broker_connection_id, normalized_symbol)
  WHERE NOT is_terminal;

CREATE INDEX IF NOT EXISTS changfu_pending_orders_expiry_idx
  ON changfu.pending_orders (expires_at)
  WHERE NOT is_terminal;

CREATE INDEX IF NOT EXISTS changfu_pending_orders_signal_expiry_idx
  ON changfu.pending_orders (signal_valid_until)
  WHERE NOT is_terminal;

CREATE INDEX IF NOT EXISTS changfu_pending_orders_reconcile_idx
  ON changfu.pending_orders (reconcile_deadline)
  WHERE state = 'CANCEL_UNCERTAIN';

ALTER TABLE changfu.order_executions
  ADD COLUMN IF NOT EXISTS provider varchar(16),
  ADD COLUMN IF NOT EXISTS broker_connection_id uuid REFERENCES changfu.broker_connections(broker_connection_id),
  ADD COLUMN IF NOT EXISTS status varchar(24) NOT NULL DEFAULT 'SUBMITTING',
  ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS response_summary jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE changfu.order_executions AS execution
   SET provider = pending.provider,
       broker_connection_id = pending.broker_connection_id
  FROM changfu.pending_orders AS pending
 WHERE execution.intent_id = pending.intent_id
   AND (execution.provider IS NULL OR execution.broker_connection_id IS NULL);

ALTER TABLE changfu.order_executions
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN broker_connection_id SET NOT NULL;

ALTER TABLE changfu.order_executions
  DROP CONSTRAINT IF EXISTS order_executions_provider_check;
ALTER TABLE changfu.order_executions
  ADD CONSTRAINT order_executions_provider_check
  CHECK (provider IN ('FUTU', 'LONGBRIDGE'));

ALTER TABLE changfu.order_executions
  DROP CONSTRAINT IF EXISTS order_executions_status_check;
ALTER TABLE changfu.order_executions
  ADD CONSTRAINT order_executions_status_check CHECK (status IN (
    'SUBMITTING', 'SUBMITTED', 'FAILED', 'UNKNOWN'
  ));

CREATE TABLE IF NOT EXISTS changfu.order_actions (
  action_id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES changfu.pending_orders(intent_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  device_id uuid NOT NULL REFERENCES changfu.devices(device_id),
  provider varchar(16) NOT NULL CHECK (provider IN ('FUTU', 'LONGBRIDGE')),
  broker_connection_id uuid NOT NULL REFERENCES changfu.broker_connections(broker_connection_id),
  action_type varchar(16) NOT NULL CHECK (action_type = 'CANCEL'),
  reason_code varchar(100) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  state varchar(24) NOT NULL CHECK (
    state IN ('PENDING', 'CLAIMED', 'EXECUTING', 'COMPLETED', 'FAILED', 'UNKNOWN')
  ),
  claim_token_hash char(64),
  claim_expires_at timestamptz,
  result_summary jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, action_type),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS changfu_order_actions_connection_state_idx
  ON changfu.order_actions (user_id, broker_connection_id, state, created_at);

ALTER TABLE changfu.order_events
  ADD COLUMN IF NOT EXISTS provider varchar(16),
  ADD COLUMN IF NOT EXISTS broker_connection_id uuid REFERENCES changfu.broker_connections(broker_connection_id);

UPDATE changfu.order_events AS event
   SET provider = pending.provider,
       broker_connection_id = pending.broker_connection_id
  FROM changfu.pending_orders AS pending
 WHERE event.intent_id = pending.intent_id
   AND (event.provider IS NULL OR event.broker_connection_id IS NULL);

ALTER TABLE changfu.order_events
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN broker_connection_id SET NOT NULL;

ALTER TABLE changfu.order_events
  DROP CONSTRAINT IF EXISTS order_events_provider_check;
ALTER TABLE changfu.order_events
  ADD CONSTRAINT order_events_provider_check
  CHECK (provider IN ('FUTU', 'LONGBRIDGE'));

CREATE INDEX IF NOT EXISTS changfu_order_events_provider_connection_idx
  ON changfu.order_events (user_id, provider, broker_connection_id, occurred_at DESC);

COMMIT;
