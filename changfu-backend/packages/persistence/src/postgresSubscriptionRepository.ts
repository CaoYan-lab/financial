import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  addCalendarMonths,
  billingPeriodMonths,
  renewalStart,
  subscriptionExpiry,
  type BillingPeriod,
} from '../../subscriptions/src/billingClock.js'
import type {
  SubscriptionPlan,
  SubscriptionPrice,
} from '../../subscriptions/src/catalog.js'
import {
  isSubscriptionEffective,
  validateOrderType,
  validateProviderSelections,
  validateScheduledChange,
  type SubscriptionOrderType,
} from '../../subscriptions/src/subscriptionService.js'
import { calculateUpgradeCredit } from '../../subscriptions/src/upgradeCredit.js'

type Queryable = Pool | PoolClient

type SubscriptionRow = {
  subscription_id: string
  user_id: string
  plan_version_id: string
  plan_code: SubscriptionPlan['planCode']
  plan_name: string
  billing_period: BillingPeriod
  status: 'ACTIVE' | 'FROZEN' | 'CANCELLED'
  version: string
  purchased_at: Date
  starts_at: Date
  current_period_start: Date
  expires_at: Date
  pending_plan_version_id: string | null
  pending_plan_code: SubscriptionPlan['planCode'] | null
  pending_billing_period: BillingPeriod | null
  pending_effective_at: Date | null
}

export type CreateSubscriptionOrderInput = {
  userId: string
  orderType: SubscriptionOrderType
  planVersionId: string
  billingPeriod: BillingPeriod
  providerIds: string[]
  idempotencyKey: string
  now?: Date
}

export class SubscriptionRepositoryError extends Error {
  constructor(readonly code: string) {
    super('订阅数据状态冲突')
    this.name = 'SubscriptionRepositoryError'
  }
}

export class PostgresSubscriptionRepository {
  constructor(private readonly pool: Pool) {}

  async getCurrent(userId: string, now = new Date()): Promise<unknown | null> {
    return this.transaction(async client => {
      await this.materializeDueChange(client, userId, now)
      const row = await this.getSubscriptionRow(client, userId, false)
      return row ? this.serializeSubscription(client, row, now) : null
    })
  }

  async createOrder(input: CreateSubscriptionOrderInput): Promise<unknown> {
    const now = input.now ?? new Date()
    return this.transaction(async client => {
      const targetPlan = await this.plan(client, input.planVersionId, true)
      const price = this.price(targetPlan, input.billingPeriod)
      const providerIds = validateProviderSelections(input.providerIds, targetPlan.brokerSlotLimit)
      await this.assertProvidersAvailable(client, providerIds)
      await this.materializeDueChange(client, input.userId, now)
      const current = await this.getSubscriptionRow(client, input.userId, true)
      const currentPlan = current ? await this.plan(client, current.plan_version_id) : null
      validateOrderType({
        orderType: input.orderType,
        targetPlan,
        currentPlan,
        currentEffective: current ? this.rowIsEffective(current, now) : false,
      })
      if (input.orderType !== 'NEW' && current) {
        const bound = await this.boundProviderIds(client, current.subscription_id)
        if (
          input.orderType === 'RENEW'
          && (
            providerIds.some(providerId => !bound.includes(providerId))
            || bound.some(providerId => !providerIds.includes(providerId))
          )
        ) {
          throw new SubscriptionRepositoryError('ORDER_PROVIDER_NOT_BOUND')
        }
        if (
          input.orderType === 'UPGRADE'
          && bound.some(providerId => !providerIds.includes(providerId))
        ) throw new SubscriptionRepositoryError('UPGRADE_MUST_RETAIN_BOUND_PROVIDERS')
      }

      let creditAmountMinor = 0
      let creditBasis: Record<string, unknown> | null = null
      if (input.orderType === 'UPGRADE' && current) {
        const paid = await client.query<{
          payable_amount_minor: number
        }>(
          `SELECT payable_amount_minor
             FROM changfu.subscription_orders
            WHERE subscription_id = $1::uuid AND status = 'PAID'
            ORDER BY paid_at DESC
            LIMIT 1`,
          [current.subscription_id],
        )
        const credit = calculateUpgradeCredit({
          sourceOrderPaidAmountMinor: paid.rows[0]?.payable_amount_minor ?? 0,
          sourcePeriodStart: current.current_period_start,
          sourcePeriodEnd: current.expires_at,
          calculatedAt: now,
        })
        creditAmountMinor = Math.min(price.amountMinor, credit.amountMinor)
        creditBasis = {
          sourceOrderPaidAmountMinor: credit.sourceOrderPaidAmountMinor,
          remainingSeconds: credit.remainingSeconds,
          sourcePeriodSeconds: credit.sourcePeriodSeconds,
          calculatedAt: credit.calculatedAt,
        }
      }

      const orderId = randomUUID()
      const businessOrderNo = `CF${now.toISOString().replace(/\D/g, '').slice(0, 14)}${orderId.replaceAll('-', '').slice(0, 12).toUpperCase()}`
      await client.query(
        `INSERT INTO changfu.subscription_orders (
           order_id, business_order_no, user_id, subscription_id, order_type,
           plan_version_id, price_id, plan_code_snapshot, plan_version_snapshot,
           billing_period, duration_months, currency, original_amount_minor,
           credit_amount_minor, payable_amount_minor, credit_basis, status,
           idempotency_key, quote_expires_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $3::bigint, $4::uuid, $5, $6::uuid, $7::uuid, $8, $9,
           $10, $11, 'CNY', $12, $13, $14, $15::jsonb, 'CREATED',
           $16, $17::timestamptz, $18::timestamptz, $18::timestamptz
         )`,
        [
          orderId,
          businessOrderNo,
          input.userId,
          current?.subscription_id ?? null,
          input.orderType,
          targetPlan.planVersionId,
          price.priceId,
          targetPlan.planCode,
          targetPlan.version,
          input.billingPeriod,
          price.durationMonths,
          price.amountMinor,
          creditAmountMinor,
          price.amountMinor - creditAmountMinor,
          creditBasis ? JSON.stringify(creditBasis) : null,
          input.idempotencyKey,
          new Date(now.getTime() + 15 * 60_000),
          now,
        ],
      )
      for (const [index, providerId] of providerIds.entries()) {
        await client.query(
          `INSERT INTO changfu.subscription_order_provider_selections (
             order_id, slot_ordinal, provider_id
           ) VALUES ($1::uuid, $2, $3)`,
          [orderId, index + 1, providerId],
        )
      }
      return this.getOrderWith(client, input.userId, orderId)
    })
  }

