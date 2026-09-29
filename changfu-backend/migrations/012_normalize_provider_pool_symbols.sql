WITH normalized AS (
  SELECT item_id,
         user_id,
         provider_id,
         CASE
           WHEN provider_symbol LIKE market || '.' || market || '.%'
             THEN substring(provider_symbol FROM length(market) + 2)
           ELSE provider_symbol
         END AS provider_symbol
    FROM changfu.provider_research_pool_items
   WHERE status IN ('ACTIVE', 'FROZEN')
)
UPDATE changfu.provider_research_pool_items AS dirty
   SET status = 'REMOVED',
       removed_at = now(),
       updated_at = now()
  FROM normalized
 WHERE dirty.item_id = normalized.item_id
   AND dirty.provider_symbol <> normalized.provider_symbol
   AND EXISTS (
     SELECT 1
       FROM changfu.provider_research_pool_items AS existing
      WHERE existing.item_id <> dirty.item_id
        AND existing.user_id = dirty.user_id
        AND existing.provider_id = dirty.provider_id
        AND existing.provider_symbol = normalized.provider_symbol
        AND existing.status IN ('ACTIVE', 'FROZEN')
   );

UPDATE changfu.provider_research_pool_items
   SET provider_symbol = CASE
         WHEN provider_symbol LIKE market || '.' || market || '.%'
           THEN substring(provider_symbol FROM length(market) + 2)
         ELSE provider_symbol
       END,
       canonical_symbol = CASE
         WHEN canonical_symbol LIKE market || '.' || market || '.%'
           THEN substring(canonical_symbol FROM length(market) + 2)
         ELSE canonical_symbol
       END,
       underlying_symbol = CASE
         WHEN underlying_symbol LIKE market || '.' || market || '.%'
           THEN substring(underlying_symbol FROM length(market) + 2)
         ELSE underlying_symbol
       END,
       updated_at = now()
 WHERE provider_symbol LIKE market || '.' || market || '.%'
    OR canonical_symbol LIKE market || '.' || market || '.%'
    OR underlying_symbol LIKE market || '.' || market || '.%';
