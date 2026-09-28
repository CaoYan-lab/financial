BEGIN;

DO $$
BEGIN
  IF to_regclass('changfu.research_pool_items') IS NOT NULL
     AND EXISTS (SELECT 1 FROM changfu.research_pool_items LIMIT 1) THEN
    RAISE EXCEPTION
      'migration 003 requires an explicit Provider assignment for legacy research_pool_items';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS changfu.subscription_catalog_releases (
  catalog_version varchar(64) PRIMARY KEY,
  content_hash char(64) NOT NULL UNIQUE,
  published_at timestamptz NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS changfu.broker_provider_catalog (
  provider_id varchar(32) PRIMARY KEY,
  display_name varchar(80) NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  supported_markets varchar(8)[] NOT NULL,
  supported_instrument_types varchar(16)[] NOT NULL,
  catalog_version varchar(64) NOT NULL
    REFERENCES changfu.subscription_catalog_releases(catalog_version),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(supported_markets) > 0),
  CHECK (supported_markets <@ ARRAY['US', 'HK', 'CN', 'SG']::varchar[]),
  CHECK (cardinality(supported_instrument_types) > 0),
  CHECK (
    supported_instrument_types
      <@ ARRAY['STOCK', 'ETF', 'OPTION']::varchar[]
  )
);

CREATE TABLE IF NOT EXISTS changfu.subscription_plan_versions (
  plan_version_id uuid PRIMARY KEY,
  plan_code varchar(32) NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  display_name varchar(80) NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  broker_slot_limit smallint NOT NULL CHECK (broker_slot_limit BETWEEN 1 AND 100),
  pool_capacity_per_provider integer
    CHECK (pool_capacity_per_provider IS NULL OR pool_capacity_per_provider > 0),
  monthly_replacement_limit integer
    CHECK (monthly_replacement_limit IS NULL OR monthly_replacement_limit >= 0),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  catalog_version varchar(64) NOT NULL
    REFERENCES changfu.subscription_catalog_releases(catalog_version),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_code, version),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (NOT (features ?| ARRAY[
    'password', 'token', 'secret', 'apiKey', 'privateKey', 'certificate'
  ]))
);

CREATE TABLE IF NOT EXISTS changfu.subscription_prices (
  price_id uuid PRIMARY KEY,
  plan_version_id uuid NOT NULL
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  billing_period varchar(16) NOT NULL
    CHECK (billing_period IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  duration_months smallint NOT NULL CHECK (duration_months IN (1, 3, 12)),
  currency char(3) NOT NULL CHECK (currency = 'CNY'),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_version_id, billing_period),
  CHECK (
    (billing_period = 'MONTHLY' AND duration_months = 1)
    OR (billing_period = 'QUARTERLY' AND duration_months = 3)
    OR (billing_period = 'YEARLY' AND duration_months = 12)
  )
);

