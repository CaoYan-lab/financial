import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import type { BillingPeriod } from './billingClock.js'

export type SubscriptionProvider = {
  providerId: string
  displayName: string
  status: 'ACTIVE' | 'DISABLED'
  supportedMarkets: Array<'US' | 'HK' | 'CN' | 'SG'>
  supportedInstrumentTypes: Array<'STOCK' | 'ETF' | 'OPTION'>
}

export type SubscriptionPrice = {
  priceId: string
  billingPeriod: BillingPeriod
  durationMonths: 1 | 3 | 12
  amountMinor: number
}

export type SubscriptionPlan = {
  planVersionId: string
  planCode: 'LITE' | 'PRO' | 'FLAGSHIP'
  version: number
  displayName: string
  status: 'ACTIVE'
  effectiveFrom: string
  brokerSlotLimit: number
  poolCapacityPerProvider: number | null
  monthlyReplacementLimit: number | null
  features: {
    batchSize: 100
    optionResearch: boolean
    optionTrading: false
    poolCapacityProtectionLimit?: number
  }
  prices: SubscriptionPrice[]
}

export type SubscriptionCatalog = {
  catalogVersion: string
  publishedAt: string
  currency: 'CNY'
  providers: SubscriptionProvider[]
  plans: SubscriptionPlan[]
  contentHash: string
}

export type PaymentChannelAvailability = {
  channel: 'WECHAT' | 'ALIPAY' | 'DOUYIN'
  displayName: string
  available: boolean
  unavailableReason: string | null
}

export class SubscriptionCatalogError extends Error {
  constructor(readonly code: string) {
    super('订阅目录无效')
    this.name = 'SubscriptionCatalogError'
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const providerPattern = /^[A-Z][A-Z0-9_]{1,31}$/

function assertCatalog(value: unknown): asserts value is Omit<SubscriptionCatalog, 'contentHash'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SubscriptionCatalogError('CATALOG_INVALID')
  }
  const catalog = value as Omit<SubscriptionCatalog, 'contentHash'>
  if (
    !catalog.catalogVersion
    || !Date.parse(catalog.publishedAt)
    || catalog.currency !== 'CNY'
    || !Array.isArray(catalog.providers)
    || !Array.isArray(catalog.plans)
  ) throw new SubscriptionCatalogError('CATALOG_REQUIRED_FIELDS_MISSING')

  const providerIds = new Set<string>()
  for (const provider of catalog.providers) {
    if (
      !providerPattern.test(provider.providerId)
      || providerIds.has(provider.providerId)
      || !provider.displayName
      || !['ACTIVE', 'DISABLED'].includes(provider.status)
      || !Array.isArray(provider.supportedMarkets)
      || provider.supportedMarkets.length === 0
      || provider.supportedMarkets.some(market => !['US', 'HK', 'CN', 'SG'].includes(market))
      || !Array.isArray(provider.supportedInstrumentTypes)
      || provider.supportedInstrumentTypes.length === 0
      || provider.supportedInstrumentTypes.some(
        type => !['STOCK', 'ETF', 'OPTION'].includes(type),
      )
    ) throw new SubscriptionCatalogError('PROVIDER_INVALID')
    providerIds.add(provider.providerId)
  }

  const planIds = new Set<string>()
  const planVersions = new Set<string>()
  const priceIds = new Set<string>()
  for (const plan of catalog.plans) {
    const versionKey = `${plan.planCode}:${plan.version}`
    if (
      !uuidPattern.test(plan.planVersionId)
      || planIds.has(plan.planVersionId)
      || planVersions.has(versionKey)
      || !['LITE', 'PRO', 'FLAGSHIP'].includes(plan.planCode)
      || !Number.isInteger(plan.version) || plan.version < 1
      || !plan.displayName
      || plan.status !== 'ACTIVE'
      || !Date.parse(plan.effectiveFrom)
      || !Number.isInteger(plan.brokerSlotLimit) || plan.brokerSlotLimit < 1
      || (
        plan.poolCapacityPerProvider !== null
        && (!Number.isInteger(plan.poolCapacityPerProvider) || plan.poolCapacityPerProvider < 1)
      )
      || (
        plan.monthlyReplacementLimit !== null
        && (!Number.isInteger(plan.monthlyReplacementLimit) || plan.monthlyReplacementLimit < 0)
      )
      || plan.features?.batchSize !== 100
      || plan.features.optionTrading !== false
      || !Array.isArray(plan.prices)
      || plan.prices.length !== 3
    ) throw new SubscriptionCatalogError('PLAN_INVALID')
    planIds.add(plan.planVersionId)
    planVersions.add(versionKey)
    for (const price of plan.prices) {
      const expectedMonths = price.billingPeriod === 'MONTHLY'
        ? 1
        : price.billingPeriod === 'QUARTERLY' ? 3 : price.billingPeriod === 'YEARLY' ? 12 : 0
      if (
        !uuidPattern.test(price.priceId)
        || priceIds.has(price.priceId)
        || price.durationMonths !== expectedMonths
        || !Number.isInteger(price.amountMinor)
        || price.amountMinor < 1
      ) throw new SubscriptionCatalogError('PRICE_INVALID')
      priceIds.add(price.priceId)
    }
  }
}

