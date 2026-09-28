BEGIN;

ALTER TABLE changfu.model_runs
  ADD COLUMN IF NOT EXISTS requested_symbols varchar(32)[] NOT NULL DEFAULT '{}';

COMMIT;