CREATE TABLE IF NOT EXISTS changfu.user_subscriptions (
  subscription_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  plan_version_id uuid NOT NULL
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  billing_period varchar(16) NOT NULL
    CHECK (billing_period IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  status varchar(16) NOT NULL
    CHECK (status IN ('ACTIVE', 'FROZEN', 'CANCELLED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  purchased_at timestamptz NOT NULL,
  starts_at timestamptz NOT NULL,
  current_period_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  pending_plan_version_id uuid
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  pending_billing_period varchar(16)
    CHECK (pending_billing_period IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  pending_effective_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at <= current_period_start),
  CHECK (current_period_start < expires_at),
  CHECK (
    (pending_plan_version_id IS NULL
      AND pending_billing_period IS NULL
      AND pending_effective_at IS NULL)
    OR
    (pending_plan_version_id IS NOT NULL
      AND pending_billing_period IS NOT NULL
      AND pending_effective_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_user_subscriptions_current_idx
  ON changfu.user_subscriptions (user_id)
  WHERE status IN ('ACTIVE', 'FROZEN');

CREATE TABLE IF NOT EXISTS changfu.subscription_pending_provider_selections (
  subscription_id uuid NOT NULL
    REFERENCES changfu.user_subscriptions(subscription_id) ON DELETE CASCADE,
  provider_id varchar(32) NOT NULL
    REFERENCES changfu.broker_provider_catalog(provider_id),
  slot_ordinal smallint NOT NULL CHECK (slot_ordinal >= 1),
  PRIMARY KEY (subscription_id, provider_id),
  UNIQUE (subscription_id, slot_ordinal)
);

CREATE TABLE IF NOT EXISTS changfu.subscription_orders (
  order_id uuid PRIMARY KEY,
  business_order_no varchar(64) NOT NULL UNIQUE,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  subscription_id uuid REFERENCES changfu.user_subscriptions(subscription_id),
  order_type varchar(16) NOT NULL CHECK (order_type IN ('NEW', 'RENEW', 'UPGRADE')),
  plan_version_id uuid NOT NULL
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  price_id uuid NOT NULL REFERENCES changfu.subscription_prices(price_id),
  plan_code_snapshot varchar(32) NOT NULL,
  plan_version_snapshot integer NOT NULL CHECK (plan_version_snapshot >= 1),
  billing_period varchar(16) NOT NULL
    CHECK (billing_period IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  duration_months smallint NOT NULL CHECK (duration_months IN (1, 3, 12)),
  currency char(3) NOT NULL CHECK (currency = 'CNY'),
  original_amount_minor integer NOT NULL CHECK (original_amount_minor > 0),
  credit_amount_minor integer NOT NULL DEFAULT 0 CHECK (credit_amount_minor >= 0),
  payable_amount_minor integer NOT NULL CHECK (payable_amount_minor >= 0),
  credit_basis jsonb,
  status varchar(16) NOT NULL
    CHECK (status IN ('CREATED', 'PAYING', 'PAID', 'FAILED', 'CLOSED', 'REFUNDED')),
  payment_channel varchar(16)
    CHECK (payment_channel IN ('WECHAT', 'ALIPAY', 'DOUYIN')),
  provider_order_id varchar(128),
  provider_transaction_id varchar(128),
  idempotency_key varchar(128) NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  payment_started_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  closed_at timestamptz,
  refunded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (credit_amount_minor <= original_amount_minor),
  CHECK (payable_amount_minor = original_amount_minor - credit_amount_minor),
  CHECK (credit_basis IS NULL OR NOT (credit_basis ?| ARRAY[
    'password', 'token', 'secret', 'apiKey', 'privateKey', 'certificate'
  ]))
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_subscription_orders_provider_order_idx
  ON changfu.subscription_orders (payment_channel, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS changfu_subscription_orders_transaction_idx
  ON changfu.subscription_orders (payment_channel, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS changfu_subscription_orders_user_time_idx
  ON changfu.subscription_orders (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS changfu.subscription_order_provider_selections (
  order_id uuid NOT NULL REFERENCES changfu.subscription_orders(order_id) ON DELETE CASCADE,
  slot_ordinal smallint NOT NULL CHECK (slot_ordinal >= 1),
  provider_id varchar(32) NOT NULL
    REFERENCES changfu.broker_provider_catalog(provider_id),
  PRIMARY KEY (order_id, slot_ordinal),
  UNIQUE (order_id, provider_id)
);

CREATE TABLE IF NOT EXISTS changfu.payment_attempts (
  payment_attempt_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES changfu.subscription_orders(order_id),
  channel varchar(16) NOT NULL CHECK (channel IN ('WECHAT', 'ALIPAY', 'DOUYIN')),
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  status varchar(20) NOT NULL
    CHECK (status IN ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CLOSED')),
  provider_order_id varchar(128),
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code varchar(100),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, attempt_number),
  CHECK (NOT (request_metadata ?| ARRAY[
    'password', 'token', 'secret', 'apiKey', 'privateKey', 'certificate',
    'payerAccount', 'rawBody'
  ])),
  CHECK (NOT (response_metadata ?| ARRAY[
    'password', 'token', 'secret', 'apiKey', 'privateKey', 'certificate',
    'payerAccount', 'rawBody'
  ]))
);

CREATE TABLE IF NOT EXISTS changfu.payment_webhook_events (
  webhook_event_id uuid PRIMARY KEY,
  channel varchar(16) NOT NULL CHECK (channel IN ('WECHAT', 'ALIPAY', 'DOUYIN')),
  provider_event_id varchar(128) NOT NULL,
  provider_transaction_id varchar(128),
  order_id uuid REFERENCES changfu.subscription_orders(order_id),
  raw_body_hash char(64) NOT NULL,
  signature_valid boolean NOT NULL,
  merchant_valid boolean NOT NULL,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status varchar(20) NOT NULL
    CHECK (processing_status IN ('RECEIVED', 'PROCESSED', 'REJECTED', 'FAILED')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_code varchar(100),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (channel, provider_event_id),
  CHECK (NOT (metadata ?| ARRAY[
    'password', 'token', 'secret', 'apiKey', 'privateKey', 'certificate',
    'payerAccount', 'rawBody'
  ]))
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_payment_webhooks_transaction_idx
  ON changfu.payment_webhook_events (channel, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS changfu.subscription_events (
  subscription_event_id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES changfu.user_subscriptions(subscription_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  event_type varchar(32) NOT NULL CHECK (event_type IN (
    'PURCHASED', 'RENEWED', 'UPGRADED', 'CHANGE_SCHEDULED',
    'DOWNGRADED', 'EXPIRED', 'RESTORED'
  )),
  order_id uuid REFERENCES changfu.subscription_orders(order_id),
  previous_plan_version_id uuid
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  next_plan_version_id uuid
    REFERENCES changfu.subscription_plan_versions(plan_version_id),
  reason_code varchar(100),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (metadata ?| ARRAY[
    'password', 'token', 'secret', 'apiKey', 'privateKey', 'certificate'
  ]))
);

CREATE INDEX IF NOT EXISTS changfu_subscription_events_user_time_idx
  ON changfu.subscription_events (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS changfu.subscription_broker_slots (
  slot_id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES changfu.user_subscriptions(subscription_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  slot_ordinal smallint NOT NULL CHECK (slot_ordinal >= 1),
  provider_id varchar(32)
    REFERENCES changfu.broker_provider_catalog(provider_id),
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE', 'FROZEN', 'EMPTY')),
  bound_at timestamptz,
  next_rebind_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slot_ordinal),
  CHECK (
    (status = 'EMPTY' AND provider_id IS NULL
      AND bound_at IS NULL AND next_rebind_at IS NULL)
    OR
    (status IN ('ACTIVE', 'FROZEN') AND provider_id IS NOT NULL
      AND bound_at IS NOT NULL AND next_rebind_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_subscription_slots_provider_idx
  ON changfu.subscription_broker_slots (user_id, provider_id)
  WHERE provider_id IS NOT NULL AND status IN ('ACTIVE', 'FROZEN');

CREATE TABLE IF NOT EXISTS changfu.subscription_broker_binding_history (
  binding_event_id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES changfu.user_subscriptions(subscription_id),
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  slot_id uuid NOT NULL REFERENCES changfu.subscription_broker_slots(slot_id),
  previous_provider_id varchar(32)
    REFERENCES changfu.broker_provider_catalog(provider_id),
  next_provider_id varchar(32)
    REFERENCES changfu.broker_provider_catalog(provider_id),
  event_type varchar(24) NOT NULL
    CHECK (event_type IN ('BOUND', 'REBOUND', 'FROZEN', 'RESTORED')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_provider_id IS NOT NULL OR next_provider_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS changfu_binding_history_user_time_idx
  ON changfu.subscription_broker_binding_history (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS changfu.provider_research_pools (
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL
    REFERENCES changfu.broker_provider_catalog(provider_id),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE', 'FROZEN')),
  frozen_reason varchar(100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_id),
  CHECK (
    (status = 'ACTIVE' AND frozen_reason IS NULL)
    OR (status = 'FROZEN' AND frozen_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS changfu.provider_research_pool_items (
  item_id uuid PRIMARY KEY,
  user_id bigint NOT NULL,
  provider_id varchar(32) NOT NULL,
  provider_symbol varchar(128) NOT NULL,
  canonical_symbol varchar(128) NOT NULL,
  display_name varchar(200) NOT NULL,
  market varchar(8) NOT NULL CHECK (market IN ('US', 'HK', 'CN', 'SG')),
  instrument_type varchar(16) NOT NULL
    CHECK (instrument_type IN ('STOCK', 'ETF', 'OPTION')),
  option_type varchar(8) CHECK (option_type IN ('CALL', 'PUT')),
  underlying_symbol varchar(128),
  expiry_date date,
  strike_price numeric(28, 10),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  contract_multiplier numeric(28, 10),
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE', 'FROZEN', 'REMOVED')),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, provider_id)
    REFERENCES changfu.provider_research_pools(user_id, provider_id),
  CHECK (
    (
      instrument_type IN ('STOCK', 'ETF')
      AND option_type IS NULL
      AND underlying_symbol IS NULL
      AND expiry_date IS NULL
      AND strike_price IS NULL
      AND contract_multiplier IS NULL
    )
    OR
    (
      instrument_type = 'OPTION'
      AND option_type IS NOT NULL
      AND underlying_symbol IS NOT NULL
      AND expiry_date IS NOT NULL
      AND strike_price IS NOT NULL
      AND strike_price > 0
      AND contract_multiplier IS NOT NULL
      AND contract_multiplier > 0
    )
  ),
  CHECK (
    (status = 'REMOVED' AND removed_at IS NOT NULL)
    OR (status IN ('ACTIVE', 'FROZEN') AND removed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_provider_pool_items_active_symbol_idx
  ON changfu.provider_research_pool_items (user_id, provider_id, provider_symbol)
  WHERE status IN ('ACTIVE', 'FROZEN');

CREATE INDEX IF NOT EXISTS changfu_provider_pool_items_page_idx
  ON changfu.provider_research_pool_items (
    user_id, provider_id, status, added_at, item_id
  );

CREATE TABLE IF NOT EXISTS changfu.research_pool_mutation_events (
  mutation_event_id uuid PRIMARY KEY,
  user_id bigint NOT NULL,
  provider_id varchar(32) NOT NULL,
  item_id uuid NOT NULL REFERENCES changfu.provider_research_pool_items(item_id),
  event_type varchar(16) NOT NULL CHECK (event_type IN ('ADDED', 'REMOVED', 'RESTORED')),
  pool_version bigint NOT NULL CHECK (pool_version >= 1),
  replacement_window_start timestamptz,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, provider_id)
    REFERENCES changfu.provider_research_pools(user_id, provider_id),
  CHECK (
    (event_type = 'REMOVED' AND replacement_window_start IS NOT NULL)
    OR (event_type IN ('ADDED', 'RESTORED') AND replacement_window_start IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS changfu_pool_mutations_replacement_idx
  ON changfu.research_pool_mutation_events (
    user_id, provider_id, replacement_window_start, occurred_at
  )
  WHERE event_type = 'REMOVED';

INSERT INTO changfu.subscription_catalog_releases (
  catalog_version, content_hash, published_at
) VALUES (
  '2026.09.1',
  '10393069243172e99814a15335ae6c37aa8bf633e301d317efc3fe887152e9d9',
  '2026-09-19T00:00:00.000Z'
) ON CONFLICT (catalog_version) DO NOTHING;

INSERT INTO changfu.broker_provider_catalog (
  provider_id, display_name, status, supported_markets,
  supported_instrument_types, catalog_version
) VALUES
  (
    'FUTU', '富途', 'ACTIVE', ARRAY['US', 'HK', 'CN', 'SG']::varchar[],
    ARRAY['STOCK', 'ETF', 'OPTION']::varchar[], '2026.09.1'
  ),
  (
    'LONGBRIDGE', '长桥', 'ACTIVE', ARRAY['US', 'HK', 'CN', 'SG']::varchar[],
    ARRAY['STOCK', 'ETF', 'OPTION']::varchar[], '2026.09.1'
  )
ON CONFLICT (provider_id) DO NOTHING;

INSERT INTO changfu.subscription_plan_versions (
  plan_version_id, plan_code, version, display_name, status, effective_from,
  broker_slot_limit, pool_capacity_per_provider, monthly_replacement_limit,
  features, catalog_version
) VALUES
  (
    '00000000-0000-4000-8000-000000000101', 'LITE', 1, '轻量版', 'ACTIVE',
    '2026-09-19T00:00:00.000Z', 1, 5, 1,
    '{"batchSize":100,"optionResearch":true,"optionTrading":false}'::jsonb,
    '2026.09.1'
  ),
  (
    '00000000-0000-4000-8000-000000000102', 'PRO', 1, '高级版', 'ACTIVE',
    '2026-09-19T00:00:00.000Z', 2, 15, 15,
    '{"batchSize":100,"optionResearch":true,"optionTrading":false}'::jsonb,
    '2026.09.1'
  ),
  (
    '00000000-0000-4000-8000-000000000103', 'FLAGSHIP', 1, '旗舰版', 'ACTIVE',
    '2026-09-19T00:00:00.000Z', 5, NULL, NULL,
    '{"batchSize":100,"optionResearch":true,"optionTrading":false,"poolCapacityProtectionLimit":10000}'::jsonb,
    '2026.09.1'
  )
ON CONFLICT (plan_version_id) DO NOTHING;

INSERT INTO changfu.subscription_prices (
  price_id, plan_version_id, billing_period, duration_months, currency, amount_minor
) VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'MONTHLY', 1, 'CNY', 2900),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000101', 'QUARTERLY', 3, 'CNY', 7900),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000101', 'YEARLY', 12, 'CNY', 29900),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000102', 'MONTHLY', 1, 'CNY', 9900),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000102', 'QUARTERLY', 3, 'CNY', 26900),
  ('00000000-0000-4000-8000-000000000206', '00000000-0000-4000-8000-000000000102', 'YEARLY', 12, 'CNY', 99900),
  ('00000000-0000-4000-8000-000000000207', '00000000-0000-4000-8000-000000000103', 'MONTHLY', 1, 'CNY', 29900),
  ('00000000-0000-4000-8000-000000000208', '00000000-0000-4000-8000-000000000103', 'QUARTERLY', 3, 'CNY', 79900),
  ('00000000-0000-4000-8000-000000000209', '00000000-0000-4000-8000-000000000103', 'YEARLY', 12, 'CNY', 299900)
ON CONFLICT (price_id) DO NOTHING;

ALTER TABLE changfu.broker_connections
  DROP CONSTRAINT IF EXISTS broker_connections_broker_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'broker_connections_provider_fk'
       AND conrelid = 'changfu.broker_connections'::regclass
  ) THEN
    ALTER TABLE changfu.broker_connections
      ADD CONSTRAINT broker_connections_provider_fk
      FOREIGN KEY (broker)
      REFERENCES changfu.broker_provider_catalog(provider_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

COMMIT;
