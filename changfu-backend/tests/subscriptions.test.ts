import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import type { PostgresSubscriptionRepository } from '../packages/persistence/src/postgresSubscriptionRepository.js'
import {
  loadSubscriptionCatalog,
  publicSubscriptionCatalog,
  seedSubscriptionCatalog,
  SubscriptionCatalogError,
  type SubscriptionCatalog,
} from '../packages/subscriptions/src/catalog.js'
import {
  isSubscriptionEffective,
  planRank,
  SubscriptionRuleError,
  transitionSubscriptionOrder,
  validateOrderType,
  validateProviderSelections,
  validateScheduledChange,
} from '../packages/subscriptions/src/subscriptionService.js'
import { PaymentService } from '../packages/payments/src/paymentService.js'
import {
  PaymentProviderError,
  unavailablePaymentProvider,
  type PayableOrder,
  type PaymentCreation,
  type PaymentProvider,
  type PaymentQuery,
  type VerifiedPaymentWebhook,
} from '../packages/payments/src/paymentProvider.js'
import {
  createWechatPaymentProvider,
  type WechatPayClient,
} from '../packages/payments/src/providers/wechat.js'
import {
  createAlipayPaymentProvider,
  type AlipayClient,
} from '../packages/payments/src/providers/alipay.js'
import {
  createDouyinPaymentProvider,
  type DouyinPayClient,
} from '../packages/payments/src/providers/douyin.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function catalog(): Promise<SubscriptionCatalog> {
  return loadSubscriptionCatalog(resolve(root, 'catalog/subscriptions/catalog.v1.json'))
}

function assertErrorCode(
  operation: () => unknown | Promise<unknown>,
  type: typeof SubscriptionRuleError | typeof PaymentProviderError,
  code: string,
): Promise<void> {
  return assert.rejects(
    async () => operation(),
    error => error instanceof type && error.code === code,
  )
}

test('订阅目录固定三档九价且旗舰容量使用 null 表示不限量', async () => {
  const catalog = await loadSubscriptionCatalog(
    resolve(root, 'catalog/subscriptions/catalog.v1.json'),
  )
  assert.equal(catalog.plans.length, 3)
  assert.equal(catalog.plans.flatMap(plan => plan.prices).length, 9)
  assert.deepEqual(
    catalog.plans.map(plan => [
      plan.planCode,
      plan.brokerSlotLimit,
      plan.poolCapacityPerProvider,
      plan.monthlyReplacementLimit,
    ]),
    [
      ['LITE', 1, 5, 1],
      ['PRO', 2, 15, 15],
      ['FLAGSHIP', 5, null, null],
    ],
  )
  assert.deepEqual(
    catalog.plans.map(plan => plan.prices.map(price => price.amountMinor)),
    [
      [2900, 7900, 29900],
      [9900, 26900, 99900],
      [29900, 79900, 299900],
    ],
  )
  assert.match(catalog.contentHash, /^[a-f0-9]{64}$/)
})

test('未注入官方支付客户端时三渠道明确不可用', async () => {
  const catalog = await loadSubscriptionCatalog(
    resolve(root, 'catalog/subscriptions/catalog.v1.json'),
  )
  const channels = [
    createWechatPaymentProvider(),
    createAlipayPaymentProvider(),
    createDouyinPaymentProvider(),
  ]
  const response = publicSubscriptionCatalog(
    catalog,
    channels.map(provider => ({
      channel: provider.channel,
      displayName: provider.displayName,
      available: provider.available,
      unavailableReason: provider.unavailableReason,
    })),
  )
  assert.deepEqual(response.paymentChannels.map(channel => channel.available), [
    false,
    false,
    false,
  ])
})

