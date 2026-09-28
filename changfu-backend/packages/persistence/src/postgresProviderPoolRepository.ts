import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { SubscriptionCatalog } from '../../subscriptions/src/catalog.js'
import { monthlyAnniversaryWindow } from '../../subscriptions/src/billingClock.js'

export type ProviderPoolItemInput = {
  providerSymbol: string
  canonicalSymbol: string
  displayName: string
  market: 'US' | 'HK' | 'CN' | 'SG'
  instrumentType: 'STOCK' | 'ETF' | 'OPTION'
  optionType: 'CALL' | 'PUT' | null
  underlyingSymbol: string | null
  expiryDate: string | null
  strikePrice: string | null
  currency: string
  contractMultiplier: string | null
  sourceVerifiedAt: string
}

type EntitlementRow = {
  subscription_id: string
  subscription_version: string
  subscription_status: 'ACTIVE' | 'FROZEN' | 'CANCELLED'
  starts_at: Date
  current_period_start: Date
  expires_at: Date
  slot_status: 'ACTIVE' | 'FROZEN' | 'EMPTY'
  pool_capacity_per_provider: number | null
  monthly_replacement_limit: number | null
  pool_version: string
  pool_status: 'ACTIVE' | 'FROZEN'
  frozen_reason: string | null
}

export class ProviderPoolError extends Error {
  constructor(readonly code: string) {
    super('Provider 标的池状态冲突')
    this.name = 'ProviderPoolError'
  }
}

export class PostgresProviderPoolRepository {
  private readonly protectionLimit: number

  constructor(
    private readonly pool: Pool,
    private readonly catalog: SubscriptionCatalog,
    protectionLimit = Number(process.env.CHANGFU_PROVIDER_POOL_PROTECTION_LIMIT ?? 10_000),
  ) {
    this.protectionLimit = protectionLimit
  }

  async listPools(userId: string, now = new Date()): Promise<{
    etag: string
    items: unknown[]
  }> {
    const result = await this.pool.query<{
      provider_id: string
      status: 'ACTIVE' | 'FROZEN'
      frozen_reason: string | null
      version: string
      updated_at: Date
      capacity: number | null
      used: number
      subscription_version: string | null
      subscription_active: boolean
    }>(
      `SELECT p.provider_id, p.status, p.frozen_reason, p.version, p.updated_at,
              plan.pool_capacity_per_provider AS capacity,
              count(i.item_id) FILTER (WHERE i.status IN ('ACTIVE', 'FROZEN'))::int AS used,
              s.version AS subscription_version,
              coalesce(
                s.status = 'ACTIVE' AND s.starts_at <= $2::timestamptz
                  AND $2::timestamptz < s.expires_at
                  AND slot.status = 'ACTIVE',
                false
              ) AS subscription_active
         FROM changfu.provider_research_pools p
         LEFT JOIN changfu.user_subscriptions s
           ON s.user_id = p.user_id AND s.status IN ('ACTIVE', 'FROZEN')
         LEFT JOIN changfu.subscription_plan_versions plan
           ON plan.plan_version_id = s.plan_version_id
         LEFT JOIN changfu.subscription_broker_slots slot
           ON slot.subscription_id = s.subscription_id
          AND slot.provider_id = p.provider_id
         LEFT JOIN changfu.provider_research_pool_items i
           ON i.user_id = p.user_id AND i.provider_id = p.provider_id
        WHERE p.user_id = $1::bigint
        GROUP BY p.provider_id, p.status, p.frozen_reason, p.version, p.updated_at,
                 plan.pool_capacity_per_provider, s.version, s.status, s.starts_at,
                 s.expires_at, slot.status
        ORDER BY p.provider_id`,
      [userId, now],
    )
    const versionKey = result.rows.map(
      row => [
        row.provider_id,
        row.version,
        row.subscription_version ?? 0,
        row.status,
        row.subscription_active ? 'ACTIVE' : 'FROZEN',
      ].join(':'),
    ).join('|')
    return {
      etag: `"${Buffer.from(versionKey || 'empty').toString('base64url')}"`,
      items: result.rows.map(row => ({
        providerId: row.provider_id,
        status: row.subscription_active && row.status === 'ACTIVE' ? 'ACTIVE' : 'FROZEN',
        version: Number(row.version),
        used: row.used,
        capacity: row.capacity,
        updatedAt: row.updated_at.toISOString(),
      })),
    }
  }