  async getOrder(userId: string, orderId: string): Promise<unknown | null> {
    return this.getOrderWith(this.pool, userId, orderId)
  }

  async markPaymentPending(input: {
    userId: string
    orderId: string
    channel: 'WECHAT' | 'ALIPAY' | 'DOUYIN'
    providerOrderId: string
    paymentUrl: string | null
    qrCodePayload: string | null
    expiresAt: Date
    now?: Date
  }): Promise<unknown> {
    const now = input.now ?? new Date()
    return this.transaction(async client => {
      const locked = await client.query<{
        status: string
        quote_expires_at: Date
      }>(
        `SELECT status, quote_expires_at
           FROM changfu.subscription_orders
          WHERE order_id = $1::uuid AND user_id = $2::bigint
          FOR UPDATE`,
        [input.orderId, input.userId],
      )
      const order = locked.rows[0]
      if (!order) throw new SubscriptionRepositoryError('ORDER_NOT_FOUND')
      if (!['CREATED', 'FAILED'].includes(order.status)) {
        throw new SubscriptionRepositoryError('ORDER_NOT_PAYABLE')
      }
      if (order.quote_expires_at.getTime() <= now.getTime()) {
        throw new SubscriptionRepositoryError('ORDER_QUOTE_EXPIRED')
      }
      const attempts = await client.query<{ next_attempt: number }>(
        `SELECT (count(*) + 1)::int AS next_attempt
           FROM changfu.payment_attempts
          WHERE order_id = $1::uuid`,
        [input.orderId],
      )
      await client.query(
        `INSERT INTO changfu.payment_attempts (
           payment_attempt_id, order_id, channel, attempt_number, status,
           provider_order_id, response_metadata, expires_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, 'PENDING', $5, $6::jsonb,
           $7::timestamptz, $8::timestamptz, $8::timestamptz
         )`,
        [
          randomUUID(),
          input.orderId,
          input.channel,
          attempts.rows[0]?.next_attempt ?? 1,
          input.providerOrderId,
          JSON.stringify({
            paymentUrl: input.paymentUrl,
            qrCodePayload: input.qrCodePayload,
          }),
          input.expiresAt,
          now,
        ],
      )
      await client.query(
        `UPDATE changfu.subscription_orders
            SET status = 'PAYING', payment_channel = $3, provider_order_id = $4,
                payment_started_at = $5::timestamptz, updated_at = $5::timestamptz
          WHERE order_id = $1::uuid AND user_id = $2::bigint`,
        [input.orderId, input.userId, input.channel, input.providerOrderId, now],
      )
      return this.getOrderWith(client, input.userId, input.orderId)
    })
  }

