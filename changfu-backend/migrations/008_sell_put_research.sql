BEGIN;

CREATE TABLE IF NOT EXISTS changfu.sell_put_research_pools (
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL CHECK (provider_id IN ('FUTU', 'LONGBRIDGE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS changfu.sell_put_research_pool_items (
  item_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL CHECK (provider_id IN ('FUTU', 'LONGBRIDGE')),
  symbol varchar(128) NOT NULL,
  display_name varchar(200) NOT NULL,
  market varchar(8) NOT NULL CHECK (market IN ('US', 'HK')),
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, provider_id)
    REFERENCES changfu.sell_put_research_pools(user_id, provider_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_sell_put_pool_active_symbol_idx
  ON changfu.sell_put_research_pool_items (user_id, provider_id, symbol)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS changfu_sell_put_pool_items_idx
  ON changfu.sell_put_research_pool_items (user_id, provider_id, added_at);

CREATE TABLE IF NOT EXISTS changfu.sell_put_report_runs (
  run_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL CHECK (provider_id IN ('FUTU', 'LONGBRIDGE')),
  pool_version bigint NOT NULL,
  report_window_days smallint NOT NULL DEFAULT 30 CHECK (report_window_days = 30),
  prompt_version varchar(64) NOT NULL DEFAULT 'research-sell-put-v1',
  status varchar(20) NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  symbol_count integer NOT NULL CHECK (symbol_count BETWEEN 1 AND 30),
  candidate_count integer NOT NULL DEFAULT 0,
  data_gap_count integer NOT NULL DEFAULT 0,
  data_quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb,
  markdown text,
  error_code varchar(100),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS changfu_sell_put_runs_user_time_idx
  ON changfu.sell_put_report_runs (user_id, provider_id, started_at DESC);

CREATE TABLE IF NOT EXISTS changfu.sell_put_report_items (
  run_id uuid NOT NULL REFERENCES changfu.sell_put_report_runs(run_id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  symbol varchar(128) NOT NULL,
  source_snapshot jsonb NOT NULL,
  analysis jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, symbol)
);

CREATE INDEX IF NOT EXISTS changfu_sell_put_report_items_user_idx
  ON changfu.sell_put_report_items (user_id, created_at DESC);

COMMIT;