export async function loadSubscriptionCatalog(path: string): Promise<SubscriptionCatalog> {
  const text = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SubscriptionCatalogError('CATALOG_JSON_INVALID')
  }
  assertCatalog(parsed)
  return {
    ...parsed,
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
  }
}

export function publicSubscriptionCatalog(
  catalog: SubscriptionCatalog,
  paymentChannels: PaymentChannelAvailability[],
): Omit<SubscriptionCatalog, 'contentHash'> & {
  paymentChannels: PaymentChannelAvailability[]
} {
  const { contentHash: _contentHash, ...publicCatalog } = catalog
  return {
    ...publicCatalog,
    plans: publicCatalog.plans.map(plan => ({
      ...plan,
      prices: plan.prices.map(price => ({ ...price, currency: 'CNY' })),
    })) as SubscriptionPlan[],
    paymentChannels,
  }
}

async function seedCatalog(client: PoolClient, catalog: SubscriptionCatalog): Promise<void> {
  const release = await client.query(
    `INSERT INTO changfu.subscription_catalog_releases (
       catalog_version, content_hash, published_at
     ) VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (catalog_version) DO UPDATE
       SET activated_at = changfu.subscription_catalog_releases.activated_at
     WHERE changfu.subscription_catalog_releases.content_hash = EXCLUDED.content_hash
     RETURNING catalog_version`,
    [catalog.catalogVersion, catalog.contentHash, catalog.publishedAt],
  )
  if (release.rowCount !== 1) throw new SubscriptionCatalogError('CATALOG_VERSION_HASH_CONFLICT')

  for (const provider of catalog.providers) {
    await client.query(
      `INSERT INTO changfu.broker_provider_catalog (
         provider_id, display_name, status, supported_markets,
         supported_instrument_types, catalog_version
       ) VALUES ($1, $2, $3, $4::varchar[], $5::varchar[], $6)
       ON CONFLICT (provider_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         status = EXCLUDED.status,
         supported_markets = EXCLUDED.supported_markets,
         supported_instrument_types = EXCLUDED.supported_instrument_types,
         catalog_version = EXCLUDED.catalog_version,
         updated_at = now()`,
      [
        provider.providerId,
        provider.displayName,
        provider.status,
        provider.supportedMarkets,
        provider.supportedInstrumentTypes,
        catalog.catalogVersion,
      ],
    )
  }
  for (const plan of catalog.plans) {
    const inserted = await client.query(
      `INSERT INTO changfu.subscription_plan_versions (
         plan_version_id, plan_code, version, display_name, status, effective_from,
         broker_slot_limit, pool_capacity_per_provider, monthly_replacement_limit,
         features, catalog_version
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (plan_version_id) DO UPDATE SET
         plan_version_id = changfu.subscription_plan_versions.plan_version_id
       WHERE changfu.subscription_plan_versions.plan_code = EXCLUDED.plan_code
         AND changfu.subscription_plan_versions.version = EXCLUDED.version
         AND changfu.subscription_plan_versions.display_name = EXCLUDED.display_name
         AND changfu.subscription_plan_versions.broker_slot_limit = EXCLUDED.broker_slot_limit
         AND changfu.subscription_plan_versions.pool_capacity_per_provider
             IS NOT DISTINCT FROM EXCLUDED.pool_capacity_per_provider
         AND changfu.subscription_plan_versions.monthly_replacement_limit
             IS NOT DISTINCT FROM EXCLUDED.monthly_replacement_limit
         AND changfu.subscription_plan_versions.features = EXCLUDED.features
       RETURNING plan_version_id`,
      [
        plan.planVersionId,
        plan.planCode,
        plan.version,
        plan.displayName,
        plan.status,
        plan.effectiveFrom,
        plan.brokerSlotLimit,
        plan.poolCapacityPerProvider,
        plan.monthlyReplacementLimit,
        JSON.stringify(plan.features),
        catalog.catalogVersion,
      ],
    )
    if (inserted.rowCount !== 1) throw new SubscriptionCatalogError('PLAN_VERSION_CONFLICT')
    for (const price of plan.prices) {
      const priceResult = await client.query(
        `INSERT INTO changfu.subscription_prices (
           price_id, plan_version_id, billing_period, duration_months, currency, amount_minor
         ) VALUES ($1::uuid, $2::uuid, $3, $4, 'CNY', $5)
         ON CONFLICT (price_id) DO UPDATE SET
           price_id = changfu.subscription_prices.price_id
         WHERE changfu.subscription_prices.plan_version_id = EXCLUDED.plan_version_id
           AND changfu.subscription_prices.billing_period = EXCLUDED.billing_period
           AND changfu.subscription_prices.duration_months = EXCLUDED.duration_months
           AND changfu.subscription_prices.currency = EXCLUDED.currency
           AND changfu.subscription_prices.amount_minor = EXCLUDED.amount_minor
         RETURNING price_id`,
        [
          price.priceId,
          plan.planVersionId,
          price.billingPeriod,
          price.durationMonths,
          price.amountMinor,
        ],
      )
      if (priceResult.rowCount !== 1) {
        throw new SubscriptionCatalogError('PRICE_VERSION_CONFLICT')
      }
    }
  }
}

export async function seedSubscriptionCatalog(
  pool: Pool,
  catalog: SubscriptionCatalog,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await seedCatalog(client, catalog)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