  async applyPaidOrder(input: {
    channel: 'WECHAT' | 'ALIPAY' | 'DOUYIN'
    providerEventId: string
    providerOrderId: string
    providerTransactionId: string
    businessOrderNo: string
    amountMinor: number
    currency: string
    rawBodyHash: string
    occurredAt: Date
    metadata?: Record<string, unknown>
    now?: Date
  }): Promise<{ duplicate: boolean; orderId: string }> {
    const now = input.now ?? new Date()
    return this.transaction(async client => {
      const existingEvent = await client.query<{ order_id: string | null }>(
        `SELECT order_id
           FROM changfu.payment_webhook_events
          WHERE channel = $1 AND provider_event_id = $2`,
        [input.channel, input.providerEventId],
      )
      if (existingEvent.rows[0]?.order_id) {
        return { duplicate: true, orderId: existingEvent.rows[0].order_id }
      }
      const result = await client.query<{
        order_id: string
        user_id: string
        subscription_id: string | null
        order_type: SubscriptionOrderType
        plan_version_id: string
        billing_period: BillingPeriod
        duration_months: number
        currency: string
        payable_amount_minor: number
        payment_channel: string | null
        provider_order_id: string | null
        quote_expires_at: Date
        status: string
      }>(
        `SELECT order_id, user_id, subscription_id, order_type, plan_version_id,
                billing_period, duration_months, currency, payable_amount_minor,
                payment_channel, provider_order_id, quote_expires_at, status
           FROM changfu.subscription_orders
          WHERE business_order_no = $1
          FOR UPDATE`,
        [input.businessOrderNo],
      )
      const order = result.rows[0]
      if (!order) throw new SubscriptionRepositoryError('ORDER_NOT_FOUND')
      if (
        order.currency !== input.currency
        || order.payable_amount_minor !== input.amountMinor
        || order.payment_channel !== input.channel
        || order.provider_order_id !== input.providerOrderId
        || input.occurredAt.getTime() > order.quote_expires_at.getTime()
      ) throw new SubscriptionRepositoryError('PAYMENT_AMOUNT_MISMATCH')
      if (order.status === 'PAID') return { duplicate: true, orderId: order.order_id }
      if (order.status !== 'PAYING') throw new SubscriptionRepositoryError('ORDER_NOT_PAYING')

      await client.query(
        `INSERT INTO changfu.payment_webhook_events (
           webhook_event_id, channel, provider_event_id, provider_transaction_id,
           order_id, raw_body_hash, signature_valid, merchant_valid, occurred_at,
           received_at, processed_at, processing_status, metadata
         ) VALUES (
           $1::uuid, $2, $3, $4, $5::uuid, $6, true, true, $7::timestamptz,
           $8::timestamptz, $8::timestamptz, 'PROCESSED', $9::jsonb
         )`,
        [
          randomUUID(),
          input.channel,
          input.providerEventId,
          input.providerTransactionId,
          order.order_id,
          input.rawBodyHash,
          input.occurredAt,
          now,
          JSON.stringify(input.metadata ?? {}),
        ],
      )
      await client.query(
        `UPDATE changfu.subscription_orders
            SET status = 'PAID', provider_order_id = $2,
                provider_transaction_id = $3, paid_at = $4::timestamptz,
                updated_at = $4::timestamptz
          WHERE order_id = $1::uuid`,
        [order.order_id, input.providerOrderId, input.providerTransactionId, now],
      )
      const subscriptionId = await this.activateOrder(client, order, now)
      await client.query(
        `UPDATE changfu.payment_attempts
            SET status = 'SUCCEEDED', updated_at = $2::timestamptz
          WHERE order_id = $1::uuid AND status = 'PENDING'`,
        [order.order_id, now],
      )
      await client.query(
        `UPDATE changfu.subscription_orders
            SET subscription_id = $2::uuid
          WHERE order_id = $1::uuid`,
        [order.order_id, subscriptionId],
      )
      return { duplicate: false, orderId: order.order_id }
    })
  }

  async scheduleChange(input: {
    userId: string
    planVersionId: string
    billingPeriod: BillingPeriod
    retainedProviderIds: string[]
    expectedVersion: number
    now?: Date
  }): Promise<unknown> {
    const now = input.now ?? new Date()
    return this.transaction(async client => {
      const current = await this.getSubscriptionRow(client, input.userId, true)
      if (!current || !this.rowIsEffective(current, now)) {
        throw new SubscriptionRepositoryError('SUBSCRIPTION_INACTIVE')
      }
      if (Number(current.version) !== input.expectedVersion) {
        throw new SubscriptionRepositoryError('SUBSCRIPTION_VERSION_CONFLICT')
      }
      const currentPlan = await this.plan(client, current.plan_version_id)
      const targetPlan = await this.plan(client, input.planVersionId, true)
      const boundProviderIds = await this.boundProviderIds(client, current.subscription_id)
      validateScheduledChange({
        currentPlan,
        targetPlan,
        targetBillingPeriod: input.billingPeriod,
        currentBillingPeriod: current.billing_period,
        retainedProviderIds: input.retainedProviderIds,
        boundProviderIds,
      })
      await client.query(
        `UPDATE changfu.user_subscriptions
            SET pending_plan_version_id = $3::uuid,
                pending_billing_period = $4,
                pending_effective_at = expires_at,
                version = version + 1,
                updated_at = $5::timestamptz
          WHERE subscription_id = $1::uuid AND user_id = $2::bigint`,
        [current.subscription_id, input.userId, targetPlan.planVersionId, input.billingPeriod, now],
      )
      await client.query(
        `DELETE FROM changfu.subscription_pending_provider_selections
          WHERE subscription_id = $1::uuid`,
        [current.subscription_id],
      )
      for (const [index, providerId] of input.retainedProviderIds.entries()) {
        await client.query(
          `INSERT INTO changfu.subscription_pending_provider_selections (
             subscription_id, provider_id, slot_ordinal
           ) VALUES ($1::uuid, $2, $3)`,
          [current.subscription_id, providerId, index + 1],
        )
      }
      await client.query(
        `INSERT INTO changfu.subscription_events (
           subscription_event_id, subscription_id, user_id, event_type,
           previous_plan_version_id, next_plan_version_id, occurred_at
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'CHANGE_SCHEDULED', $4::uuid, $5::uuid, $6)`,
        [
          randomUUID(),
          current.subscription_id,
          input.userId,
          current.plan_version_id,
          targetPlan.planVersionId,
          now,
        ],
      )
      return this.getCurrentWith(client, input.userId, now)
    })
  }