test('支付成功只能由验签后的 Provider 回调驱动权益生效', async () => {
  let markedPending = false
  let appliedPaid = false
  const repository = {
    getOrder: async () => ({
      orderId: '11111111-1111-4111-8111-111111111111',
      businessOrderNo: 'CF-TEST',
      planCode: 'LITE',
      billingPeriod: 'MONTHLY',
      currency: 'CNY',
      payableAmountMinor: 2900,
      status: 'CREATED',
      quoteExpiresAt: '2026-09-19T00:15:00.000Z',
    }),
    markPaymentPending: async () => {
      markedPending = true
      return { status: 'PAYING' }
    },
    applyPaidOrder: async () => {
      appliedPaid = true
      return { duplicate: false, orderId: '11111111-1111-4111-8111-111111111111' }
    },
  } as unknown as PostgresSubscriptionRepository
  const provider: PaymentProvider = {
    channel: 'WECHAT',
    displayName: '微信支付',
    available: true,
    unavailableReason: null,
    createPayment: async order => ({
      providerOrderId: 'wx-order',
      paymentUrl: null,
      qrCodePayload: 'weixin://pay/test',
      expiresAt: order.expiresAt,
    }),
    queryPayment: async () => ({
      status: 'PENDING',
      providerTransactionId: null,
      paidAt: null,
    }),
    verifyWebhook: async () => ({
      providerEventId: 'wx-event',
      providerOrderId: 'wx-order',
      providerTransactionId: 'wx-transaction',
      businessOrderNo: 'CF-TEST',
      amountMinor: 2900,
      currency: 'CNY',
      occurredAt: new Date('2026-09-19T00:01:00.000Z'),
      metadata: {},
    }),
    closePayment: async () => undefined,
  }
  const service = new PaymentService(repository, [provider])
  const now = new Date('2026-09-19T00:00:00.000Z')
  await service.startPayment({
    userId: '42',
    orderId: '11111111-1111-4111-8111-111111111111',
    channel: 'WECHAT',
    now,
  })
  assert.equal(markedPending, true)
  assert.equal(appliedPaid, false)

  await service.handleWebhook({
    channel: 'WECHAT',
    rawBody: Buffer.from('signed callback'),
    headers: {},
    now,
  })
  assert.equal(appliedPaid, true)
})

test('订阅目录事务完整写入 Provider、套餐和九个价格', async () => {
  const loaded = await catalog()
  const statements: string[] = []
  const client = {
    query: async (sql: string) => {
      statements.push(sql.trim())
      return { rowCount: 1, rows: [] }
    },
    release: () => statements.push('RELEASE'),
  } as unknown as PoolClient
  const pool = {
    connect: async () => client,
  } as unknown as Pool

  await seedSubscriptionCatalog(pool, loaded)

  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements.at(-2), 'COMMIT')
  assert.equal(statements.at(-1), 'RELEASE')
  assert.equal(
    statements.filter(statement => statement.includes('broker_provider_catalog')).length,
    loaded.providers.length,
  )
  assert.equal(
    statements.filter(statement => (
      statement.startsWith('INSERT INTO changfu.subscription_plan_versions')
    )).length,
    loaded.plans.length,
  )
  assert.equal(
    statements.filter(statement => statement.includes('subscription_prices')).length,
    9,
  )
})

for (const [conflictTable, code] of [
  ['subscription_catalog_releases', 'CATALOG_VERSION_HASH_CONFLICT'],
  ['subscription_plan_versions', 'PLAN_VERSION_CONFLICT'],
  ['subscription_prices', 'PRICE_VERSION_CONFLICT'],
] as const) {
  test(`订阅目录 ${conflictTable} 冲突时回滚`, async () => {
    const loaded = await catalog()
    const statements: string[] = []
    const client = {
      query: async (sql: string) => {
        const normalized = sql.trim()
        statements.push(normalized)
        return {
          rowCount: normalized.includes(conflictTable) ? 0 : 1,
          rows: [],
        }
      },
      release: () => statements.push('RELEASE'),
    } as unknown as PoolClient
    const pool = { connect: async () => client } as unknown as Pool

    await assert.rejects(
      seedSubscriptionCatalog(pool, loaded),
      error => error instanceof SubscriptionCatalogError && error.code === code,
    )
    assert.equal(statements.at(-2), 'ROLLBACK')
    assert.equal(statements.at(-1), 'RELEASE')
  })
}

test('订阅订单状态、有效期和 Provider 选择规则完整', async () => {
  assert.equal(transitionSubscriptionOrder('CREATED', 'PAYING'), 'PAYING')
  assert.equal(transitionSubscriptionOrder('FAILED', 'CLOSED'), 'CLOSED')
  assert.throws(
    () => transitionSubscriptionOrder('PAID', 'PAYING'),
    error => error instanceof SubscriptionRuleError
      && error.code === 'ORDER_TRANSITION_INVALID',
  )

  const now = new Date('2026-09-19T00:00:00.000Z')
  assert.equal(isSubscriptionEffective({
    status: 'ACTIVE',
    startsAt: new Date('2026-09-18T00:00:00.000Z'),
    expiresAt: new Date('2026-09-20T00:00:00.000Z'),
  }, now), true)
  assert.equal(isSubscriptionEffective({
    status: 'FROZEN',
    startsAt: new Date('2026-09-18T00:00:00.000Z'),
    expiresAt: new Date('2026-09-20T00:00:00.000Z'),
  }, now), false)
  assert.equal(isSubscriptionEffective({
    status: 'ACTIVE',
    startsAt: now,
    expiresAt: now,
  }, now), false)

  assert.deepEqual(validateProviderSelections(['FUTU', 'LONGBRIDGE'], 2), [
    'FUTU',
    'LONGBRIDGE',
  ])
  for (const providers of [[], ['FUTU', 'FUTU'], ['bad-provider']]) {
    assert.throws(
      () => validateProviderSelections(providers, 2),
      error => error instanceof SubscriptionRuleError
        && error.code === 'PROVIDER_SELECTION_INVALID',
    )
  }
  assert.deepEqual(
    (['LITE', 'PRO', 'FLAGSHIP'] as const).map(code => planRank(code)),
    [1, 2, 3],
  )
})

