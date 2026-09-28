BEGIN;

CREATE SCHEMA IF NOT EXISTS changfu;

CREATE TABLE IF NOT EXISTS changfu.schema_migrations (
  version varchar(160) PRIMARY KEY,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
