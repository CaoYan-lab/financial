import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
  loadSubscriptionCatalog,
  seedSubscriptionCatalog,
} from '../packages/subscriptions/src/catalog.js'
import {
  PostgresSubscriptionRepository,
  SubscriptionRepositoryError,
} from '../packages/persistence/src/postgresSubscriptionRepository.js'
import { PostgresModelProviderConfigRepository } from '../packages/model-provider/src/postgresModelProviderConfigRepository.js'

const databaseUrl = process.env.CHANGFU_DATABASE_URL
if (!databaseUrl) throw new Error('缺少 CHANGFU_DATABASE_URL')

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  application_name: 'changfu-subscription-integration',
})
const catalogPath = fileURLToPath(
  new URL('../catalog/subscriptions/catalog.v1.json', import.meta.url),
)
const catalog = await loadSubscriptionCatalog(catalogPath)
const repository = new PostgresSubscriptionRepository(pool, catalog)
const modelCredentialKey = Buffer.alloc(32, 9).toString('base64')
const modelProviderRepository = new PostgresModelProviderConfigRepository(
  pool,
  modelCredentialKey,
)
const username = `changfu_subscription_it_${randomUUID().replaceAll('-', '')}`
const userId = await createTestUser()

type OrderView = {
  orderId: string
  businessOrderNo: string
  planCode: string
  originalAmountMinor: number
  creditAmountMinor: number
  payableAmountMinor: number
}

type SubscriptionView = {
  planCode: string
  status: string
  version: number
  startsAt: string
  expiresAt: string
  pendingChange: null | {
    planCode: string
    retainedProviderIds: string[]
  }
  slots: Array<{
    slotId: string
    providerId: string | null
    status: string
    version: number
    nextRebindAt: string | null
  }>
}

const lite = requiredPlan('LITE')
const pro = requiredPlan('PRO')
const flagship = requiredPlan('FLAGSHIP')
const startedAt = new Date('2026-09-19T12:00:00.000Z')