test('新购、续费、升级和预约降级规则覆盖全部拒绝分支', async () => {
  const loaded = await catalog()
  const lite = loaded.plans.find(plan => plan.planCode === 'LITE')!
  const pro = loaded.plans.find(plan => plan.planCode === 'PRO')!
  const flagship = loaded.plans.find(plan => plan.planCode === 'FLAGSHIP')!

  validateOrderType({
    orderType: 'NEW',
    targetPlan: lite,
    currentPlan: null,
    currentEffective: false,
  })
  validateOrderType({
    orderType: 'RENEW',
    targetPlan: lite,
    currentPlan: lite,
    currentEffective: true,
  })
  validateOrderType({
    orderType: 'UPGRADE',
    targetPlan: flagship,
    currentPlan: lite,
    currentEffective: true,
  })
  await assertErrorCode(
    () => validateOrderType({
      orderType: 'NEW',
      targetPlan: lite,
      currentPlan: lite,
      currentEffective: true,
    }),
    SubscriptionRuleError,
    'ACTIVE_SUBSCRIPTION_EXISTS',
  )
  await assertErrorCode(
    () => validateOrderType({
      orderType: 'RENEW',
      targetPlan: lite,
      currentPlan: null,
      currentEffective: false,
    }),
    SubscriptionRuleError,
    'SUBSCRIPTION_NOT_FOUND',
  )
  await assertErrorCode(
    () => validateOrderType({
      orderType: 'RENEW',
      targetPlan: pro,
      currentPlan: lite,
      currentEffective: true,
    }),
    SubscriptionRuleError,
    'RENEW_PLAN_MISMATCH',
  )
  for (const current of [null, pro] as const) {
    await assertErrorCode(
      () => validateOrderType({
        orderType: 'UPGRADE',
        targetPlan: lite,
        currentPlan: current,
        currentEffective: current !== null,
      }),
      SubscriptionRuleError,
      'UPGRADE_INVALID',
    )
  }

  validateScheduledChange({
    currentPlan: flagship,
    targetPlan: lite,
    targetBillingPeriod: 'MONTHLY',
    currentBillingPeriod: 'YEARLY',
    retainedProviderIds: ['FUTU'],
    boundProviderIds: ['FUTU', 'LONGBRIDGE'],
  })
  await assertErrorCode(
    () => validateScheduledChange({
      currentPlan: lite,
      targetPlan: lite,
      targetBillingPeriod: 'MONTHLY',
      currentBillingPeriod: 'MONTHLY',
      retainedProviderIds: ['FUTU'],
      boundProviderIds: ['FUTU'],
    }),
    SubscriptionRuleError,
    'SCHEDULED_CHANGE_INVALID',
  )
  await assertErrorCode(
    () => validateScheduledChange({
      currentPlan: pro,
      targetPlan: lite,
      targetBillingPeriod: 'MONTHLY',
      currentBillingPeriod: 'YEARLY',
      retainedProviderIds: ['LONGBRIDGE'],
      boundProviderIds: ['FUTU'],
    }),
    SubscriptionRuleError,
    'RETAINED_PROVIDER_NOT_BOUND',
  )
  await assertErrorCode(
    () => validateScheduledChange({
      currentPlan: flagship,
      targetPlan: pro,
      targetBillingPeriod: 'MONTHLY',
      currentBillingPeriod: 'YEARLY',
      retainedProviderIds: ['FUTU'],
      boundProviderIds: ['FUTU', 'LONGBRIDGE', 'OTHER'],
    }),
    SubscriptionRuleError,
    'RETAINED_PROVIDER_SELECTION_REQUIRED',
  )
})

