import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type {
  SubscriptionCatalog,
  SubscriptionPlan,
  SubscriptionPrice,
  SubscriptionProvider,
} from '../../subscriptions/src/catalog.js'
import type { PostgresAdminRepository } from './postgresAdminRepository.js'

export type PlanCode = 'LITE' | 'PRO' | 'FLAGSHIP'
export type PlanStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED'

export type AdminPlanInput = {
  displayName: string
  effectiveFrom: string
  brokerSlotLimit: number
  poolCapacityPerProvider: number | null
  monthlyReplacementLimit: number | null
  features: {
    batchSize: number
    optionResearch: boolean
    optionTrading: boolean
    poolCapacityProtectionLimit?: number
  }
  prices: Array<{
    billingPeriod: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
    amountMinor: number
  }>
}

type PlanRow = {
  plan_version_id: string
  plan_code: PlanCode
  version: number
  display_name: string
  status: PlanStatus
  effective_from: Date
  effective_until: Date | null
  broker_slot_limit: number
  pool_capacity_per_provider: number | null
  monthly_replacement_limit: number | null
  features: SubscriptionPlan['features']
  catalog_version: string
  created_at: Date
  prices: unknown
}

function normalizePrices(value: unknown): SubscriptionPrice[] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    const row = item as {
      priceId: string
      billingPeriod: SubscriptionPrice['billingPeriod']
      durationMonths: SubscriptionPrice['durationMonths']
      amountMinor: number
    }
    return row
  })
}

function publicPlan(row: PlanRow) {
  return {
    planVersionId: row.plan_version_id,
    planCode: row.plan_code,
    version: row.version,
    displayName: row.display_name,
    status: row.status,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveUntil: row.effective_until?.toISOString() ?? null,
    brokerSlotLimit: row.broker_slot_limit,
    poolCapacityPerProvider: row.pool_capacity_per_provider,
    monthlyReplacementLimit: row.monthly_replacement_limit,
    features: row.features,
    catalogVersion: row.catalog_version,
    createdAt: row.created_at.toISOString(),
    prices: normalizePrices(row.prices),
  }
}

export class AdminPlanError extends Error {
  constructor(readonly code: string) {
    super('套餐版本操作失败')
    this.name = 'AdminPlanError'
  }
}

export class PostgresSubscriptionCatalogRepository {
  constructor(
    private readonly pool: Pool,
    private readonly adminRepository?: PostgresAdminRepository,
  ) {}

  async activeCatalog(): Promise<SubscriptionCatalog> {
    const [providers, plans] = await Promise.all([
      this.pool.query<{
        provider_id: string
        display_name: string
        status: SubscriptionProvider['status']
        supported_markets: SubscriptionProvider['supportedMarkets']
        supported_instrument_types: SubscriptionProvider['supportedInstrumentTypes']
      }>(
        `SELECT provider_id, display_name, status, supported_markets,
                supported_instrument_types
           FROM changfu.broker_provider_catalog
          ORDER BY provider_id`,
      ),
      this.planRows(`WHERE p.status = 'ACTIVE'
        AND p.effective_from <= now()
        AND (p.effective_until IS NULL OR p.effective_until > now())`),
    ])
    const normalizedPlans = plans.map(publicPlan)
    const payload = JSON.stringify(normalizedPlans.map(plan => ({
      id: plan.planVersionId,
      version: plan.version,
    })))
    return {
      catalogVersion: `database-${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`,
      publishedAt: new Date().toISOString(),
      currency: 'CNY',
      providers: providers.rows.map(row => ({
        providerId: row.provider_id,
        displayName: row.display_name,
        status: row.status,
        supportedMarkets: row.supported_markets,
        supportedInstrumentTypes: row.supported_instrument_types,
      })),
      plans: normalizedPlans.map(plan => ({
        ...plan,
        status: 'ACTIVE' as const,
      })),
      contentHash: createHash('sha256').update(payload).digest('hex'),
    }
  }

  async list(): Promise<Record<PlanCode, ReturnType<typeof publicPlan>[]>> {
    const rows = await this.planRows('')
    return {
      LITE: rows.filter(row => row.plan_code === 'LITE').map(publicPlan),
      PRO: rows.filter(row => row.plan_code === 'PRO').map(publicPlan),
      FLAGSHIP: rows.filter(row => row.plan_code === 'FLAGSHIP').map(publicPlan),
    }
  }