  async bindSlot(input: {
    userId: string
    slotId: string
    providerId: string
    expectedVersion: number
    now?: Date
  }): Promise<unknown> {
    const now = input.now ?? new Date()
    return this.transaction(async client => {
      await this.assertProvidersAvailable(client, [input.providerId])
      const result = await client.query<{
        subscription_id: string
        provider_id: string | null
        status: 'ACTIVE' | 'FROZEN' | 'EMPTY'
        next_rebind_at: Date | null
        version: string
      }>(
        `SELECT subscription_id, provider_id, status, next_rebind_at, version
           FROM changfu.subscription_broker_slots
          WHERE slot_id = $1::uuid AND user_id = $2::bigint
          FOR UPDATE`,
        [input.slotId, input.userId],
      )
      const slot = result.rows[0]
      if (!slot) throw new SubscriptionRepositoryError('BROKER_SLOT_NOT_FOUND')
      if (Number(slot.version) !== input.expectedVersion) {
        throw new SubscriptionRepositoryError('BROKER_SLOT_VERSION_CONFLICT')
      }
      const current = await this.getSubscriptionRow(client, input.userId, true)
      if (!current || !this.rowIsEffective(current, now)) {
        throw new SubscriptionRepositoryError('SUBSCRIPTION_INACTIVE')
      }
      if (
        slot.provider_id
        && (!slot.next_rebind_at || slot.next_rebind_at.getTime() > now.getTime())
      ) throw new SubscriptionRepositoryError('BROKER_SLOT_REBIND_LOCKED')
      const duplicate = await client.query(
        `SELECT 1
           FROM changfu.subscription_broker_slots
          WHERE user_id = $1::bigint AND provider_id = $2
            AND slot_id <> $3::uuid AND status IN ('ACTIVE', 'FROZEN')`,
        [input.userId, input.providerId, input.slotId],
      )
      if (duplicate.rowCount) throw new SubscriptionRepositoryError('PROVIDER_ALREADY_BOUND')

      if (slot.provider_id) {
        await client.query(
          `UPDATE changfu.provider_research_pools
              SET status = 'FROZEN', frozen_reason = 'PROVIDER_REBOUND', updated_at = $3
            WHERE user_id = $1::bigint AND provider_id = $2`,
          [input.userId, slot.provider_id, now],
        )
      }
      await client.query(
        `INSERT INTO changfu.provider_research_pools (
           user_id, provider_id, version, status, updated_at
         ) VALUES ($1::bigint, $2, 1, 'ACTIVE', $3)
         ON CONFLICT (user_id, provider_id) DO UPDATE
           SET status = 'ACTIVE', frozen_reason = NULL, updated_at = EXCLUDED.updated_at`,
        [input.userId, input.providerId, now],
      )
      await client.query(
        `UPDATE changfu.subscription_broker_slots
            SET provider_id = $3, status = 'ACTIVE', bound_at = $4,
                next_rebind_at = $5, version = version + 1, updated_at = $4
          WHERE slot_id = $1::uuid AND user_id = $2::bigint`,
        [input.slotId, input.userId, input.providerId, now, addCalendarMonths(now, 1)],
      )
      await client.query(
        `INSERT INTO changfu.subscription_broker_binding_history (
           binding_event_id, subscription_id, user_id, slot_id,
           previous_provider_id, next_provider_id, event_type, occurred_at
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6, $7, $8)`,
        [
          randomUUID(),
          slot.subscription_id,
          input.userId,
          input.slotId,
          slot.provider_id,
          input.providerId,
          slot.provider_id ? 'REBOUND' : 'BOUND',
          now,
        ],
      )
      return this.getCurrentWith(client, input.userId, now)
    })
  }