test('官方支付客户端适配器完整代理并拒绝空回调', async () => {
  const now = new Date('2026-09-19T00:00:00.000Z')
  const order: PayableOrder = {
    orderId: 'order',
    businessOrderNo: 'CF-TEST',
    description: '测试',
    amountMinor: 2900,
    currency: 'CNY',
    expiresAt: now,
  }
  const creation: PaymentCreation = {
    providerOrderId: 'provider-order',
    paymentUrl: 'https://pay.example',
    qrCodePayload: null,
    expiresAt: now,
  }
  const query: PaymentQuery = {
    status: 'PAID',
    providerTransactionId: 'transaction',
    paidAt: now,
  }
  const webhook: VerifiedPaymentWebhook = {
    providerEventId: 'event',
    providerOrderId: 'provider-order',
    providerTransactionId: 'transaction',
    businessOrderNo: 'CF-TEST',
    amountMinor: 2900,
    currency: 'CNY',
    occurredAt: now,
    metadata: {},
  }
  const calls: string[] = []
  const methods = {
    create: async () => {
      calls.push('create')
      return creation
    },
    query: async () => {
      calls.push('query')
      return query
    },
    verify: async () => {
      calls.push('verify')
      return webhook
    },
    close: async () => {
      calls.push('close')
    },
  }
  const providers = [
    createWechatPaymentProvider({
      createNativeOrder: methods.create,
      queryOrder: methods.query,
      verifyAndDecryptWebhook: methods.verify,
      closeOrder: methods.close,
    } satisfies WechatPayClient),
    createAlipayPaymentProvider({
      createPageOrder: methods.create,
      queryOrder: methods.query,
      verifyFormWebhook: methods.verify,
      closeOrder: methods.close,
    } satisfies AlipayClient),
    createDouyinPaymentProvider({
      createOrder: methods.create,
      queryOrder: methods.query,
      verifyWebhookSignature: methods.verify,
      closeOrder: methods.close,
    } satisfies DouyinPayClient),
  ]

  for (const provider of providers) {
    assert.deepEqual(await provider.createPayment(order), creation)
    assert.deepEqual(await provider.queryPayment('provider-order'), query)
    assert.deepEqual(await provider.verifyWebhook(Buffer.from('signed'), {}), webhook)
    await provider.closePayment('provider-order')
    await assert.rejects(
      provider.verifyWebhook(Buffer.alloc(0), {}),
      error => error instanceof PaymentProviderError
        && error.code === `${provider.channel}_WEBHOOK_EMPTY`,
    )
  }
  assert.equal(calls.length, 12)
})

test('不可用支付渠道及支付服务边界返回稳定错误码', async () => {
  const unavailable = unavailablePaymentProvider('WECHAT', '微信支付', 'DISABLED')
  assert.equal(unavailable.available, false)
  for (const operation of [
    () => unavailable.createPayment({} as PayableOrder),
    () => unavailable.queryPayment('order'),
    () => unavailable.verifyWebhook(Buffer.from('x'), {}),
    () => unavailable.closePayment('order'),
  ]) {
    await assert.rejects(
      operation(),
      error => error instanceof PaymentProviderError && error.code === 'DISABLED',
    )
  }

  const baseOrder = {
    orderId: 'order',
    businessOrderNo: 'CF-TEST',
    planCode: 'LITE',
    billingPeriod: 'MONTHLY',
    currency: 'CNY',
    payableAmountMinor: 2900,
    status: 'CREATED',
    quoteExpiresAt: '2026-09-19T00:15:00.000Z',
  }
  const repository = {
    getOrder: async () => baseOrder,
  } as unknown as PostgresSubscriptionRepository
  const availableProvider = {
    channel: 'WECHAT',
    displayName: '微信支付',
    available: true,
    unavailableReason: null,
  } as PaymentProvider

  await assertErrorCode(
    () => new PaymentService(repository, []).startPayment({
      userId: '42',
      orderId: 'order',
      channel: 'WECHAT',
    }),
    PaymentProviderError,
    'PAYMENT_CHANNEL_UNKNOWN',
  )
  await assertErrorCode(
    () => new PaymentService(repository, [unavailable]).startPayment({
      userId: '42',
      orderId: 'order',
      channel: 'WECHAT',
    }),
    PaymentProviderError,
    'DISABLED',
  )
  await assertErrorCode(
    () => new PaymentService({
      getOrder: async () => null,
    } as unknown as PostgresSubscriptionRepository, [availableProvider]).startPayment({
      userId: '42',
      orderId: 'order',
      channel: 'WECHAT',
    }),
    PaymentProviderError,
    'ORDER_NOT_FOUND',
  )
  await assertErrorCode(
    () => new PaymentService({
      getOrder: async () => ({ ...baseOrder, status: 'PAID' }),
    } as unknown as PostgresSubscriptionRepository, [availableProvider]).startPayment({
      userId: '42',
      orderId: 'order',
      channel: 'WECHAT',
    }),
    PaymentProviderError,
    'ORDER_NOT_PAYABLE',
  )
  await assertErrorCode(
    () => new PaymentService(repository, [availableProvider]).startPayment({
      userId: '42',
      orderId: 'order',
      channel: 'WECHAT',
      now: new Date('2026-09-19T00:15:00.000Z'),
    }),
    PaymentProviderError,
    'ORDER_QUOTE_EXPIRED',
  )
  await assertErrorCode(
    () => new PaymentService(repository, [unavailable]).handleWebhook({
      channel: 'WECHAT',
      rawBody: Buffer.from('signed'),
      headers: {},
    }),
    PaymentProviderError,
    'PAYMENT_CHANNEL_UNAVAILABLE',
  )
})
