-- 火山云端 PostgreSQL 结构定义
-- 与本地 SQLite 历史库结构对齐：事件表 payload 用 JSONB（驱动读取时 ::text 还原），
-- 时间列统一用 TEXT 保持与 SQLite 写入的 ISO-8601 字符串逐字节一致；云端业务表用 TIMESTAMPTZ。

-- ============ 历史事件表（镜像 SQLite） ============

-- Futu 美港股实盘事件（来源：live-trading-history.sqlite3 / live_events）
CREATE TABLE IF NOT EXISTS live_events (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    ticker TEXT,
    side TEXT,
    strategy TEXT,
    status TEXT,
    ok SMALLINT,
    created_at TEXT NOT NULL,
    payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_events_kind_created_at ON live_events(kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_live_events_ticker_created_at ON live_events(ticker, created_at DESC, id DESC);

-- Futu A 股实盘事件（来源：a-share-live-history.sqlite3 / live_events → 独立表隔离）
CREATE TABLE IF NOT EXISTS ashare_events (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    ticker TEXT,
    side TEXT,
    strategy TEXT,
    status TEXT,
    ok SMALLINT,
    created_at TEXT NOT NULL,
    payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ashare_events_kind_created_at ON ashare_events(kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ashare_events_ticker_created_at ON ashare_events(ticker, created_at DESC, id DESC);

-- 模拟盘事件（来源：simulation-history.sqlite3，无 status 列）
CREATE TABLE IF NOT EXISTS simulation_events (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    ticker TEXT,
    side TEXT,
    strategy TEXT,
    ok SMALLINT,
    created_at TEXT NOT NULL,
    payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sim_events_kind_created_at ON simulation_events(kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sim_events_ticker_created_at ON simulation_events(ticker, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS simulation_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS simulation_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Longbridge 实盘：一类一表（来源：live-trading-history.sqlite3 / longbridge_live_*）
CREATE TABLE IF NOT EXISTS longbridge_live_signals (
    id BIGSERIAL PRIMARY KEY, ticker TEXT, side TEXT, strategy TEXT, status TEXT, ok SMALLINT,
    created_at TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS longbridge_live_pending_orders (
    id BIGSERIAL PRIMARY KEY, ticker TEXT, side TEXT, strategy TEXT, status TEXT, ok SMALLINT,
    created_at TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS longbridge_live_submitted_orders (
    id BIGSERIAL PRIMARY KEY, ticker TEXT, side TEXT, strategy TEXT, status TEXT, ok SMALLINT,
    created_at TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS longbridge_live_rejected_orders (
    id BIGSERIAL PRIMARY KEY, ticker TEXT, side TEXT, strategy TEXT, status TEXT, ok SMALLINT,
    created_at TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS longbridge_live_skipped (
    id BIGSERIAL PRIMARY KEY, ticker TEXT, side TEXT, strategy TEXT, status TEXT, ok SMALLINT,
    created_at TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS longbridge_live_confirmations (
    id BIGSERIAL PRIMARY KEY, ticker TEXT, side TEXT, strategy TEXT, status TEXT, ok SMALLINT,
    created_at TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS longbridge_live_candidate_pool (
    id BIGSERIAL PRIMARY KEY, ticker TEXT, side TEXT, strategy TEXT, status TEXT, ok SMALLINT,
    created_at TEXT NOT NULL, payload JSONB NOT NULL
);
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'longbridge_live_signals','longbridge_live_pending_orders','longbridge_live_submitted_orders',
    'longbridge_live_rejected_orders','longbridge_live_skipped','longbridge_live_confirmations',
    'longbridge_live_candidate_pool']
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_created_at ON %I(created_at DESC, id DESC)', t, t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_ticker_created_at ON %I(ticker, created_at DESC, id DESC)', t, t);
  END LOOP;
END $$;

-- Top30 CSP 报告（来源：top30-report-history.sqlite3，TEXT 列与 SQLite 逐列对齐）
CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    batch_id TEXT NOT NULL UNIQUE,
    generated_at TEXT NOT NULL,
    report_window_days INTEGER NOT NULL DEFAULT 30,
    raw_data TEXT NOT NULL,
    data_quality TEXT NOT NULL,
    analysis TEXT NOT NULL,
    markdown TEXT NOT NULL,
    analysis_model TEXT,
    prompt_archive TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS report_top_opportunities (
    id BIGSERIAL PRIMARY KEY,
    report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    opportunity_rank INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    analysis TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(report_id, opportunity_rank)
);
CREATE INDEX IF NOT EXISTS idx_report_top_opportunities_report_rank ON report_top_opportunities(report_id, opportunity_rank ASC);
CREATE INDEX IF NOT EXISTS idx_report_top_opportunities_ticker_generated_at ON report_top_opportunities(ticker, generated_at DESC, id DESC);

-- ============ 云端业务表 ============

CREATE TABLE IF NOT EXISTS cloud_users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cloud_jobs (
    id BIGSERIAL PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued',
    claimed_by TEXT,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_status_run_after ON cloud_jobs(status, run_after);

CREATE TABLE IF NOT EXISTS cloud_engine_state (
    platform TEXT NOT NULL,
    engine_key TEXT NOT NULL,
    desired TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, engine_key)
);

CREATE TABLE IF NOT EXISTS cloud_worker_status (
    platform TEXT PRIMARY KEY,
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    username TEXT,
    ip TEXT,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type_created_at ON audit_log(event_type, created_at DESC);
