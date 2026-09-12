import type { BrokerExecutionSettings, ManagedBroker } from '../../../shared/managedOrderTypes.js'
import { isPgEnabled, query, queryOne } from '../db/pgClient.js'

const memorySettings = new Map<ManagedBroker, BrokerExecutionSettings>()

export function defaultBrokerExecutionSettings(
  platform: ManagedBroker,
): BrokerExecutionSettings {
  const prefix = platform === 'futu' ? 'FUTU' : 'LONGBRIDGE'
  return {
    autoSubmitEnabled:
      process.env[`${prefix}_AUTO_SUBMIT_ENABLED`] === 'true',
    autoCancelEnabled:
      process.env[`${prefix}_AUTO_CANCEL_ENABLED`] === 'true',
    blockOpeningWhenCashNegative: platform === 'longbridge'
      ? process.env.LONGBRIDGE_BLOCK_OPENING_WHEN_CASH_NEGATIVE !== 'false'
      : false,
    marketableLimitTimeoutSeconds: positiveInt(
      process.env[`${prefix}_MARKETABLE_LIMIT_TIMEOUT_SECONDS`],
      90,
    ),
    limitTimeoutSeconds: positiveInt(
      process.env[`${prefix}_LIMIT_TIMEOUT_SECONDS`],
      600,
    ),
    brokerSyncIntervalSeconds: positiveInt(
      process.env[`${prefix}_ORDER_SYNC_INTERVAL_SECONDS`],
      15,
    ),
    modelReviewIntervalSeconds: positiveInt(
      process.env[`${prefix}_ORDER_MODEL_REVIEW_INTERVAL_SECONDS`],
      60,
    ),
    modelAutoCancelConfidence: 'high',
  }
}

export async function loadBrokerExecutionSettings(
  platform: ManagedBroker,
): Promise<BrokerExecutionSettings> {
  const defaults = defaultBrokerExecutionSettings(platform)
  if (!shouldUseSettingsPostgres()) return memorySettings.get(platform) ?? defaults
  const row = await queryOne<{ value: Partial<BrokerExecutionSettings> }>(
    'SELECT value FROM app_config WHERE key = $1',
    [`${platform}_live.execution_controls`],
  )
  return normalizeSettings({ ...defaults, ...(row?.value ?? {}) })
}

export async function saveBrokerExecutionSettings(
  platform: ManagedBroker,
  settings: BrokerExecutionSettings,
): Promise<BrokerExecutionSettings> {
  const normalized = normalizeSettings(settings)
  if (!shouldUseSettingsPostgres()) {
    memorySettings.set(platform, normalized)
    return normalized
  }
  await query(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [`${platform}_live.execution_controls`, JSON.stringify(normalized)],
  )
  return normalized
}

function normalizeSettings(
  input: BrokerExecutionSettings,
): BrokerExecutionSettings {
  return {
    autoSubmitEnabled: input.autoSubmitEnabled === true,
    autoCancelEnabled: input.autoCancelEnabled === true,
    blockOpeningWhenCashNegative:
      input.blockOpeningWhenCashNegative === true,
    marketableLimitTimeoutSeconds: clamp(
      input.marketableLimitTimeoutSeconds,
      15,
      3600,
      90,
    ),
    limitTimeoutSeconds: clamp(input.limitTimeoutSeconds, 60, 86400, 600),
    brokerSyncIntervalSeconds: clamp(
      input.brokerSyncIntervalSeconds,
      5,
      300,
      15,
    ),
    modelReviewIntervalSeconds: clamp(
      input.modelReviewIntervalSeconds,
      30,
      3600,
      60,
    ),
    modelAutoCancelConfidence: 'high',
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function shouldUseSettingsPostgres(): boolean {
  return isPgEnabled() && (process.env.NODE_ENV !== 'test' || process.env.MANAGED_ORDER_PG_TEST === '1')
}