  private async activateOrder(
    client: PoolClient,
    order: {
      order_id: string
      user_id: string
      subscription_id: string | null
      order_type: SubscriptionOrderType
      plan_version_id: string
      billing_period: BillingPeriod
    },
    now: Date,
  ): Promise<string> {
    const plan = await this.plan(client, order.plan_version_id)
    await this.materializeDueChange(client, order.user_id, now)
    const current = await this.getSubscriptionRow(client, order.user_id, true)
    if (
      order.order_type !== 'NEW'
      && current
      && current.plan_version_id !== order.plan_version_id
      && order.order_type === 'RENEW'
    ) throw new SubscriptionRepositoryError('ORDER_PLAN_CHANGED_BEFORE_PAYMENT')
    const subscriptionId = current?.subscription_id ?? randomUUID()
    const base = order.order_type === 'RENEW' && current
      ? renewalStart(current.expires_at, now)
      : now
    const expiresAt = subscriptionExpiry(base, order.billing_period)
    if (current) {
      const startsAt = order.order_type === 'RENEW' ? current.starts_at : now
      const purchasedAt = order.order_type === 'RENEW' ? current.purchased_at : now
      await client.query(
        `UPDATE changfu.user_subscriptions
            SET plan_version_id = $3::uuid, billing_period = $4, status = 'ACTIVE',
                version = version + 1, purchased_at = $5, starts_at = $6,
                current_period_start = $7, expires_at = $8,
                pending_plan_version_id = NULL, pending_billing_period = NULL,
                pending_effective_at = NULL, updated_at = $5
          WHERE subscription_id = $1::uuid AND user_id = $2::bigint`,
        [
          subscriptionId,
          order.user_id,
          plan.planVersionId,
          order.billing_period,
          now,
          startsAt,
          base,
          expiresAt,
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
           created_at, updated_at
         ) VALUES (
           $1::uuid, $2::bigint, $3::uuid, $4, 'ACTIVE',
           $5, $5, $5, $6, $5, $5
         )`,
        [subscriptionId, order.user_id, plan.planVersionId, order.billing_period, now, expiresAt],
      )
    }
    const selections = await client.query<{ provider_id: string; slot_ordinal: number }>(
      `SELECT provider_id, slot_ordinal
         FROM changfu.subscription_order_provider_selections
        WHERE order_id = $1::uuid
        ORDER BY slot_ordinal`,
      [order.order_id],
    )
    if (order.order_type === 'NEW' && current) {
      await client.query(
        `UPDATE changfu.provider_research_pools
            SET status = 'FROZEN', frozen_reason = 'SUBSCRIPTION_REPLACED', updated_at = $2
          WHERE user_id = $1::bigint AND status = 'ACTIVE'`,
        [order.user_id, now],
      )
      await client.query(
        `UPDATE changfu.subscription_broker_slots
            SET provider_id = NULL, status = 'EMPTY', bound_at = NULL,
                next_rebind_at = NULL, version = version + 1, updated_at = $2
          WHERE user_id = $1::bigint`,
        [order.user_id, now],
      )
    }
    await this.materializeSlots(
      client,
      subscriptionId,
      order.user_id,
      plan.brokerSlotLimit,
      selections.rows,
      now,
    )
    await this.applyPlanCapacity(
      client,
      order.user_id,
      selections.rows.map(item => item.provider_id),
      plan.poolCapacityPerProvider,
      now,
    )
    await client.query(
      `INSERT INTO changfu.subscription_events (
         subscription_event_id, subscription_id, user_id, event_type, order_id,
         previous_plan_version_id, next_plan_version_id, occurred_at
       ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5::uuid, $6::uuid, $7::uuid, $8)`,
      [
        randomUUID(),
        subscriptionId,
        order.user_id,
        order.order_type === 'NEW'
          ? (current ? 'RESTORED' : 'PURCHASED')
          : order.order_type === 'RENEW' ? 'RENEWED' : 'UPGRADED',
        order.order_id,
        current?.plan_version_id ?? null,
        plan.planVersionId,
        now,
      ],
    )
    return subscriptionId
  }

  private async materializeSlots(
    client: PoolClient,
    subscriptionId: string,
    userId: string,
    slotLimit: number,
    selections: Array<{ provider_id: string; slot_ordinal: number }>,
    now: Date,
  ): Promise<void> {
    const byOrdinal = new Map(selections.map(item => [item.slot_ordinal, item.provider_id]))
    for (let ordinal = 1; ordinal <= slotLimit; ordinal += 1) {
      const providerId = byOrdinal.get(ordinal) ?? null
      await client.query(
        `INSERT INTO changfu.subscription_broker_slots (
           slot_id, subscription_id, user_id, slot_ordinal, provider_id, status,
           bound_at, next_rebind_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::bigint, $4, $5,
           CASE WHEN $5::varchar IS NULL THEN 'EMPTY' ELSE 'ACTIVE' END,
           CASE WHEN $5::varchar IS NULL THEN NULL ELSE $6::timestamptz END,
           CASE WHEN $5::varchar IS NULL THEN NULL ELSE $7::timestamptz END,
           $6::timestamptz
         )
         ON CONFLICT (user_id, slot_ordinal) DO UPDATE SET
           subscription_id = EXCLUDED.subscription_id,
           provider_id = EXCLUDED.provider_id,
           status = EXCLUDED.status,
           bound_at = CASE
             WHEN changfu.subscription_broker_slots.provider_id = EXCLUDED.provider_id
               THEN changfu.subscription_broker_slots.bound_at
             ELSE EXCLUDED.bound_at
           END,
           next_rebind_at = CASE
             WHEN changfu.subscription_broker_slots.provider_id = EXCLUDED.provider_id
               THEN changfu.subscription_broker_slots.next_rebind_at
             ELSE EXCLUDED.next_rebind_at
           END,
           version = changfu.subscription_broker_slots.version + 1,
           updated_at = EXCLUDED.updated_at`,
        [
          randomUUID(),
          subscriptionId,
          userId,
          ordinal,
          providerId,
          now,
          addCalendarMonths(now, 1),
        ],
      )
      if (providerId) {
        await client.query(
          `INSERT INTO changfu.provider_research_pools (
             user_id, provider_id, version, status, updated_at
           ) VALUES ($1::bigint, $2, 1, 'ACTIVE', $3)
           ON CONFLICT (user_id, provider_id) DO UPDATE
             SET status = 'ACTIVE', frozen_reason = NULL, updated_at = EXCLUDED.updated_at`,
          [userId, providerId, now],
        )
      }
    }
    await client.query(
      `UPDATE changfu.subscription_broker_slots
          SET provider_id = NULL, status = 'EMPTY', bound_at = NULL,
              next_rebind_at = NULL, version = version + 1, updated_at = $3
        WHERE user_id = $1::bigint AND subscription_id = $2::uuid
          AND slot_ordinal > $4`,
      [userId, subscriptionId, now, slotLimit],
    )
  }

  private async applyPlanCapacity(
    client: PoolClient,
    userId: string,
    providerIds: string[],
    capacity: number | null,
    now: Date,
  ): Promise<void> {
    for (const providerId of providerIds) {
      if (capacity === null) {
        await client.query(
          `UPDATE changfu.provider_research_pool_items
              SET status = 'ACTIVE', updated_at = $3
            WHERE user_id = $1::bigint AND provider_id = $2
              AND status = 'FROZEN'`,
          [userId, providerId, now],
        )
      } else {
        await client.query(
          `WITH ranked AS (
             SELECT item_id,
                    row_number() OVER (ORDER BY added_at, item_id) AS item_rank
               FROM changfu.provider_research_pool_items
              WHERE user_id = $1::bigint AND provider_id = $2
                AND status IN ('ACTIVE', 'FROZEN')
           )
           UPDATE changfu.provider_research_pool_items item
              SET status = CASE WHEN ranked.item_rank <= $3 THEN 'ACTIVE' ELSE 'FROZEN' END,
                  updated_at = $4
             FROM ranked
            WHERE item.item_id = ranked.item_id`,
          [userId, providerId, capacity, now],
        )
      }
    }
  }

  private async materializeDueChange(
    client: PoolClient,
    userId: string,
    now: Date,
  ): Promise<void> {
    const current = await this.getSubscriptionRow(client, userId, true)
    if (
      !current?.pending_plan_version_id
      || !current.pending_billing_period
      || !current.pending_effective_at
      || current.pending_effective_at.getTime() > now.getTime()
    ) return
    const targetPlan = await this.plan(client, current.pending_plan_version_id)
    const retained = await client.query<{
      provider_id: string
      slot_ordinal: number
    }>(
      `SELECT provider_id, slot_ordinal
         FROM changfu.subscription_pending_provider_selections
        WHERE subscription_id = $1::uuid
        ORDER BY slot_ordinal`,
      [current.subscription_id],
    )
    const existing = await client.query<{
      provider_id: string
      bound_at: Date
      next_rebind_at: Date
    }>(
      `SELECT provider_id, bound_at, next_rebind_at
         FROM changfu.subscription_broker_slots
        WHERE subscription_id = $1::uuid AND provider_id IS NOT NULL`,
      [current.subscription_id],
    )
    const existingByProvider = new Map(existing.rows.map(row => [row.provider_id, row]))
    await client.query(
      `UPDATE changfu.provider_research_pools
          SET status = 'FROZEN', frozen_reason = 'SUBSCRIPTION_CHANGE', updated_at = $2
        WHERE user_id = $1::bigint`,
      [userId, now],
    )
    await client.query(
      `UPDATE changfu.provider_research_pool_items
          SET status = 'FROZEN', updated_at = $2
        WHERE user_id = $1::bigint AND status = 'ACTIVE'`,
      [userId, now],
    )
    await client.query(
      `UPDATE changfu.subscription_broker_slots
          SET provider_id = NULL, status = 'EMPTY', bound_at = NULL,
              next_rebind_at = NULL, version = version + 1, updated_at = $2
        WHERE user_id = $1::bigint`,
      [userId, now],
    )
    for (const selection of retained.rows) {
      const prior = existingByProvider.get(selection.provider_id)
      if (!prior) throw new SubscriptionRepositoryError('RETAINED_PROVIDER_NOT_BOUND')
      await client.query(
        `UPDATE changfu.subscription_broker_slots
            SET provider_id = $4, status = 'FROZEN', bound_at = $5,
                next_rebind_at = $6, version = version + 1, updated_at = $7
          WHERE subscription_id = $1::uuid AND user_id = $2::bigint
            AND slot_ordinal = $3`,
        [
          current.subscription_id,
          userId,
          selection.slot_ordinal,
          selection.provider_id,
          prior.bound_at,
          prior.next_rebind_at,
          now,
        ],
      )
    }
    await client.query(
      `UPDATE changfu.user_subscriptions
          SET plan_version_id = pending_plan_version_id,
              billing_period = pending_billing_period,
              status = 'FROZEN', version = version + 1,
              pending_plan_version_id = NULL, pending_billing_period = NULL,
              pending_effective_at = NULL, updated_at = $3
        WHERE subscription_id = $1::uuid AND user_id = $2::bigint`,
      [current.subscription_id, userId, now],
    )
    await client.query(
      `DELETE FROM changfu.subscription_pending_provider_selections
        WHERE subscription_id = $1::uuid`,
      [current.subscription_id],
    )
    await client.query(
      `INSERT INTO changfu.subscription_events (
         subscription_event_id, subscription_id, user_id, event_type,
         previous_plan_version_id, next_plan_version_id, occurred_at
       ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'DOWNGRADED', $4::uuid, $5::uuid, $6)`,
      [
        randomUUID(),
        current.subscription_id,
        userId,
        current.plan_version_id,
        targetPlan.planVersionId,
        now,
      ],
    )
  }

  private async getSubscriptionRow(
    queryable: Queryable,
    userId: string,
    lock: boolean,
  ): Promise<SubscriptionRow | null> {
    const result = await queryable.query(
      `SELECT s.subscription_id, s.user_id, s.plan_version_id,
              p.plan_code, p.display_name AS plan_name, s.billing_period,
              s.status, s.version, s.purchased_at, s.starts_at,
              s.current_period_start, s.expires_at, s.pending_plan_version_id,
              pending.plan_code AS pending_plan_code, s.pending_billing_period,
              s.pending_effective_at
         FROM changfu.user_subscriptions s
         JOIN changfu.subscription_plan_versions p
           ON p.plan_version_id = s.plan_version_id
         LEFT JOIN changfu.subscription_plan_versions pending
           ON pending.plan_version_id = s.pending_plan_version_id
        WHERE s.user_id = $1::bigint AND s.status IN ('ACTIVE', 'FROZEN')
        ORDER BY s.updated_at DESC
        LIMIT 1${lock ? ' FOR UPDATE OF s' : ''}`,
      [userId],
    )
    return result.rows[0] as SubscriptionRow | undefined ?? null
  }

  private async getCurrentWith(
    queryable: Queryable,
    userId: string,
    now: Date,
  ): Promise<unknown | null> {
    const row = await this.getSubscriptionRow(queryable, userId, false)
    return row ? this.serializeSubscription(queryable, row, now) : null
  }

  private async serializeSubscription(
    queryable: Queryable,
    row: SubscriptionRow,
    now: Date,
  ): Promise<unknown> {
    const slots = await queryable.query(
      `SELECT slot_id AS "slotId", slot_ordinal AS "slotOrdinal",
              provider_id AS "providerId", status, bound_at AS "boundAt",
              next_rebind_at AS "nextRebindAt", version
         FROM changfu.subscription_broker_slots
        WHERE subscription_id = $1::uuid
        ORDER BY slot_ordinal`,
      [row.subscription_id],
    )
    const retained = row.pending_plan_version_id
      ? await queryable.query<{ provider_id: string }>(
        `SELECT provider_id
           FROM changfu.subscription_pending_provider_selections
          WHERE subscription_id = $1::uuid
          ORDER BY slot_ordinal`,
        [row.subscription_id],
      )
      : { rows: [] }
    const effective = this.rowIsEffective(row, now)
    return {
      subscriptionId: row.subscription_id,
      planVersionId: row.plan_version_id,
      planCode: row.plan_code,
      planName: row.plan_name,
      billingPeriod: row.billing_period,
      status: effective ? 'ACTIVE' : 'FROZEN',
      version: Number(row.version),
      purchasedAt: row.purchased_at.toISOString(),
      startsAt: row.starts_at.toISOString(),
      currentPeriodStart: row.current_period_start.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      remainingDays: effective
        ? Math.ceil((row.expires_at.getTime() - now.getTime()) / 86_400_000)
        : 0,
      pendingChange: row.pending_plan_version_id
        ? {
            planVersionId: row.pending_plan_version_id,
            planCode: row.pending_plan_code,
            billingPeriod: row.pending_billing_period,
            effectiveAt: row.pending_effective_at?.toISOString(),
            retainedProviderIds: retained.rows.map(item => item.provider_id),
          }
        : null,
      slots: slots.rows.map(slot => ({
        ...slot,
        version: Number(slot.version),
        boundAt: slot.boundAt instanceof Date ? slot.boundAt.toISOString() : slot.boundAt,
        nextRebindAt: slot.nextRebindAt instanceof Date
          ? slot.nextRebindAt.toISOString()
          : slot.nextRebindAt,
      })),
    }
  }

  private async getOrderWith(
    queryable: Queryable,
    userId: string,
    orderId: string,
  ): Promise<unknown | null> {
    const result = await queryable.query(
      `SELECT order_id AS "orderId", business_order_no AS "businessOrderNo",
              order_type AS "orderType", plan_version_id AS "planVersionId",
              plan_code_snapshot AS "planCode", billing_period AS "billingPeriod",
              currency, original_amount_minor AS "originalAmountMinor",
              credit_amount_minor AS "creditAmountMinor",
              payable_amount_minor AS "payableAmountMinor",
              credit_basis AS "creditBasis", status,
              quote_expires_at AS "quoteExpiresAt", created_at AS "createdAt",
              paid_at AS "paidAt"
         FROM changfu.subscription_orders
        WHERE order_id = $1::uuid AND user_id = $2::bigint`,
      [orderId, userId],
    )
    const order = result.rows[0]
    if (!order) return null
    const selections = await queryable.query(
      `SELECT slot_ordinal AS "slotOrdinal", provider_id AS "providerId"
         FROM changfu.subscription_order_provider_selections
        WHERE order_id = $1::uuid
        ORDER BY slot_ordinal`,
      [orderId],
    )
    const attempt = await queryable.query<{
      channel: string
      response_metadata: { paymentUrl?: string | null; qrCodePayload?: string | null }
      expires_at: Date | null
    }>(
      `SELECT channel, response_metadata, expires_at
         FROM changfu.payment_attempts
        WHERE order_id = $1::uuid
        ORDER BY attempt_number DESC
        LIMIT 1`,
      [orderId],
    )
    const payment = attempt.rows[0]
    return {
      ...order,
      quoteExpiresAt: order.quoteExpiresAt instanceof Date
        ? order.quoteExpiresAt.toISOString()
        : order.quoteExpiresAt,
      createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
      paidAt: order.paidAt instanceof Date ? order.paidAt.toISOString() : order.paidAt,
      providerSelections: selections.rows,
      payment: payment
        ? {
            channel: payment.channel,
            paymentUrl: payment.response_metadata.paymentUrl ?? null,
            qrCodePayload: payment.response_metadata.qrCodePayload ?? null,
            expiresAt: payment.expires_at?.toISOString()
              ?? (order.quoteExpiresAt as Date).toISOString(),
          }
        : null,
    }
  }

  private async boundProviderIds(
    queryable: Queryable,
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

  private async plan(
    queryable: Queryable,
    planVersionId: string,
    requireActive = false,
  ): Promise<SubscriptionPlan> {
    const result = await queryable.query<{
      plan_version_id: string
      plan_code: SubscriptionPlan['planCode']
      version: number
      display_name: string
      status: string
      effective_from: Date
      broker_slot_limit: number
      pool_capacity_per_provider: number | null
      monthly_replacement_limit: number | null
      features: SubscriptionPlan['features']
      prices: unknown
    }>(
      `SELECT p.plan_version_id, p.plan_code, p.version, p.display_name, p.status,
              p.effective_from, p.broker_slot_limit, p.pool_capacity_per_provider,
              p.monthly_replacement_limit, p.features,
              COALESCE(jsonb_agg(jsonb_build_object(
                'priceId', pr.price_id,
                'billingPeriod', pr.billing_period,
                'durationMonths', pr.duration_months,
                'amountMinor', pr.amount_minor
              ) ORDER BY pr.duration_months) FILTER (
                WHERE pr.price_id IS NOT NULL
              ), '[]'::jsonb) AS prices
         FROM changfu.subscription_plan_versions p
         LEFT JOIN changfu.subscription_prices pr
           ON pr.plan_version_id = p.plan_version_id
        WHERE p.plan_version_id = $1::uuid
          AND (
            $2::boolean = false
            OR (
              p.status = 'ACTIVE'
              AND p.effective_from <= now()
              AND (p.effective_until IS NULL OR p.effective_until > now())
            )
          )
        GROUP BY p.plan_version_id`,
      [planVersionId, requireActive],
    )
    const row = result.rows[0]
    if (!row) throw new SubscriptionRepositoryError('PLAN_NOT_FOUND')
    return {
      planVersionId: row.plan_version_id,
      planCode: row.plan_code,
      version: row.version,
      displayName: row.display_name,
      status: 'ACTIVE',
      effectiveFrom: row.effective_from.toISOString(),
      brokerSlotLimit: row.broker_slot_limit,
      poolCapacityPerProvider: row.pool_capacity_per_provider,
      monthlyReplacementLimit: row.monthly_replacement_limit,
      features: row.features,
      prices: Array.isArray(row.prices) ? row.prices as SubscriptionPrice[] : [],
    }
  }

  private price(plan: SubscriptionPlan, period: BillingPeriod): SubscriptionPrice {
    const price = plan.prices.find(item => item.billingPeriod === period)
    if (!price) throw new SubscriptionRepositoryError('PRICE_NOT_FOUND')
    return price
  }

  private async assertProvidersAvailable(
    queryable: Queryable,
    providerIds: string[],
  ): Promise<void> {
    const result = await queryable.query(
      `SELECT provider_id
         FROM changfu.broker_provider_catalog
        WHERE provider_id = ANY($1::varchar[]) AND status = 'ACTIVE'`,
      [providerIds],
    )
    if (result.rowCount !== providerIds.length) {
      throw new SubscriptionRepositoryError('PROVIDER_NOT_AVAILABLE')
    }
  }

  private rowIsEffective(row: SubscriptionRow, now: Date): boolean {
    return isSubscriptionEffective({
      status: row.status,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
    }, now)
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
