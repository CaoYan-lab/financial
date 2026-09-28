BEGIN;

WITH migrated AS (
  UPDATE changfu.trading_configs
     SET version = version + 1,
         config = jsonb_set(
           config,
           '{disableUsOvernightEvaluation}',
           'true'::jsonb,
           true
         ),
         updated_at = now()
   WHERE NOT COALESCE((config->>'disableUsOvernightEvaluation')::boolean, false)
  RETURNING broker_connection_id, user_id, version, catalog_version, config
)
INSERT INTO changfu.trading_config_versions (
  broker_connection_id, user_id, version, catalog_version, config
)
SELECT broker_connection_id, user_id, version, catalog_version, config
  FROM migrated
ON CONFLICT (broker_connection_id, version) DO NOTHING;

COMMIT;
