BEGIN;

ALTER TABLE changfu.sell_put_report_runs
  ALTER COLUMN prompt_version SET DEFAULT 'top30-mega-cap-csp-v3';

COMMIT;