try {
  await seedSubscriptionCatalog(pool, catalog)

  const purchase = await createAndPay({
    orderType: 'NEW',
    planVersionId: pro.planVersionId,
    billingPeriod: 'MONTHLY',
    providerIds: ['FUTU', 'LONGBRIDGE'],
    now: startedAt,
  })
  assert.equal(purchase.order.planCode, 'PRO')
  assert.equal(purchase.paid.duplicate, false)

  const duplicate = await repository.applyPaidOrder(purchase.callback)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.orderId, purchase.order.orderId)

  const active = asSubscription(
    await repository.getCurrent(userId, new Date(startedAt.getTime() + 2_000)),
  )
  assert.equal(active.status, 'ACTIVE')
  assert.equal(active.planCode, 'PRO')
  assert.deepEqual(
    active.slots.filter(slot => slot.providerId).map(slot => slot.providerId),
    ['FUTU', 'LONGBRIDGE'],
  )

  await assert.rejects(
    repository.bindSlot({
      userId,
      slotId: active.slots[0].slotId,
      providerId: 'LONGBRIDGE',
      expectedVersion: active.slots[0].version,
      now: new Date(startedAt.getTime() + 60_000),
    }),
    errorCode('BROKER_SLOT_REBIND_LOCKED'),
  )

  const upgradedAt = new Date('2026-09-24T12:00:00.000Z')
  const upgrade = await createAndPay({
    orderType: 'UPGRADE',
    planVersionId: flagship.planVersionId,
    billingPeriod: 'MONTHLY',
    providerIds: ['FUTU', 'LONGBRIDGE'],
    now: upgradedAt,
  })
  assert.ok(upgrade.order.creditAmountMinor > 0)
  assert.ok(upgrade.order.payableAmountMinor < upgrade.order.originalAmountMinor)

  const upgraded = asSubscription(
    await repository.getCurrent(userId, new Date(upgradedAt.getTime() + 2_000)),
  )
  assert.equal(upgraded.planCode, 'FLAGSHIP')
  assert.equal(upgraded.startsAt, new Date(upgradedAt.getTime() + 1_000).toISOString())

  const changeResults = await Promise.allSettled([
    repository.scheduleChange({
      userId,
      planVersionId: lite.planVersionId,
      billingPeriod: 'MONTHLY',
      retainedProviderIds: ['FUTU'],
      expectedVersion: upgraded.version,
      now: new Date(upgradedAt.getTime() + 60_000),
    }),
    repository.scheduleChange({
      userId,
      planVersionId: lite.planVersionId,
      billingPeriod: 'MONTHLY',
      retainedProviderIds: ['FUTU'],
      expectedVersion: upgraded.version,
      now: new Date(upgradedAt.getTime() + 60_001),
    }),
  ])
  assert.equal(changeResults.filter(result => result.status === 'fulfilled').length, 1)
  const rejectedChange = changeResults.find(result => result.status === 'rejected')
  assert.ok(rejectedChange?.status === 'rejected')
  assert.match(
    String((rejectedChange as PromiseRejectedResult).reason?.code),
    /SUBSCRIPTION_VERSION_CONFLICT/,
  )

  const scheduled = asSubscription(
    await repository.getCurrent(userId, new Date(upgradedAt.getTime() + 120_000)),
  )
  assert.equal(scheduled.pendingChange?.planCode, 'LITE')
  assert.deepEqual(scheduled.pendingChange?.retainedProviderIds, ['FUTU'])

  const afterExpiry = new Date(Date.parse(scheduled.expiresAt) + 1_000)
  const downgraded = asSubscription(await repository.getCurrent(userId, afterExpiry))
  assert.equal(downgraded.status, 'FROZEN')
  assert.equal(downgraded.planCode, 'LITE')
  assert.equal(downgraded.pendingChange, null)
  assert.equal(downgraded.slots[0].providerId, 'FUTU')
  assert.equal(downgraded.slots[0].status, 'FROZEN')
  assert.ok(downgraded.slots.slice(1).every(slot => slot.status === 'EMPTY'))

  const renewedAt = new Date(afterExpiry.getTime() + 1_000)
  await createAndPay({
    orderType: 'RENEW',
    planVersionId: lite.planVersionId,
    billingPeriod: 'MONTHLY',
    providerIds: ['FUTU'],
    now: renewedAt,
  })
  const renewed = asSubscription(
    await repository.getCurrent(userId, new Date(renewedAt.getTime() + 2_000)),
  )
  assert.equal(renewed.status, 'ACTIVE')
  assert.equal(renewed.planCode, 'LITE')
  assert.equal(renewed.startsAt, upgraded.startsAt)
  assert.ok(Date.parse(renewed.expiresAt) > renewedAt.getTime())

  const rebindAt = new Date(Math.max(
    renewedAt.getTime() + 1_000,
    Date.parse(renewed.slots[0].nextRebindAt ?? renewedAt.toISOString()) + 1_000,
  ))
  const rebindResults = await Promise.allSettled([
    repository.bindSlot({
      userId,
      slotId: renewed.slots[0].slotId,
      providerId: 'LONGBRIDGE',
      expectedVersion: renewed.slots[0].version,
      now: rebindAt,
    }),
    repository.bindSlot({
      userId,
      slotId: renewed.slots[0].slotId,
      providerId: 'LONGBRIDGE',
      expectedVersion: renewed.slots[0].version,
      now: new Date(rebindAt.getTime() + 1),
    }),
  ])
  assert.equal(rebindResults.filter(result => result.status === 'fulfilled').length, 1)
  const rejectedRebind = rebindResults.find(result => result.status === 'rejected')
  assert.ok(rejectedRebind?.status === 'rejected')
  assert.match(
    String((rejectedRebind as PromiseRejectedResult).reason?.code),
    /BROKER_SLOT_VERSION_CONFLICT/,
  )

  const rebound = asSubscription(await repository.getCurrent(userId, rebindAt))
  assert.equal(rebound.slots[0].providerId, 'LONGBRIDGE')
  assert.equal(rebound.slots[0].status, 'ACTIVE')

  await setCurrentPlan(flagship.planVersionId)
  const modelConfig = await modelProviderRepository.upsert({
    userId,
    displayName: '集成测试模型',
    protocol: 'OPENAI_RESPONSES',
    endpoint: 'https://api.example.com/v1/responses',
    model: 'integration-model',
    apiKey: 'sk-integration-private',
    enabled: true,
  })
  assert.equal(modelConfig.eligible, true)
  assert.equal(modelConfig.config?.keyLastFour, 'vate')
  const encryptedCredential = await pool.query<{
    api_key_ciphertext: Buffer
  }>(
    `SELECT api_key_ciphertext
       FROM changfu.third_party_model_configs
      WHERE user_id = $1::bigint`,
    [userId],
  )
  assert.notEqual(
    encryptedCredential.rows[0]?.api_key_ciphertext.toString('utf8'),
    'sk-integration-private',
  )
  assert.equal(
    (await modelProviderRepository.getEffective(userId))?.apiKey,
    'sk-integration-private',
  )
  await setCurrentPlan(lite.planVersionId)
  assert.equal(await modelProviderRepository.getEffective(userId), null)
  assert.equal((await modelProviderRepository.get(userId)).config?.keyLastFour, 'vate')

  console.log(
    '通过：订阅生命周期、旗舰第三方模型加密写入、降级回退与并发换绑',
  )
} finally {
  await cleanup()
  await pool.end()
}

