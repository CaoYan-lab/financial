BEGIN;

CREATE TABLE IF NOT EXISTS changfu.quantitative_research_pools (
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL CHECK (provider_id IN ('FUTU', 'LONGBRIDGE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  universe_source text NOT NULL,
  universe_accessed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS changfu.quantitative_research_pool_items (
  item_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL CHECK (provider_id IN ('FUTU', 'LONGBRIDGE')),
  pool_version bigint NOT NULL CHECK (pool_version >= 1),
  market_cap_rank smallint NOT NULL CHECK (market_cap_rank BETWEEN 1 AND 30),
  ticker varchar(32) NOT NULL,
  provider_symbol varchar(128) NOT NULL,
  display_name varchar(200) NOT NULL,
  market_cap_text varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, provider_id)
    REFERENCES changfu.quantitative_research_pools(user_id, provider_id),
  UNIQUE (user_id, provider_id, pool_version, ticker),
  UNIQUE (user_id, provider_id, pool_version, market_cap_rank)
);

CREATE INDEX IF NOT EXISTS changfu_quantitative_pool_items_lookup_idx
  ON changfu.quantitative_research_pool_items
  (user_id, provider_id, pool_version, market_cap_rank);

CREATE TABLE IF NOT EXISTS changfu.quantitative_report_runs (
  run_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL CHECK (provider_id IN ('FUTU', 'LONGBRIDGE')),
  pool_version bigint NOT NULL CHECK (pool_version >= 1),
  prompt_version varchar(64) NOT NULL,
  scoring_version varchar(64) NOT NULL,
  model_profile varchar(128),
  status varchar(20) NOT NULL CHECK (
    status IN ('COLLECTING', 'SCORING', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  symbol_count smallint NOT NULL DEFAULT 30 CHECK (symbol_count = 30),
  terminal_count smallint NOT NULL DEFAULT 0 CHECK (terminal_count BETWEEN 0 AND 30),
  completed_count smallint NOT NULL DEFAULT 0 CHECK (completed_count BETWEEN 0 AND 30),
  rejected_count smallint NOT NULL DEFAULT 0 CHECK (rejected_count BETWEEN 0 AND 30),
  unavailable_count smallint NOT NULL DEFAULT 0 CHECK (unavailable_count BETWEEN 0 AND 30),
  candidate_count smallint NOT NULL DEFAULT 0 CHECK (candidate_count BETWEEN 0 AND 30),
  data_gap_count integer NOT NULL DEFAULT 0 CHECK (data_gap_count >= 0),
  source_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb,
  markdown text,
  error_code varchar(100),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (user_id, provider_id)
    REFERENCES changfu.quantitative_research_pools(user_id, provider_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS changfu_quantitative_active_run_idx
  ON changfu.quantitative_report_runs (user_id, provider_id)
  WHERE status IN ('COLLECTING', 'SCORING', 'FINALIZING');

CREATE INDEX IF NOT EXISTS changfu_quantitative_runs_history_idx
  ON changfu.quantitative_report_runs (user_id, provider_id, started_at DESC);

CREATE TABLE IF NOT EXISTS changfu.quantitative_report_items (
  run_id uuid NOT NULL REFERENCES changfu.quantitative_report_runs(run_id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id),
  provider_id varchar(32) NOT NULL CHECK (provider_id IN ('FUTU', 'LONGBRIDGE')),
  request_id uuid NOT NULL UNIQUE,
  symbol varchar(128) NOT NULL,
  ticker varchar(32) NOT NULL,
  market_cap_rank smallint NOT NULL CHECK (market_cap_rank BETWEEN 1 AND 30),
  status varchar(16) NOT NULL CHECK (
    status IN ('PENDING', 'COMPLETED', 'REJECTED', 'UNAVAILABLE')
  ),
  broker_observation jsonb,
  official_evidence jsonb,
  model_result jsonb,
  analysis jsonb,
  error_code varchar(100),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (run_id, symbol),
  UNIQUE (run_id, ticker)
);

CREATE INDEX IF NOT EXISTS changfu_quantitative_items_status_idx
  ON changfu.quantitative_report_items (run_id, status, market_cap_rank);

CREATE TABLE IF NOT EXISTS changfu.quantitative_public_source_cache (
  source varchar(16) NOT NULL CHECK (source IN ('SEC', 'FINRA')),
  cache_key varchar(256) NOT NULL,
  as_of timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  checksum char(64) NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (source, cache_key)
);

CREATE INDEX IF NOT EXISTS changfu_quantitative_source_cache_expiry_idx
  ON changfu.quantitative_public_source_cache (source, expires_at);

COMMIT;