  async versions(planCode: PlanCode): Promise<ReturnType<typeof publicPlan>[]> {
    return (await this.planRows('WHERE p.plan_code = $1', [planCode])).map(publicPlan)
  }

  async createDraft(input: {
    planCode: PlanCode
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<ReturnType<typeof publicPlan>> {
    return this.transaction(async client => {
      const source = await this.planRows(
        'WHERE p.plan_code = $1',
        [input.planCode],
        client,
      )
      const current = source.find(plan => plan.status === 'ACTIVE')
        ?? source.find(plan => plan.status === 'DRAFT')
        ?? source[0]
      if (!current) throw new AdminPlanError('PLAN_NOT_FOUND')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `changfu-plan:${input.planCode}`,
      ])
      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::integer + 1 AS version
           FROM changfu.subscription_plan_versions
          WHERE plan_code = $1`,
        [input.planCode],
      )
      const version = versionResult.rows[0]!.version
      const planVersionId = randomUUID()
      const catalogVersion = `admin-${randomUUID()}`
      const hash = createHash('sha256')
        .update(`${input.planCode}:${version}:${planVersionId}`)
        .digest('hex')
      await client.query(
        `INSERT INTO changfu.subscription_catalog_releases (
           catalog_version, content_hash, published_at
         ) VALUES ($1, $2, now())`,
        [catalogVersion, hash],
      )
      await client.query(
        `INSERT INTO changfu.subscription_plan_versions (
           plan_version_id, plan_code, version, display_name, status, effective_from,
           broker_slot_limit, pool_capacity_per_provider, monthly_replacement_limit,
           features, catalog_version
         ) VALUES ($1::uuid, $2, $3, $4, 'DRAFT', now(), $5, $6, $7, $8::jsonb, $9)`,
        [
          planVersionId,
          input.planCode,
          version,
          current.display_name,
          current.broker_slot_limit,
          current.pool_capacity_per_provider,
          current.monthly_replacement_limit,
          JSON.stringify(current.features),
          catalogVersion,
        ],
      )
      for (const price of normalizePrices(current.prices)) {
        await client.query(
          `INSERT INTO changfu.subscription_prices (
             price_id, plan_version_id, billing_period, duration_months, currency, amount_minor
           ) VALUES ($1::uuid, $2::uuid, $3, $4, 'CNY', $5)`,
          [randomUUID(), planVersionId, price.billingPeriod, price.durationMonths, price.amountMinor],
        )
      }
      await this.audit(client, input, 'PLAN_DRAFT_CREATED', planVersionId, {
        planCode: input.planCode,
        version,
      })
      return publicPlan((await this.planRows(
        'WHERE p.plan_version_id = $1::uuid',
        [planVersionId],
        client,
      ))[0]!)
    })
  }

  async updateDraft(input: AdminPlanInput & {
    planCode: PlanCode
    planVersionId: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<ReturnType<typeof publicPlan>> {
    return this.transaction(async client => {
      const locked = await client.query<Pick<PlanRow, 'status' | 'plan_code'>>(
        `SELECT status, plan_code
           FROM changfu.subscription_plan_versions
          WHERE plan_version_id = $1::uuid
          FOR UPDATE`,
        [input.planVersionId],
      )
      const row = locked.rows[0]
      if (!row || row.plan_code !== input.planCode) throw new AdminPlanError('PLAN_VERSION_NOT_FOUND')
      if (row.status !== 'DRAFT') throw new AdminPlanError('PLAN_VERSION_IMMUTABLE')
      await client.query(
        `UPDATE changfu.subscription_plan_versions
            SET display_name = $2, effective_from = $3::timestamptz,
                broker_slot_limit = $4, pool_capacity_per_provider = $5,
                monthly_replacement_limit = $6, features = $7::jsonb
          WHERE plan_version_id = $1::uuid`,
        [
          input.planVersionId,
          input.displayName,
          input.effectiveFrom,
          input.brokerSlotLimit,
          input.poolCapacityPerProvider,
          input.monthlyReplacementLimit,
          JSON.stringify(input.features),
        ],
      )
      await client.query(
        'DELETE FROM changfu.subscription_prices WHERE plan_version_id = $1::uuid',
        [input.planVersionId],
      )
      const durations = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 } as const
      for (const price of input.prices) {
        await client.query(
          `INSERT INTO changfu.subscription_prices (
             price_id, plan_version_id, billing_period, duration_months, currency, amount_minor
           ) VALUES ($1::uuid, $2::uuid, $3, $4, 'CNY', $5)`,
          [
            randomUUID(),
            input.planVersionId,
            price.billingPeriod,
            durations[price.billingPeriod],
            price.amountMinor,
          ],
        )
      }
      await this.audit(client, input, 'PLAN_DRAFT_UPDATED', input.planVersionId, {
        planCode: input.planCode,
      })
      return publicPlan((await this.planRows(
        'WHERE p.plan_version_id = $1::uuid',
        [input.planVersionId],
        client,
      ))[0]!)
    })
  }

  async publish(input: {
    planCode: PlanCode
    planVersionId: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<void> {
    await this.transaction(async client => {
      const rows = await this.planRows(
        'WHERE p.plan_version_id = $1::uuid',
        [input.planVersionId],
        client,
      )
      const row = rows[0]
      if (!row || row.plan_code !== input.planCode) throw new AdminPlanError('PLAN_VERSION_NOT_FOUND')
      if (row.status !== 'DRAFT') throw new AdminPlanError('PLAN_VERSION_IMMUTABLE')
      if (normalizePrices(row.prices).length !== 3) throw new AdminPlanError('PLAN_PRICES_INCOMPLETE')
      await client.query(
        `UPDATE changfu.subscription_plan_versions
            SET status = 'RETIRED', effective_until = now()
          WHERE plan_code = $1 AND status = 'ACTIVE'`,
        [input.planCode],
      )
      await client.query(
        `UPDATE changfu.subscription_plan_versions
            SET status = 'ACTIVE', effective_until = NULL
          WHERE plan_version_id = $1::uuid`,
        [input.planVersionId],
      )
      await this.audit(client, input, 'PLAN_VERSION_PUBLISHED', input.planVersionId, {
        planCode: input.planCode,
        version: row.version,
      })
    })
  }

  async retire(input: {
    planCode: PlanCode
    planVersionId: string
    actorAdminUserId: string
    requestId: string
    sourceIp: string | null
  }): Promise<void> {
    await this.transaction(async client => {
      const result = await client.query(
        `UPDATE changfu.subscription_plan_versions
            SET status = 'RETIRED', effective_until = COALESCE(effective_until, now())
          WHERE plan_version_id = $1::uuid AND plan_code = $2 AND status <> 'RETIRED'
          RETURNING version`,
        [input.planVersionId, input.planCode],
      )
      if (result.rowCount !== 1) throw new AdminPlanError('PLAN_VERSION_NOT_FOUND')
      await this.audit(client, input, 'PLAN_VERSION_RETIRED', input.planVersionId, {
        planCode: input.planCode,
      })
    })
  }

  private async planRows(
    where: string,
    values: unknown[] = [],
    queryable: Pool | PoolClient = this.pool,
  ): Promise<PlanRow[]> {
    const result = await queryable.query<PlanRow>(
      `SELECT p.plan_version_id, p.plan_code, p.version, p.display_name, p.status,
              p.effective_from, p.effective_until, p.broker_slot_limit,
              p.pool_capacity_per_provider, p.monthly_replacement_limit,
              p.features, p.catalog_version, p.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'priceId', pr.price_id,
                'billingPeriod', pr.billing_period,
                'durationMonths', pr.duration_months,
                'amountMinor', pr.amount_minor
              ) ORDER BY pr.duration_months) FILTER (WHERE pr.price_id IS NOT NULL), '[]'::jsonb) AS prices
         FROM changfu.subscription_plan_versions p
         LEFT JOIN changfu.subscription_prices pr
           ON pr.plan_version_id = p.plan_version_id
         ${where}
        GROUP BY p.plan_version_id
        ORDER BY p.plan_code, p.version DESC`,
      values,
    )
    return result.rows
  }

  private async audit(
    client: PoolClient,
    input: {
      actorAdminUserId: string
      requestId: string
      sourceIp: string | null
    },
    action: string,
    resourceId: string,
    afterSummary: unknown,
  ): Promise<void> {
    if (!this.adminRepository) return
    await this.adminRepository.writeAudit(client, {
      actorAdminUserId: input.actorAdminUserId,
      action,
      resourceType: 'SUBSCRIPTION_PLAN_VERSION',
      resourceId,
      outcome: 'SUCCESS',
      requestId: input.requestId,
      sourceIp: input.sourceIp,
      afterSummary,
    })
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
