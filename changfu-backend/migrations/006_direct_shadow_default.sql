BEGIN;

WITH migrated AS (
  UPDATE changfu.trading_configs
     SET version = version + 1,
         execution_mode = 'DIRECT',
         config = jsonb_set(config, '{executionMode}', '"DIRECT"'::jsonb),
         updated_at = now()
   WHERE version = 1
     AND execution_mode = 'CANDIDATE_POOL'
  RETURNING broker_connection_id, user_id, version, catalog_version, config
)
INSERT INTO changfu.trading_config_versions (
  broker_connection_id, user_id, version, catalog_version, config
)
SELECT broker_connection_id, user_id, version, catalog_version, config
  FROM migrated
ON CONFLICT (broker_connection_id, version) DO NOTHING;

UPDATE changfu.candidate_pool_items AS candidate
   SET status = 'EXPIRED',
       updated_at = now()
 WHERE candidate.status IN ('PENDING', 'WATCH')
   AND EXISTS (
     SELECT 1
       FROM changfu.trading_configs AS config
      WHERE config.broker_connection_id = candidate.broker_connection_id
        AND config.execution_mode = 'DIRECT'
   );

COMMIT;
