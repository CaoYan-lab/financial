import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { PostgresAdminRepository } from './postgresAdminRepository.js'

export type AdminBillingPeriod = 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
export type AdminSubscriptionStatus = 'ACTIVE' | 'FROZEN' | 'CANCELLED'

type SubscriptionRow = {
  subscription_id: string
  user_id: string
  plan_version_id: string
  billing_period: AdminBillingPeriod
  status: AdminSubscriptionStatus
  version: string
  starts_at: Date
  current_period_start: Date
  expires_at: Date
  source: 'PAYMENT' | 'ADMIN_GRANT'
  plan_code: string
  plan_version: number
  display_name: string
  broker_slot_limit: number
  pool_capacity_per_provider: number | null
}

type PlanRow = {
  plan_version_id: string
  plan_code: string
  version: number
  display_name: string
  broker_slot_limit: number
  pool_capacity_per_provider: number | null
}

type SlotRow = {
  slot_id: string
  slot_ordinal: number
  provider_id: string | null
  status: 'ACTIVE' | 'FROZEN' | 'EMPTY'
  bound_at: Date | null
  next_rebind_at: Date | null
  version: string
}

type MutationContext = {
  userId: string
  expectedVersion: number
  reason: string
  actorAdminUserId: string
  requestId: string
  sourceIp: string | null
  now?: Date
}

export class AdminSubscriptionError extends Error {
  constructor(readonly code: string) {
    super('用户套餐操作失败')
    this.name = 'AdminSubscriptionError'
  }
}

export class PostgresAdminSubscriptionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly adminRepository: PostgresAdminRepository,
  ) {}

  async current(userId: string): Promise<Record<string, unknown> | null> {
    const row = await this.subscription(this.pool, userId, false)
    return row ? this.serialize(this.pool, row) : null
  }

  async history(userId: string): Promise<Record<string, unknown>> {
    const [grants, events] = await Promise.all([
      this.pool.query<{
        grant_id: string
        subscription_id: string
        previous_plan_version_id: string | null
        next_plan_version_id: string
        billing_period: AdminBillingPeriod
        starts_at: Date
        expires_at: Date
        status: string
        retained_providers: string[]
        reason: string
        request_version: string
        actor_username: string
        created_at: Date
      }>(
        `SELECT g.grant_id, g.subscription_id, g.previous_plan_version_id,
                g.next_plan_version_id, g.billing_period, g.starts_at, g.expires_at,
                g.status, g.retained_providers, g.reason, g.request_version,
                a.username AS actor_username, g.created_at
           FROM changfu_admin.subscription_grants g
           JOIN changfu_admin.admin_users a
             ON a.admin_user_id = g.actor_admin_user_id
          WHERE g.user_id = $1::bigint
          ORDER BY g.created_at DESC`,
        [userId],
      ),
      this.pool.query<{
        subscription_event_id: string
        subscription_id: string
        event_type: string
        previous_plan_version_id: string | null
        next_plan_version_id: string | null
        reason_code: string | null
        metadata: unknown
        occurred_at: Date
      }>(
        `SELECT subscription_event_id, subscription_id, event_type,
                previous_plan_version_id, next_plan_version_id,
                reason_code, metadata, occurred_at
           FROM changfu.subscription_events
          WHERE user_id = $1::bigint
          ORDER BY occurred_at DESC`,
        [userId],
      ),
    ])
    return {
      grants: grants.rows.map(row => ({
        grantId: row.grant_id,
        subscriptionId: row.subscription_id,
        previousPlanVersionId: row.previous_plan_version_id,
        nextPlanVersionId: row.next_plan_version_id,
        billingPeriod: row.billing_period,
        startsAt: row.starts_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        status: row.status,
        retainedProviders: row.retained_providers,
        reason: row.reason,
        requestVersion: Number(row.request_version),
        actorUsername: row.actor_username,
        createdAt: row.created_at.toISOString(),
      })),
      events: events.rows.map(row => ({
        subscriptionEventId: row.subscription_event_id,
        subscriptionId: row.subscription_id,
        eventType: row.event_type,
        previousPlanVersionId: row.previous_plan_version_id,
        nextPlanVersionId: row.next_plan_version_id,
        reasonCode: row.reason_code,
        metadata: row.metadata,
        occurredAt: row.occurred_at.toISOString(),
      })),
    }
  }

  async grant(input: MutationContext & {
    planVersionId: string
    billingPeriod: AdminBillingPeriod
    startsAt: Date
    expiresAt: Date
    providerIds: string[]
    confirmImpact: boolean
  }): Promise<Record<string, unknown>> {
    return this.transaction(async client => {
      await this.lockUser(client, input.userId)
      const current = await this.subscription(client, input.userId, true)
      this.assertVersion(current, input.expectedVersion)
      const plan = await this.activePlan(client, input.planVersionId)
      await this.assertProviders(client, input.providerIds, plan.broker_slot_limit)
      if (input.expiresAt <= input.startsAt) {
        throw new AdminSubscriptionError('SUBSCRIPTION_PERIOD_INVALID')
      }
      if (current && !input.confirmImpact && (
        plan.broker_slot_limit < current.broker_slot_limit
        || input.expiresAt < current.expires_at
      )) throw new AdminSubscriptionError('SUBSCRIPTION_IMPACT_CONFIRMATION_REQUIRED')

      const now = input.now ?? new Date()
      const subscriptionId = current?.subscription_id ?? randomUUID()
      if (current) {
        await client.query(
          `UPDATE changfu.user_subscriptions
              SET plan_version_id = $3::uuid, billing_period = $4, status = 'ACTIVE',
                  version = version + 1, starts_at = $5, current_period_start = $5,
                  expires_at = $6, pending_plan_version_id = NULL,
                  pending_billing_period = NULL, pending_effective_at = NULL,
                  source = 'ADMIN_GRANT', updated_at = $7
            WHERE subscription_id = $1::uuid AND user_id = $2::bigint`,
          [
            subscriptionId,
            input.userId,
            plan.plan_version_id,
            input.billingPeriod,
            input.startsAt,
            input.expiresAt,
            now,
          ],
        )
        await client.query(
          `DELETE FROM changfu.subscription_pending_provider_selections
            WHERE subscription_id = $1::uuid`,
          [subscriptionId],
        )
      } else {
        await client.query(
          `INSERT INTO changfu.user_subscriptions (
             subscription_id, user_id, plan_version_id, billing_period, status,
             purchased_at, starts_at, current_period_start, expires_at,
             source, created_at, updated_at
           ) VALUES (
             $1::uuid, $2::bigint, $3::uuid, $4, 'ACTIVE',
             $5, $6, $6, $7, 'ADMIN_GRANT', $5, $5
           )`,
          [
            subscriptionId,
            input.userId,
            plan.plan_version_id,
            input.billingPeriod,
            now,
            input.startsAt,
            input.expiresAt,
          ],
        )
      }
      await this.syncSlots(client, {
        subscriptionId,
        userId: input.userId,
        providerIds: input.providerIds,
        slotLimit: plan.broker_slot_limit,
        subscriptionStatus: 'ACTIVE',
        capacity: plan.pool_capacity_per_provider,
        now,
      })
      const grantStatus = current ? 'ADJUSTED' : 'GRANTED'
      await this.recordMutation(client, {
        ...input,
        subscriptionId,
        previousPlanVersionId: current?.plan_version_id ?? null,
        nextPlanVersionId: plan.plan_version_id,
        grantStatus,
        eventType: current ? 'ADMIN_ADJUSTED' : 'ADMIN_GRANTED',
        providerIds: input.providerIds,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        billingPeriod: input.billingPeriod,
      })
      return (await this.currentWith(client, input.userId))!
    })
  }

  async setStatus(input: MutationContext & {
    action: 'freeze' | 'restore' | 'cancel'
  }): Promise<Record<string, unknown>> {
    return this.transaction(async client => {
      await this.lockUser(client, input.userId)
      const current = await this.subscription(client, input.userId, true)
      if (!current) throw new AdminSubscriptionError('SUBSCRIPTION_NOT_FOUND')
      this.assertVersion(current, input.expectedVersion)
      const nextStatus = input.action === 'restore' ? 'ACTIVE'
        : input.action === 'freeze' ? 'FROZEN' : 'CANCELLED'
      if (
        (input.action === 'freeze' && current.status !== 'ACTIVE')
        || (input.action === 'restore' && current.status !== 'FROZEN')
      ) throw new AdminSubscriptionError('SUBSCRIPTION_STATUS_CONFLICT')
      const now = input.now ?? new Date()
      await client.query(
        `UPDATE changfu.user_subscriptions
            SET status = $3, version = version + 1, updated_at = $4
          WHERE subscription_id = $1::uuid AND user_id = $2::bigint`,
        [current.subscription_id, input.userId, nextStatus, now],
      )
      const slotStatus = nextStatus === 'ACTIVE' ? 'ACTIVE' : 'FROZEN'
      await client.query(
        `UPDATE changfu.subscription_broker_slots
            SET status = CASE WHEN provider_id IS NULL THEN 'EMPTY' ELSE $3 END,
                version = version + 1, updated_at = $4
          WHERE subscription_id = $1::uuid AND user_id = $2::bigint`,
        [current.subscription_id, input.userId, slotStatus, now],
      )
      await client.query(
        `UPDATE changfu.provider_research_pools p
            SET status = $2,
                frozen_reason = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE $3 END,
                updated_at = $4
          WHERE p.user_id = $1::bigint
            AND EXISTS (
              SELECT 1 FROM changfu.subscription_broker_slots s
               WHERE s.subscription_id = $5::uuid
                 AND s.user_id = p.user_id
                 AND s.provider_id = p.provider_id
                 AND s.slot_ordinal <= $6
            )`,
        [
          input.userId,
          nextStatus === 'ACTIVE' ? 'ACTIVE' : 'FROZEN',
          input.action === 'cancel' ? 'ADMIN_CANCELLED' : 'ADMIN_FROZEN',
          now,
          current.subscription_id,
          current.broker_slot_limit,
        ],
      )
      const providerIds = await this.boundProviderIds(client, current.subscription_id)
      await this.recordMutation(client, {
        ...input,
        subscriptionId: current.subscription_id,
        previousPlanVersionId: current.plan_version_id,
        nextPlanVersionId: current.plan_version_id,
        grantStatus: input.action === 'freeze'
          ? 'FROZEN'
          : input.action === 'restore' ? 'RESTORED' : 'CANCELLED',
        eventType: input.action === 'freeze'
          ? 'ADMIN_FROZEN'
          : input.action === 'restore' ? 'ADMIN_RESTORED' : 'ADMIN_CANCELLED',
        providerIds,
        startsAt: current.starts_at,
        expiresAt: current.expires_at,
        billingPeriod: current.billing_period,
      })
      if (nextStatus === 'CANCELLED') {
        return {
          ...(await this.serialize(client, { ...current, status: 'CANCELLED' })),
          status: 'CANCELLED',
          version: Number(current.version) + 1,
        }
      }
      return (await this.currentWith(client, input.userId))!
    })
  }

  async updateSlots(input: MutationContext & {
    providerIds: string[]
    confirmImpact: boolean
  }): Promise<Record<string, unknown>> {
    return this.transaction(async client => {
      await this.lockUser(client, input.userId)
      const current = await this.subscription(client, input.userId, true)
      if (!current) throw new AdminSubscriptionError('SUBSCRIPTION_NOT_FOUND')
      this.assertVersion(current, input.expectedVersion)
      await this.assertProviders(client, input.providerIds, current.broker_slot_limit)
      const previousProviders = await this.boundProviderIds(client, current.subscription_id)
      const removed = previousProviders.filter(item => !input.providerIds.includes(item))
      if (removed.length > 0 && !input.confirmImpact) {
        throw new AdminSubscriptionError('SUBSCRIPTION_IMPACT_CONFIRMATION_REQUIRED')
      }
      const now = input.now ?? new Date()
      await this.syncSlots(client, {
        subscriptionId: current.subscription_id,
        userId: input.userId,
        providerIds: input.providerIds,
        slotLimit: current.broker_slot_limit,
        subscriptionStatus: current.status,
        capacity: current.pool_capacity_per_provider,
        now,
      })
      await client.query(
        `UPDATE changfu.user_subscriptions
            SET version = version + 1, source = 'ADMIN_GRANT', updated_at = $3
          WHERE subscription_id = $1::uuid AND user_id = $2::bigint`,
        [current.subscription_id, input.userId, now],
      )
      await this.recordMutation(client, {
        ...input,
        subscriptionId: current.subscription_id,
        previousPlanVersionId: current.plan_version_id,
        nextPlanVersionId: current.plan_version_id,
        grantStatus: 'ADJUSTED',
        eventType: 'ADMIN_ADJUSTED',
        providerIds: input.providerIds,
        startsAt: current.starts_at,
        expiresAt: current.expires_at,
        billingPeriod: current.billing_period,
      })
      return (await this.currentWith(client, input.userId))!
    })
  }

  private async activePlan(client: PoolClient, planVersionId: string): Promise<PlanRow> {
    const result = await client.query<PlanRow>(
      `SELECT plan_version_id, plan_code, version, display_name,
              broker_slot_limit, pool_capacity_per_provider
         FROM changfu.subscription_plan_versions
        WHERE plan_version_id = $1::uuid
          AND status = 'ACTIVE'
          AND effective_from <= now()
          AND (effective_until IS NULL OR effective_until > now())
        FOR SHARE`,
      [planVersionId],
    )
    const plan = result.rows[0]
    if (!plan) throw new AdminSubscriptionError('ACTIVE_PLAN_VERSION_NOT_FOUND')
    return plan
  }

  private async assertProviders(
    client: PoolClient,
    providerIds: string[],
    slotLimit: number,
  ): Promise<void> {
    if (
      providerIds.length > slotLimit
      || new Set(providerIds).size !== providerIds.length
    ) throw new AdminSubscriptionError('SUBSCRIPTION_PROVIDER_SELECTION_INVALID')
    if (providerIds.length === 0) return
    const result = await client.query<{ provider_id: string }>(
      `SELECT provider_id
         FROM changfu.broker_provider_catalog
        WHERE provider_id = ANY($1::varchar[]) AND status = 'ACTIVE'`,
      [providerIds],
    )
    if (result.rowCount !== providerIds.length) {
      throw new AdminSubscriptionError('SUBSCRIPTION_PROVIDER_NOT_AVAILABLE')
    }
  }

  private async syncSlots(client: PoolClient, input: {
    subscriptionId: string
    userId: string
    providerIds: string[]
    slotLimit: number
    subscriptionStatus: AdminSubscriptionStatus
    capacity: number | null
    now: Date
  }): Promise<void> {
    const existingResult = await client.query<SlotRow>(
      `SELECT slot_id, slot_ordinal, provider_id, status, bound_at,
              next_rebind_at, version
         FROM changfu.subscription_broker_slots
        WHERE user_id = $1::bigint
        ORDER BY slot_ordinal
        FOR UPDATE`,
      [input.userId],
    )
    const existingByProvider = new Map(
      existingResult.rows
        .filter((row): row is SlotRow & { provider_id: string } => Boolean(row.provider_id))
        .map(row => [row.provider_id, row]),
    )
    const removedProviders = [...existingByProvider.keys()]
      .filter(providerId => !input.providerIds.includes(providerId))
    await client.query(
      `UPDATE changfu.subscription_broker_slots
          SET provider_id = NULL, status = 'EMPTY', bound_at = NULL,
              next_rebind_at = NULL, version = version + 1, updated_at = $2
        WHERE user_id = $1::bigint`,
      [input.userId, input.now],
    )
    const selectedStatus = input.subscriptionStatus === 'ACTIVE' ? 'ACTIVE' : 'FROZEN'
    for (let index = 0; index < input.slotLimit; index += 1) {
      const ordinal = index + 1
      const providerId = input.providerIds[index] ?? null
      const prior = providerId ? existingByProvider.get(providerId) : undefined
      const slotId = existingResult.rows.find(row => row.slot_ordinal === ordinal)?.slot_id
        ?? randomUUID()
      const boundAt = providerId ? prior?.bound_at ?? input.now : null
      const nextRebindAt = providerId
        ? prior?.next_rebind_at ?? this.addMonth(input.now)
        : null
      await client.query(
        `INSERT INTO changfu.subscription_broker_slots (
           slot_id, subscription_id, user_id, slot_ordinal, provider_id,
           status, bound_at, next_rebind_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, slot_ordinal) DO UPDATE SET
           subscription_id = EXCLUDED.subscription_id,
           provider_id = EXCLUDED.provider_id,
           status = EXCLUDED.status,
           bound_at = EXCLUDED.bound_at,
           next_rebind_at = EXCLUDED.next_rebind_at,
           version = changfu.subscription_broker_slots.version + 1,
           updated_at = EXCLUDED.updated_at`,
        [
          slotId,
          input.subscriptionId,
          input.userId,
          ordinal,
          providerId,
          providerId ? selectedStatus : 'EMPTY',
          boundAt,
          nextRebindAt,
          input.now,
        ],
      )
      if (providerId) {
        await client.query(
          `INSERT INTO changfu.provider_research_pools (
             user_id, provider_id, version, status, frozen_reason, updated_at
           ) VALUES ($1::bigint, $2, 1, $3, $4, $5)
           ON CONFLICT (user_id, provider_id) DO UPDATE
             SET status = EXCLUDED.status, frozen_reason = EXCLUDED.frozen_reason,
                 updated_at = EXCLUDED.updated_at`,
          [
            input.userId,
            providerId,
            selectedStatus,
            selectedStatus === 'ACTIVE' ? null : 'SUBSCRIPTION_FROZEN',
            input.now,
          ],
        )
        await this.applyCapacity(client, input.userId, providerId, input.capacity, input.now)
      }
    }
    for (const [offset, providerId] of removedProviders.entries()) {
      const ordinal = input.slotLimit + offset + 1
      const prior = existingByProvider.get(providerId)!
      const slotId = existingResult.rows.find(row => row.slot_ordinal === ordinal)?.slot_id
        ?? randomUUID()
      await client.query(
        `INSERT INTO changfu.subscription_broker_slots (
           slot_id, subscription_id, user_id, slot_ordinal, provider_id,
           status, bound_at, next_rebind_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5, 'FROZEN', $6, $7, $8)
         ON CONFLICT (user_id, slot_ordinal) DO UPDATE SET
           subscription_id = EXCLUDED.subscription_id,
           provider_id = EXCLUDED.provider_id,
           status = 'FROZEN', bound_at = EXCLUDED.bound_at,
           next_rebind_at = EXCLUDED.next_rebind_at,
           version = changfu.subscription_broker_slots.version + 1,
           updated_at = EXCLUDED.updated_at`,
        [
          slotId,
          input.subscriptionId,
          input.userId,
          ordinal,
          providerId,
          prior.bound_at ?? input.now,
          prior.next_rebind_at ?? this.addMonth(input.now),
          input.now,
        ],
      )
      await client.query(
        `UPDATE changfu.provider_research_pools
            SET status = 'FROZEN', frozen_reason = 'ADMIN_SLOT_REMOVED', updated_at = $3
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [input.userId, providerId, input.now],
      )
      await client.query(
        `UPDATE changfu.provider_research_pool_items
            SET status = 'FROZEN', updated_at = $3
          WHERE user_id = $1::bigint AND provider_id = $2 AND status = 'ACTIVE'`,
        [input.userId, providerId, input.now],
      )
      await this.bindingHistory(client, input, prior.slot_id, providerId, providerId, 'FROZEN')
    }
    for (const providerId of input.providerIds) {
      const prior = existingByProvider.get(providerId)
      const currentSlot = await client.query<{ slot_id: string }>(
        `SELECT slot_id FROM changfu.subscription_broker_slots
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [input.userId, providerId],
      )
      if (!prior && currentSlot.rows[0]) {
        await this.bindingHistory(
          client,
          input,
          currentSlot.rows[0].slot_id,
          null,
          providerId,
          'BOUND',
        )
      } else if (prior?.status === 'FROZEN' && selectedStatus === 'ACTIVE' && currentSlot.rows[0]) {
        await this.bindingHistory(
          client,
          input,
          currentSlot.rows[0].slot_id,
          providerId,
          providerId,
          'RESTORED',
        )
      }
    }
  }

  private async applyCapacity(
    client: PoolClient,
    userId: string,
    providerId: string,
    capacity: number | null,
    now: Date,
  ): Promise<void> {
    await client.query(
      `WITH ranked AS (
         SELECT item_id, row_number() OVER (ORDER BY added_at, item_id) AS rank
           FROM changfu.provider_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2
            AND status IN ('ACTIVE', 'FROZEN')
       )
       UPDATE changfu.provider_research_pool_items item
          SET status = CASE
            WHEN $3::integer IS NULL OR ranked.rank <= $3 THEN 'ACTIVE'
            ELSE 'FROZEN'
          END,
          updated_at = $4
         FROM ranked
        WHERE item.item_id = ranked.item_id`,
      [userId, providerId, capacity, now],
    )
  }

  private async recordMutation(client: PoolClient, input: MutationContext & {
    subscriptionId: string
    previousPlanVersionId: string | null
    nextPlanVersionId: string
    grantStatus: 'GRANTED' | 'ADJUSTED' | 'FROZEN' | 'RESTORED' | 'CANCELLED'
    eventType: 'ADMIN_GRANTED' | 'ADMIN_ADJUSTED' | 'ADMIN_FROZEN'
      | 'ADMIN_RESTORED' | 'ADMIN_CANCELLED'
    providerIds: string[]
    startsAt: Date
    expiresAt: Date
    billingPeriod: AdminBillingPeriod
  }): Promise<void> {
    const grantId = randomUUID()
    await client.query(
      `INSERT INTO changfu_admin.subscription_grants (
         grant_id, user_id, subscription_id, previous_plan_version_id,
         next_plan_version_id, billing_period, starts_at, expires_at, status,
         retained_providers, reason, request_version, actor_admin_user_id
       ) VALUES (
         $1::uuid, $2::bigint, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8,
         $9, $10::varchar[], $11, $12, $13::uuid
       )`,
      [
        grantId,
        input.userId,
        input.subscriptionId,
        input.previousPlanVersionId,
        input.nextPlanVersionId,
        input.billingPeriod,
        input.startsAt,
        input.expiresAt,
        input.grantStatus,
        input.providerIds,
        input.reason,
        input.expectedVersion,
        input.actorAdminUserId,
      ],
    )
    await client.query(
      `UPDATE changfu.user_subscriptions
          SET latest_grant_id = $2::uuid
        WHERE subscription_id = $1::uuid`,
      [input.subscriptionId, grantId],
    )
    await client.query(
      `INSERT INTO changfu.subscription_events (
         subscription_event_id, subscription_id, user_id, event_type,
         previous_plan_version_id, next_plan_version_id, reason_code,
         metadata, occurred_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::bigint, $4, $5::uuid, $6::uuid,
         'ADMIN_ACTION', $7::jsonb, COALESCE($8::timestamptz, now())
       )`,
      [
        randomUUID(),
        input.subscriptionId,
        input.userId,
        input.eventType,
        input.previousPlanVersionId,
        input.nextPlanVersionId,
        JSON.stringify({ grantId, retainedProviders: input.providerIds }),
        input.now ?? null,
      ],
    )
    await this.adminRepository.writeAudit(client, {
      actorAdminUserId: input.actorAdminUserId,
      action: input.eventType,
      resourceType: 'USER_SUBSCRIPTION',
      resourceId: input.subscriptionId,
      outcome: 'SUCCESS',
      requestId: input.requestId,
      sourceIp: input.sourceIp,
      afterSummary: {
        userId: input.userId,
        planVersionId: input.nextPlanVersionId,
        status: input.grantStatus,
        providerIds: input.providerIds,
        reason: input.reason,
      },
    })
  }

  private async bindingHistory(
    client: PoolClient,
    input: {
      subscriptionId: string
      userId: string
      now: Date
    },
    slotId: string,
    previousProviderId: string | null,
    nextProviderId: string | null,
    eventType: 'BOUND' | 'REBOUND' | 'FROZEN' | 'RESTORED',
  ): Promise<void> {
    await client.query(
      `INSERT INTO changfu.subscription_broker_binding_history (
         binding_event_id, subscription_id, user_id, slot_id,
         previous_provider_id, next_provider_id, event_type, occurred_at
       ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6, $7, $8)`,
      [
        randomUUID(),
        input.subscriptionId,
        input.userId,
        slotId,
        previousProviderId,
        nextProviderId,
        eventType,
        input.now,
      ],
    )
  }

  private async lockUser(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query(
      `SELECT u.id
         FROM public.cloud_users u
         JOIN multiuser.user_profiles p ON p.user_id = u.id
        WHERE u.id = $1::bigint AND p.role = 'member'
        FOR UPDATE OF u, p`,
      [userId],
    )
    if (!result.rowCount) throw new AdminSubscriptionError('USER_NOT_FOUND')
  }

  private assertVersion(current: SubscriptionRow | null, expectedVersion: number): void {
    const actual = current ? Number(current.version) : 0
    if (actual !== expectedVersion) {
      throw new AdminSubscriptionError('SUBSCRIPTION_VERSION_CONFLICT')
    }
  }

  private async subscription(
    queryable: Pool | PoolClient,
    userId: string,
    lock: boolean,
  ): Promise<SubscriptionRow | null> {
    const result = await queryable.query<SubscriptionRow>(
      `SELECT s.subscription_id, s.user_id, s.plan_version_id, s.billing_period,
              s.status, s.version, s.starts_at, s.current_period_start,
              s.expires_at, s.source, p.plan_code, p.version AS plan_version,
              p.display_name, p.broker_slot_limit, p.pool_capacity_per_provider
         FROM changfu.user_subscriptions s
         JOIN changfu.subscription_plan_versions p
           ON p.plan_version_id = s.plan_version_id
        WHERE s.user_id = $1::bigint AND s.status IN ('ACTIVE', 'FROZEN')
        ORDER BY s.updated_at DESC
        LIMIT 1${lock ? ' FOR UPDATE OF s' : ''}`,
      [userId],
    )
    return result.rows[0] ?? null
  }

  private async currentWith(
    queryable: PoolClient,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.subscription(queryable, userId, false)
    return row ? this.serialize(queryable, row) : null
  }

  private async serialize(
    queryable: Pool | PoolClient,
    row: SubscriptionRow,
  ): Promise<Record<string, unknown>> {
    const [slots, pools] = await Promise.all([
      queryable.query<SlotRow>(
        `SELECT slot_id, slot_ordinal, provider_id, status, bound_at,
                next_rebind_at, version
           FROM changfu.subscription_broker_slots
          WHERE subscription_id = $1::uuid
          ORDER BY slot_ordinal`,
        [row.subscription_id],
      ),
      queryable.query<{
        provider_id: string
        status: string
        used: number
      }>(
        `SELECT p.provider_id, p.status,
                count(i.item_id) FILTER (
                  WHERE i.status IN ('ACTIVE', 'FROZEN')
                )::integer AS used
           FROM changfu.provider_research_pools p
           LEFT JOIN changfu.provider_research_pool_items i
             ON i.user_id = p.user_id AND i.provider_id = p.provider_id
          WHERE p.user_id = $1::bigint
          GROUP BY p.provider_id, p.status
          ORDER BY p.provider_id`,
        [row.user_id],
      ),
    ])
    const activeSlots = slots.rows.filter(slot => slot.status !== 'EMPTY')
    return {
      subscriptionId: row.subscription_id,
      userId: row.user_id,
      planVersionId: row.plan_version_id,
      planCode: row.plan_code,
      planVersion: row.plan_version,
      planDisplayName: row.display_name,
      billingPeriod: row.billing_period,
      status: row.status,
      source: row.source,
      version: Number(row.version),
      startsAt: row.starts_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      usedSlots: activeSlots.filter(slot => (
        slot.slot_ordinal <= row.broker_slot_limit && slot.status === 'ACTIVE'
      )).length,
      totalSlots: row.broker_slot_limit,
      slots: slots.rows.map(slot => ({
        slotId: slot.slot_id,
        slotOrdinal: slot.slot_ordinal,
        providerId: slot.provider_id,
        status: slot.status,
        boundAt: slot.bound_at?.toISOString() ?? null,
        nextRebindAt: slot.next_rebind_at?.toISOString() ?? null,
        version: Number(slot.version),
      })),
      providerPools: pools.rows.map(pool => ({
        providerId: pool.provider_id,
        status: pool.status,
        used: pool.used,
        capacity: row.pool_capacity_per_provider,
      })),
    }
  }

  private async boundProviderIds(
    queryable: Pool | PoolClient,
    subscriptionId: string,
  ): Promise<string[]> {
    const result = await queryable.query<{ provider_id: string }>(
      `SELECT provider_id
         FROM changfu.subscription_broker_slots
        WHERE subscription_id = $1::uuid
          AND provider_id IS NOT NULL
          AND status IN ('ACTIVE', 'FROZEN')
        ORDER BY slot_ordinal`,
      [subscriptionId],
    )
    return result.rows.map(row => row.provider_id)
  }

  private addMonth(value: Date): Date {
    const next = new Date(value)
    const day = next.getUTCDate()
    next.setUTCDate(1)
    next.setUTCMonth(next.getUTCMonth() + 1)
    const lastDay = new Date(Date.UTC(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      0,
    )).getUTCDate()
    next.setUTCDate(Math.min(day, lastDay))
    return next
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