function requiredPlan(planCode: 'LITE' | 'PRO' | 'FLAGSHIP') {
  const plan = catalog.plans.find(item => item.planCode === planCode)
  assert.ok(plan)
  return plan
}

async function setCurrentPlan(planVersionId: string): Promise<void> {
  await pool.query(
    `UPDATE changfu.user_subscriptions
        SET plan_version_id = $2::uuid,
            status = 'ACTIVE',
            starts_at = now() - interval '1 minute',
            current_period_start = now() - interval '1 minute',
            expires_at = now() + interval '1 day',
            updated_at = now()
      WHERE user_id = $1::bigint`,
    [userId, planVersionId],
  )
}

async function createAndPay(input: {
  orderType: 'NEW' | 'RENEW' | 'UPGRADE'
  planVersionId: string
  billingPeriod: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
  providerIds: string[]
  now: Date
}) {
  const order = asOrder(await repository.createOrder({
    userId,
    ...input,
    idempotencyKey: randomUUID(),
  }))
  const providerOrderId = `provider-${randomUUID()}`
  await repository.markPaymentPending({
    userId,
    orderId: order.orderId,
    channel: 'WECHAT',
    providerOrderId,
    paymentUrl: null,
    qrCodePayload: `test:${order.orderId}`,
    expiresAt: new Date(input.now.getTime() + 10 * 60_000),
    now: input.now,
  })
  const callback = {
    channel: 'WECHAT' as const,
    providerEventId: `event-${randomUUID()}`,
    providerOrderId,
    providerTransactionId: `transaction-${randomUUID()}`,
    businessOrderNo: order.businessOrderNo,
    amountMinor: order.payableAmountMinor,
    currency: 'CNY',
    rawBodyHash: 'a'.repeat(64),
    occurredAt: new Date(input.now.getTime() + 1_000),
    now: new Date(input.now.getTime() + 1_000),
  }
  const paid = await repository.applyPaidOrder(callback)
  return { order, callback, paid }
}

async function createTestUser(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO public.cloud_users (username, password_hash)
     VALUES ($1, $2)
     RETURNING id`,
    [username, 'integration-test-only'],
  )
  const row = result.rows[0]
  assert.ok(row)
  return row.id
}

async function cleanup(): Promise<void> {
  const userTables = [
    'third_party_model_configs',
    'research_pool_mutation_events',
    'provider_research_pool_items',
    'provider_research_pools',
    'subscription_broker_binding_history',
    'subscription_broker_slots',
    'subscription_events',
  ]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const table of userTables) {
      await client.query(`DELETE FROM changfu.${table} WHERE user_id = $1::bigint`, [userId])
    }
    await client.query(
      `DELETE FROM changfu.subscription_pending_provider_selections
        WHERE subscription_id IN (
          SELECT subscription_id FROM changfu.user_subscriptions WHERE user_id = $1::bigint
        )`,
      [userId],
    )
    for (const table of [
      'payment_webhook_events',
      'payment_attempts',
      'subscription_order_provider_selections',
    ]) {
      await client.query(
        `DELETE FROM changfu.${table}
          WHERE order_id IN (
            SELECT order_id FROM changfu.subscription_orders WHERE user_id = $1::bigint
          )`,
        [userId],
      )
    }
    await client.query('DELETE FROM changfu.subscription_orders WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM changfu.user_subscriptions WHERE user_id = $1::bigint', [userId])
    await client.query('DELETE FROM public.cloud_users WHERE id = $1::bigint', [userId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function asOrder(value: unknown): OrderView {
  assert.ok(value && typeof value === 'object')
  return value as OrderView
}

function asSubscription(value: unknown): SubscriptionView {
  assert.ok(value && typeof value === 'object')
  return value as SubscriptionView
}

function errorCode(code: string): (error: unknown) => boolean {
  return error => error instanceof SubscriptionRepositoryError && error.code === code
}