  async getPool(input: {
    userId: string
    providerId: string
    cursor?: string | null
    limit?: number
    now?: Date
  }): Promise<{ etag: string; data: unknown }> {
    const now = input.now ?? new Date()
    const limit = input.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ProviderPoolError('POOL_PAGE_LIMIT_INVALID')
    }
    const entitlement = await this.entitlement(this.pool, input.userId, input.providerId, now, false)
    if (!entitlement) throw new ProviderPoolError('PROVIDER_POOL_NOT_FOUND')
    const cursor = this.decodeCursor(input.cursor, Number(entitlement.pool_version))
    const values: unknown[] = [input.userId, input.providerId, limit + 1]
    let cursorClause = ''
    if (cursor) {
      values.push(cursor.addedAt, cursor.itemId)
      cursorClause = `AND (added_at, item_id) > ($4::timestamptz, $5::uuid)`
    }
    const items = await this.pool.query<{
      item_id: string
      provider_id: string
      provider_symbol: string
      canonical_symbol: string
      display_name: string
      market: string
      instrument_type: string
      option_type: string | null
      underlying_symbol: string | null
      expiry_date: string | null
      strike_price: string | null
      currency: string
      contract_multiplier: string | null
      status: string
      added_at: Date
    }>(
      `SELECT item_id, provider_id, provider_symbol, canonical_symbol, display_name,
              market, instrument_type, option_type, underlying_symbol,
              expiry_date::text, strike_price::text, currency,
              contract_multiplier::text, status, added_at
         FROM changfu.provider_research_pool_items
        WHERE user_id = $1::bigint AND provider_id = $2
          AND status IN ('ACTIVE', 'FROZEN')
          ${cursorClause}
        ORDER BY added_at, item_id
        LIMIT $3`,
      values,
    )
    const window = monthlyAnniversaryWindow(
      entitlement.current_period_start,
      entitlement.expires_at,
      now,
    )
    const replacementUsed = window
      ? await this.replacementUsed(
        this.pool,
        input.userId,
        input.providerId,
        window.start,
      )
      : 0
    const used = await this.activeItemCount(this.pool, input.userId, input.providerId)
    const hasMore = items.rows.length > limit
    const page = items.rows.slice(0, limit)
    const last = page.at(-1)
    const active = this.isEntitlementActive(entitlement, now)
    const etag = [
      entitlement.subscription_version,
      entitlement.pool_version,
      active ? 'ACTIVE' : 'FROZEN',
    ].join('-')
    return {
      etag: `"${etag}"`,
      data: {
        providerId: input.providerId,
        status: active ? 'ACTIVE' : 'FROZEN',
        frozenReason: active ? null : entitlement.frozen_reason ?? 'SUBSCRIPTION_INACTIVE',
        version: Number(entitlement.pool_version),
        entitlement: {
          active,
          capacity: entitlement.pool_capacity_per_provider,
          used,
          replacementLimit: entitlement.monthly_replacement_limit,
          replacementUsed,
          replacementWindowStart: window?.start.toISOString() ?? null,
          replacementWindowEnd: window?.end.toISOString() ?? null,
        },
        items: page.map(row => ({
          itemId: row.item_id,
          providerId: row.provider_id,
          providerSymbol: row.provider_symbol,
          canonicalSymbol: row.canonical_symbol,
          displayName: row.display_name,
          market: row.market,
          instrumentType: row.instrument_type,
          optionType: row.option_type,
          underlyingSymbol: row.underlying_symbol,
          expiryDate: row.expiry_date,
          strikePrice: row.strike_price,
          currency: row.currency,
          contractMultiplier: row.contract_multiplier,
          status: active && row.status === 'ACTIVE' ? 'ACTIVE' : 'FROZEN',
          addedAt: row.added_at.toISOString(),
        })),
        nextCursor: hasMore && last
          ? this.encodeCursor(
            Number(entitlement.pool_version),
            last.added_at.toISOString(),
            last.item_id,
          )
          : null,
        updatedAt: now.toISOString(),
      },
    }
  }

  async addItem(input: {
    userId: string
    providerId: string
    item: ProviderPoolItemInput
    now?: Date
  }): Promise<unknown> {
    const now = input.now ?? new Date()
    this.validateItem(input.providerId, input.item, now)
    await this.transaction(async client => {
      const entitlement = await this.entitlement(
        client,
        input.userId,
        input.providerId,
        now,
        true,
      )
      if (!entitlement || !this.isEntitlementActive(entitlement, now)) {
        throw new ProviderPoolError('PROVIDER_ENTITLEMENT_INACTIVE')
      }
      const used = await this.activeItemCount(client, input.userId, input.providerId)
      const capacity = entitlement.pool_capacity_per_provider ?? this.protectionLimit
      if (used >= capacity) {
        throw new ProviderPoolError(
          entitlement.pool_capacity_per_provider === null
            ? 'PROVIDER_POOL_PROTECTION_LIMIT'
            : 'PROVIDER_POOL_CAPACITY_EXCEEDED',
        )
      }
      const duplicate = await client.query(
        `SELECT 1
           FROM changfu.provider_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2
            AND provider_symbol = $3 AND status IN ('ACTIVE', 'FROZEN')`,
        [input.userId, input.providerId, input.item.providerSymbol],
      )
      if (duplicate.rowCount) throw new ProviderPoolError('PROVIDER_SYMBOL_EXISTS')
      const removed = await client.query<{ item_id: string }>(
        `SELECT item_id
           FROM changfu.provider_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2
            AND provider_symbol = $3 AND status = 'REMOVED'
          ORDER BY removed_at DESC
          LIMIT 1
          FOR UPDATE`,
        [input.userId, input.providerId, input.item.providerSymbol],
      )
      const itemId = removed.rows[0]?.item_id ?? randomUUID()
      if (removed.rows[0]) {
        await client.query(
          `UPDATE changfu.provider_research_pool_items
              SET canonical_symbol = $4, display_name = $5, market = $6,
                  instrument_type = $7, option_type = $8, underlying_symbol = $9,
                  expiry_date = $10::date, strike_price = $11::numeric,
                  currency = $12, contract_multiplier = $13::numeric,
                  status = 'ACTIVE', removed_at = NULL, added_at = $14, updated_at = $14
            WHERE item_id = $1::uuid AND user_id = $2::bigint AND provider_id = $3`,
          [
            itemId,
            input.userId,
            input.providerId,
            input.item.canonicalSymbol,
            input.item.displayName,
            input.item.market,
            input.item.instrumentType,
            input.item.optionType,
            input.item.underlyingSymbol,
            input.item.expiryDate,
            input.item.strikePrice,
            input.item.currency,
            input.item.contractMultiplier,
            now,
          ],
        )
      } else {
        await client.query(
          `INSERT INTO changfu.provider_research_pool_items (
             item_id, user_id, provider_id, provider_symbol, canonical_symbol,
             display_name, market, instrument_type, option_type, underlying_symbol,
             expiry_date, strike_price, currency, contract_multiplier, status,
             added_at, updated_at
           ) VALUES (
             $1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10,
             $11::date, $12::numeric, $13, $14::numeric, 'ACTIVE', $15, $15
           )`,
          [
            itemId,
            input.userId,
            input.providerId,
            input.item.providerSymbol,
            input.item.canonicalSymbol,
            input.item.displayName,
            input.item.market,
            input.item.instrumentType,
            input.item.optionType,
            input.item.underlyingSymbol,
            input.item.expiryDate,
            input.item.strikePrice,
            input.item.currency,
            input.item.contractMultiplier,
            now,
          ],
        )
      }
      const nextVersion = Number(entitlement.pool_version) + 1
      await client.query(
        `UPDATE changfu.provider_research_pools
            SET version = $3, updated_at = $4
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [input.userId, input.providerId, nextVersion, now],
      )
      await client.query(
        `INSERT INTO changfu.research_pool_mutation_events (
           mutation_event_id, user_id, provider_id, item_id, event_type,
           pool_version, occurred_at
         ) VALUES ($1::uuid, $2::bigint, $3, $4::uuid, $5, $6, $7)`,
        [
          randomUUID(),
          input.userId,
          input.providerId,
          itemId,
          removed.rows[0] ? 'RESTORED' : 'ADDED',
          nextVersion,
          now,
        ],
      )
    })
    return (await this.getPool({
      userId: input.userId,
      providerId: input.providerId,
      now,
    })).data
  }

  async removeItem(input: {
    userId: string
    providerId: string
    itemId: string
    now?: Date
  }): Promise<unknown> {
    const now = input.now ?? new Date()
    await this.transaction(async client => {
      const entitlement = await this.entitlement(
        client,
        input.userId,
        input.providerId,
        now,
        true,
      )
      if (!entitlement || !this.isEntitlementActive(entitlement, now)) {
        throw new ProviderPoolError('PROVIDER_ENTITLEMENT_INACTIVE')
      }
      const window = monthlyAnniversaryWindow(
        entitlement.current_period_start,
        entitlement.expires_at,
        now,
      )
      if (!window) throw new ProviderPoolError('PROVIDER_ENTITLEMENT_INACTIVE')
      const replacementUsed = await this.replacementUsed(
        client,
        input.userId,
        input.providerId,
        window.start,
      )
      if (
        entitlement.monthly_replacement_limit !== null
        && replacementUsed >= entitlement.monthly_replacement_limit
      ) throw new ProviderPoolError('PROVIDER_REPLACEMENT_LIMIT_EXCEEDED')
      const removed = await client.query(
        `UPDATE changfu.provider_research_pool_items
            SET status = 'REMOVED', removed_at = $4, updated_at = $4
          WHERE item_id = $1::uuid AND user_id = $2::bigint AND provider_id = $3
            AND status IN ('ACTIVE', 'FROZEN')`,
        [input.itemId, input.userId, input.providerId, now],
      )
      if (removed.rowCount !== 1) throw new ProviderPoolError('PROVIDER_POOL_ITEM_NOT_FOUND')
      const nextVersion = Number(entitlement.pool_version) + 1
      await client.query(
        `UPDATE changfu.provider_research_pools
            SET version = $3, updated_at = $4
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [input.userId, input.providerId, nextVersion, now],
      )
      await client.query(
        `INSERT INTO changfu.research_pool_mutation_events (
           mutation_event_id, user_id, provider_id, item_id, event_type,
           pool_version, replacement_window_start, occurred_at
         ) VALUES ($1::uuid, $2::bigint, $3, $4::uuid, 'REMOVED', $5, $6, $7)`,
        [
          randomUUID(),
          input.userId,
          input.providerId,
          input.itemId,
          nextVersion,
          window.start,
          now,
        ],
      )
    })
    return (await this.getPool({
      userId: input.userId,
      providerId: input.providerId,
      now,
    })).data
  }

  async effectiveEntitlement(
    userId: string,
    providerId: string,
    now = new Date(),
  ): Promise<{
    active: boolean
    poolVersion: number
    capacity: number | null
    replacementLimit: number | null
  } | null> {
    const row = await this.entitlement(this.pool, userId, providerId, now, false)
    return row
      ? {
          active: this.isEntitlementActive(row, now),
          poolVersion: Number(row.pool_version),
          capacity: row.pool_capacity_per_provider,
          replacementLimit: row.monthly_replacement_limit,
        }
      : null
  }

  private async entitlement(
    queryable: Pool | PoolClient,
    userId: string,
    providerId: string,
    now: Date,
    lock: boolean,
  ): Promise<EntitlementRow | null> {
    const result = await queryable.query<EntitlementRow>(
      `SELECT s.subscription_id, s.version AS subscription_version,
              s.status AS subscription_status, s.starts_at,
              s.current_period_start, s.expires_at, slot.status AS slot_status,
              plan.pool_capacity_per_provider, plan.monthly_replacement_limit,
              pool.version AS pool_version, pool.status AS pool_status,
              pool.frozen_reason
         FROM changfu.user_subscriptions s
         JOIN changfu.subscription_plan_versions plan
           ON plan.plan_version_id = s.plan_version_id
         JOIN changfu.subscription_broker_slots slot
           ON slot.subscription_id = s.subscription_id
          AND slot.user_id = s.user_id
          AND slot.provider_id = $2
         JOIN changfu.provider_research_pools pool
           ON pool.user_id = s.user_id
          AND pool.provider_id = slot.provider_id
        WHERE s.user_id = $1::bigint
          AND s.status IN ('ACTIVE', 'FROZEN')
          AND slot.status IN ('ACTIVE', 'FROZEN')
        ORDER BY s.updated_at DESC
        LIMIT 1${lock ? ' FOR UPDATE OF s, slot, pool' : ''}`,
      [userId, providerId],
    )
    return result.rows[0] ?? null
  }

  private isEntitlementActive(row: EntitlementRow, now: Date): boolean {
    return row.subscription_status === 'ACTIVE'
      && row.slot_status === 'ACTIVE'
      && row.pool_status === 'ACTIVE'
      && row.starts_at.getTime() <= now.getTime()
      && now.getTime() < row.expires_at.getTime()
  }

  private async activeItemCount(
    queryable: Pool | PoolClient,
    userId: string,
    providerId: string,
  ): Promise<number> {
    const result = await queryable.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM changfu.provider_research_pool_items
        WHERE user_id = $1::bigint AND provider_id = $2
          AND status IN ('ACTIVE', 'FROZEN')`,
      [userId, providerId],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  private async replacementUsed(
    queryable: Pool | PoolClient,
    userId: string,
    providerId: string,
    windowStart: Date,
  ): Promise<number> {
    const result = await queryable.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM changfu.research_pool_mutation_events
        WHERE user_id = $1::bigint AND provider_id = $2
          AND event_type = 'REMOVED'
          AND replacement_window_start = $3::timestamptz`,
      [userId, providerId, windowStart],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  private validateItem(
    providerId: string,
    item: ProviderPoolItemInput,
    now: Date,
  ): void {
    const provider = this.catalog.providers.find(
      candidate => candidate.providerId === providerId && candidate.status === 'ACTIVE',
    )
    const verifiedAt = new Date(item.sourceVerifiedAt)
    const optionComplete = item.optionType !== null
      && item.underlyingSymbol !== null
      && item.expiryDate !== null
      && item.strikePrice !== null
      && Number(item.strikePrice) > 0
      && item.contractMultiplier !== null
      && Number(item.contractMultiplier) > 0
    const optionEmpty = item.optionType === null
      && item.underlyingSymbol === null
      && item.expiryDate === null
      && item.strikePrice === null
      && item.contractMultiplier === null
    if (
      !provider
      || !provider.supportedMarkets.includes(item.market)
      || !provider.supportedInstrumentTypes.includes(item.instrumentType)
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.providerSymbol)
      || item.canonicalSymbol.length < 1 || item.canonicalSymbol.length > 128
      || item.displayName.length < 1 || item.displayName.length > 200
      || !/^[A-Z]{3}$/.test(item.currency)
      || Number.isNaN(verifiedAt.getTime())
      || verifiedAt.getTime() > now.getTime() + 30_000
      || now.getTime() - verifiedAt.getTime() > 5 * 60_000
      || (item.instrumentType === 'OPTION' ? !optionComplete : !optionEmpty)
    ) throw new ProviderPoolError('PROVIDER_POOL_ITEM_INVALID')
  }

  private encodeCursor(version: number, addedAt: string, itemId: string): string {
    return Buffer.from(JSON.stringify({ version, addedAt, itemId })).toString('base64url')
  }

  private decodeCursor(
    cursor: string | null | undefined,
    expectedVersion: number,
  ): { addedAt: string; itemId: string } | null {
    if (!cursor) return null
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        version?: unknown
        addedAt?: unknown
        itemId?: unknown
      }
      if (
        parsed.version !== expectedVersion
        || typeof parsed.addedAt !== 'string'
        || Number.isNaN(Date.parse(parsed.addedAt))
        || typeof parsed.itemId !== 'string'
        || !/^[0-9a-f-]{36}$/i.test(parsed.itemId)
      ) throw new Error('invalid')
      return { addedAt: parsed.addedAt, itemId: parsed.itemId }
    } catch {
      throw new ProviderPoolError('POOL_CURSOR_INVALID_OR_STALE')
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
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
