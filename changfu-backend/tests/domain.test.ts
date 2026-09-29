import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import {
  calculateEnvelopeContentHash,
  ContextValidationError,
  validateContextEnvelope,
} from '../packages/domain/src/contextEnvelope.js'
import {
  InvalidOrderTransitionError,
  isTerminalOrderIntentState,
  transitionOrderIntent,
} from '../packages/domain/src/orderIntentStateMachine.js'
import {
  acquireTradingLease,
  assertTradingLease,
  TradingLeaseConflictError,
} from '../packages/domain/src/tradingLease.js'
import {
  createSignedOrderIntent,
  verifySignedOrderIntent,
  type OrderSpec,
} from '../packages/domain/src/signedOrderIntent.js'
import {
  safeLogger,
  UnsafeLogPayloadError,
} from '../packages/observability/src/safeLogger.js'
import {
  signAccessToken,
  verifyAccessToken,
} from '../packages/auth/src/accessToken.js'
import {
  addCalendarMonths,
  monthlyAnniversaryWindow,
  renewalStart,
  subscriptionExpiry,
} from '../packages/subscriptions/src/billingClock.js'
import { calculateUpgradeCredit } from '../packages/subscriptions/src/upgradeCredit.js'
import {
  isSubscriptionEffective,
  SubscriptionRuleError,
  transitionSubscriptionOrder,
  validateProviderSelections,
} from '../packages/subscriptions/src/subscriptionService.js'

function envelope(now: Date): Record<string, unknown> {
  const value: Record<string, unknown> = {
    schemaVersion: '2.0',
    requestId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    brokerConnectionId: '33333333-3333-4333-8333-333333333333',
    provider: 'FUTU',
    purpose: 'SINGLE_DECISION',
    capturedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence: 1,
    account: {},
    positions: [],
    marketSessions: [],
    quotes: [],
    minuteBars: [],
    tickerPoints: [],
    orderBooks: [],
    openOrders: [],
    recentDeals: [],
    capabilities: [],
    researchPoolVersion: 1,
    tradingConfigVersion: 1,
    catalogVersion: '2026.09.1',
    tradingSessionId: null,
    requestedSymbols: ['US.TEST'],
    clientPolicyVersion: 'test-v1',
    dataGaps: [],
    deviceSignature: 'test-signature-'.padEnd(80, 'a'),
  }
  value.contentHash = calculateEnvelopeContentHash(value)
  return value
}

test('订阅日历月在月末和闰年按自然月截断', () => {
  assert.equal(
    addCalendarMonths(new Date('2024-01-31T08:15:00.000Z'), 1).toISOString(),
    '2024-02-29T08:15:00.000Z',
  )
  assert.equal(
    addCalendarMonths(new Date('2025-01-31T08:15:00.000Z'), 1).toISOString(),
    '2025-02-28T08:15:00.000Z',
  )
  assert.equal(
    subscriptionExpiry(new Date('2026-09-30T12:00:00.000Z'), 'QUARTERLY').toISOString(),
    '2026-12-30T12:00:00.000Z',
  )
  assert.equal(
    renewalStart(
      new Date('2026-10-19T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
    ).toISOString(),
    '2026-10-19T00:00:00.000Z',
  )
})

test('季度和年度订阅替换额度仍按月度周年窗口重置', () => {
  const window = monthlyAnniversaryWindow(
    new Date('2026-01-31T08:00:00.000Z'),
    new Date('2027-01-31T08:00:00.000Z'),
    new Date('2026-02-28T09:00:00.000Z'),
  )
  assert.equal(window?.start.toISOString(), '2026-02-28T08:00:00.000Z')
  assert.equal(window?.end.toISOString(), '2026-03-31T08:00:00.000Z')
  assert.equal(
    monthlyAnniversaryWindow(
      new Date('2026-01-31T08:00:00.000Z'),
      new Date('2026-02-28T08:00:00.000Z'),
      new Date('2026-02-28T08:00:00.000Z'),
    ),
    null,
  )
})

test('升级剩余价值按秒计算并向下取整到分', () => {
  const credit = calculateUpgradeCredit({
    sourceOrderPaidAmountMinor: 2900,
    sourcePeriodStart: new Date('2026-09-01T00:00:00.000Z'),
    sourcePeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
    calculatedAt: new Date('2026-09-16T00:00:00.000Z'),
  })
  assert.equal(credit.amountMinor, 1450)
  assert.equal(credit.remainingSeconds, 15 * 86400)
})

test('订阅有效性同时校验状态、开始时间和到期时间', () => {
  const now = new Date('2026-09-19T00:00:00.000Z')
  assert.equal(isSubscriptionEffective({
    status: 'ACTIVE',
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  }, now), true)
  assert.equal(isSubscriptionEffective({
    status: 'ACTIVE',
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: now,
  }, now), false)
  assert.equal(isSubscriptionEffective({
    status: 'FROZEN',
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  }, now), false)
})

test('订单状态机和 Provider 槽位选择失败关闭', () => {
  assert.equal(transitionSubscriptionOrder('CREATED', 'PAYING'), 'PAYING')
  assert.equal(transitionSubscriptionOrder('PAYING', 'PAID'), 'PAID')
  assert.throws(
    () => transitionSubscriptionOrder('PAID', 'PAYING'),
    SubscriptionRuleError,
  )
  assert.deepEqual(validateProviderSelections(['FUTU', 'LONGBRIDGE'], 2), [
    'FUTU',
    'LONGBRIDGE',
  ])
  assert.throws(
    () => validateProviderSelections(['FUTU', 'FUTU'], 2),
    SubscriptionRuleError,
  )
})

test('上下文校验只返回可持久化元数据', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const { metadata } = validateContextEnvelope(envelope(now), { now })
  assert.equal(metadata.byteLength > 0, true)
  assert.deepEqual(metadata.requestedSymbols, ['US.TEST'])
  assert.deepEqual(metadata.counts, {
    positions: 0,
    quotes: 0,
    minuteBars: 0,
    tickerPoints: 0,
    orderBooks: 0,
    openOrders: 0,
    recentDeals: 0,
    capabilities: 0,
    dataGaps: 0,
  })
  assert.equal('account' in metadata, false)
  assert.equal('quotes' in metadata, false)
})

test('研究上下文只允许套餐内标的和受控策略', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const valid = envelope(now)
  valid.research = {
    entitlementStatus: 'active',
    planName: '专业版',
    poolLimit: 3,
    poolSymbols: ['US.TEST', 'US.SECOND'],
    conversationSymbols: ['US.TEST'],
  }
  valid.capabilities = [
    {
      id: 'quantitative',
      kind: 'skill',
      title: '量化研究',
      promptVersion: 'research-quantitative-v1',
      modelProfile: 'deep',
      toolPolicyVersion: 'research-readonly-v1',
    },
    {
      id: 'sellPut',
      kind: 'skill',
      title: 'SELL PUT 期权研究',
      promptVersion: 'top30-mega-cap-csp-v3',
      modelProfile: 'risk',
      toolPolicyVersion: 'research-readonly-v1',
    },
  ]
  valid.contentHash = calculateEnvelopeContentHash(valid)
  const { envelope: parsed } = validateContextEnvelope(valid, { now })
  assert.deepEqual(parsed.research?.conversationSymbols, ['US.TEST'])

  const flagship = structuredClone(valid)
  const flagshipResearch = flagship.research as Record<string, unknown>
  flagshipResearch.poolLimit = 10_000
  flagship.contentHash = calculateEnvelopeContentHash(flagship)
  assert.equal(
    validateContextEnvelope(flagship, { now }).envelope.research?.poolLimit,
    10_000,
  )

  const outsidePool = structuredClone(valid)
  const research = outsidePool.research as Record<string, unknown>
  research.conversationSymbols = ['US.OUTSIDE']
  outsidePool.contentHash = calculateEnvelopeContentHash(outsidePool)
  assert.throws(
    () => validateContextEnvelope(outsidePool, { now }),
    (error: unknown) => error instanceof ContextValidationError
      && error.message.includes('必须来自标的池'),
  )

  const mismatchedSkill = structuredClone(valid)
  const mismatchedCapabilities = mismatchedSkill.capabilities as Array<Record<string, unknown>>
  mismatchedCapabilities[0]!.promptVersion = 'research-sell-put-v1'
  mismatchedSkill.contentHash = calculateEnvelopeContentHash(mismatchedSkill)
  assert.throws(
    () => validateContextEnvelope(mismatchedSkill, { now }),
    (error: unknown) => error instanceof ContextValidationError
      && error.message.includes('能力配置非法'),
  )
})

test('全局对话允许空能力且拒绝客户端伪造未注册能力', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const globalChat = envelope(now)
  const parsed = validateContextEnvelope(globalChat, { now }).envelope
  assert.deepEqual(parsed.capabilities, [])

  const forged = envelope(now)
  forged.capabilities = [{
    id: 'unknown-agent',
    kind: 'agent',
    title: '未知智能体',
    promptVersion: null,
    modelProfile: null,
    toolPolicyVersion: null,
  }]
  forged.contentHash = calculateEnvelopeContentHash(forged)
  assert.throws(
    () => validateContextEnvelope(forged, { now }),
    (error: unknown) => error instanceof ContextValidationError
      && error.message.includes('能力未注册'),
  )
})

test('决策上下文校验证据目录和分级数据缺口', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const valid = envelope(now)
  valid.decisionContext = {
    strategyRequirements: {},
    evidenceCatalog: [{
      id: 'QUOTE_US_TEST',
      kind: 'QUOTE',
      summary: '目标标的报价有效',
      sourceAt: now.toISOString(),
    }],
    trendContext: [],
    positionExposure: [],
    accountRisk: {},
    ordersKnowledge: {},
    dataWindow: [],
    extendedSession: [],
    gapCatalog: [{
      code: 'NEWS_NOT_CONNECTED',
      severity: 'INFORMATIONAL',
      summary: '新闻未接入',
      sourceSupport: 'notConnected',
    }],
    temporalBoundary: {},
    outputContract: {},
  }
  valid.contentHash = calculateEnvelopeContentHash(valid)
  const parsed = validateContextEnvelope(valid, { now }).envelope
  assert.equal(parsed.decisionContext?.evidenceCatalog.length, 1)

  const invalid = structuredClone(valid)
  const context = invalid.decisionContext as Record<string, unknown>
  const gaps = context.gapCatalog as Array<Record<string, unknown>>
  gaps[0]!.severity = 'OPTIONAL'
  invalid.contentHash = calculateEnvelopeContentHash(invalid)
  assert.throws(
    () => validateContextEnvelope(invalid, { now }),
    (error: unknown) => error instanceof ContextValidationError
      && error.message.includes('缺口目录非法'),
  )
})

test('过期、超长有效期和内容篡改均被阻断', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const expired = envelope(now)
  expired.expiresAt = new Date(now.getTime() - 1).toISOString()
  expired.contentHash = calculateEnvelopeContentHash(expired)
  assert.throws(
    () => validateContextEnvelope(expired, { now }),
    (error: unknown) => error instanceof ContextValidationError && error.code === 'CONTEXT_EXPIRED',
  )

  const excessiveTtl = envelope(now)
  excessiveTtl.expiresAt = new Date(now.getTime() + 60_001).toISOString()
  excessiveTtl.contentHash = calculateEnvelopeContentHash(excessiveTtl)
  assert.throws(
    () => validateContextEnvelope(excessiveTtl, { now }),
    (error: unknown) => error instanceof ContextValidationError && error.code === 'CONTEXT_TTL_INVALID',
  )

  const tampered = envelope(now)
  tampered.sequence = 2
  assert.throws(
    () => validateContextEnvelope(tampered, { now }),
    (error: unknown) => error instanceof ContextValidationError && error.code === 'CONTEXT_HASH_MISMATCH',
  )

  const unknownField = envelope(now)
  unknownField.rawPrompt = '不得进入协议'
  unknownField.contentHash = calculateEnvelopeContentHash(unknownField)
  assert.throws(
    () => validateContextEnvelope(unknownField, { now }),
    (error: unknown) => error instanceof ContextValidationError && error.code === 'CONTEXT_SCHEMA_INVALID',
  )

  assert.throws(
    () => validateContextEnvelope(envelope(now), { now, byteLength: 2 * 1024 * 1024 + 1 }),
    (error: unknown) => error instanceof ContextValidationError && error.code === 'CONTEXT_TOO_LARGE',
  )
})

test('订单状态机允许正常成交并拒绝终态回退', () => {
  let state = transitionOrderIntent('PENDING_CONFIRMATION', 'CLAIM')
  state = transitionOrderIntent(state, 'BEGIN_SUBMIT')
  state = transitionOrderIntent(state, 'ACKNOWLEDGE')
  state = transitionOrderIntent(state, 'PARTIAL_FILL')
  state = transitionOrderIntent(state, 'FILL')
  assert.equal(state, 'FILLED')
  assert.equal(isTerminalOrderIntentState(state), true)
  assert.throws(
    () => transitionOrderIntent(state, 'FAIL'),
    InvalidOrderTransitionError,
  )
})

test('交易租约允许同设备续期但阻断第二设备', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const first = acquireTradingLease(null, {
    userId: 'user-1',
    brokerConnectionId: 'broker-1',
    deviceId: 'device-1',
  }, now)
  const renewed = acquireTradingLease(first, {
    userId: 'user-1',
    brokerConnectionId: 'broker-1',
    deviceId: 'device-1',
  }, new Date(now.getTime() + 30_000))
  assert.equal(renewed.leaseId, first.leaseId)
  assert.equal(renewed.version, 2)
  assertTradingLease(renewed, {
    userId: 'user-1',
    brokerConnectionId: 'broker-1',
    deviceId: 'device-1',
  }, new Date(now.getTime() + 31_000))
  assert.throws(
    () => acquireTradingLease(renewed, {
      userId: 'user-1',
      brokerConnectionId: 'broker-1',
      deviceId: 'device-2',
    }, new Date(now.getTime() + 31_000)),
    TradingLeaseConflictError,
  )
})

test('安全日志拒绝上下文和令牌字段', () => {
  assert.throws(
    () => safeLogger.info('unsafe', { nested: { context: { quote: 1 } } }),
    UnsafeLogPayloadError,
  )
  assert.throws(
    () => safeLogger.error('unsafe', { authorization: 'Bearer secret' }),
    UnsafeLogPayloadError,
  )
  for (const fields of [
    { arkApiKey: 'secret' },
    { accessPrivateKeyPem: 'secret' },
    { database_url: 'postgresql://secret' },
    { internalToken: 'secret' },
    { rawModelResponse: '{"secret":true}' },
  ]) {
    assert.throws(
      () => safeLogger.warn('unsafe', fields),
      UnsafeLogPayloadError,
    )
  }
})

test('订单意图签名绑定用户、设备、账户、上下文和有效期', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const order: OrderSpec = {
    broker: 'FUTU',
    environment: 'SIMULATE',
    market: 'US',
    symbol: 'US.AAPL',
    side: 'BUY',
    positionEffect: 'OPEN_LONG',
    orderType: 'MARKETABLE_LIMIT',
    tradingSession: 'RTH',
    timeInForce: 'DAY',
    quantity: '10',
    limitPrice: '225.01',
    currency: 'USD',
    maxSlippageBps: 15,
  }
  const intent = createSignedOrderIntent({
    userId: '42',
    deviceId: '22222222-2222-4222-8222-222222222222',
    brokerConnectionId: '33333333-3333-4333-8333-333333333333',
    provider: 'FUTU',
    accountIdHash: 'a'.repeat(64),
    contextHash: 'b'.repeat(64),
    strategyVersion: 'changfu-futu-v1',
    sessionId: null,
    poolVersion: 1,
    configVersion: 1,
    riskPolicyVersion: 'risk-v1',
    executionMode: 'MANUAL_CONFIRM',
    clientRevalidation: {
      quoteMaxAgeMs: 5_000,
      accountMaxAgeMs: 10_000,
      mustCheckOpenOrders: true,
    },
    order,
    sourceValidUntil: new Date(now.getTime() + 120_000),
    keyId: 'test-key',
    privateKeyPem: privateKey,
    now,
  })

  assert.equal(intent.expiresAt, new Date(now.getTime() + 60_000).toISOString())
  assert.equal(verifySignedOrderIntent(intent, publicKey, {
    userId: intent.userId,
    deviceId: intent.deviceId,
    brokerConnectionId: intent.brokerConnectionId,
    accountIdHash: intent.accountIdHash,
    now,
  }), true)
  assert.equal(verifySignedOrderIntent(intent, publicKey, {
    userId: intent.userId,
    deviceId: 'different-device',
    brokerConnectionId: intent.brokerConnectionId,
    accountIdHash: intent.accountIdHash,
    now,
  }), false)
  assert.equal(verifySignedOrderIntent(intent, publicKey, {
    userId: intent.userId,
    deviceId: intent.deviceId,
    brokerConnectionId: intent.brokerConnectionId,
    accountIdHash: intent.accountIdHash,
    now: new Date(now.getTime() + 60_001),
  }), false)

  assert.throws(() => createSignedOrderIntent({
    userId: intent.userId,
    deviceId: intent.deviceId,
    brokerConnectionId: intent.brokerConnectionId,
    provider: intent.provider,
    accountIdHash: intent.accountIdHash,
    contextHash: intent.contextHash,
    strategyVersion: intent.strategyVersion,
    sessionId: intent.sessionId,
    poolVersion: intent.poolVersion,
    configVersion: intent.configVersion,
    riskPolicyVersion: intent.riskPolicyVersion,
    executionMode: intent.executionMode,
    clientRevalidation: intent.clientRevalidation,
    order: { ...order, maxSlippageBps: 16 },
    sourceValidUntil: new Date(now.getTime() + 60_000),
    keyId: 'test-key',
    privateKeyPem: privateKey,
    now,
  }))
})

test('桌面访问令牌绑定设备并使用 EdDSA 验签', () => {
  const now = new Date('2026-09-17T02:00:00.000Z')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = signAccessToken({
    userId: '42',
    deviceId: '22222222-2222-4222-8222-222222222222',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'access-key-1',
    issuer: 'changfu-gateway',
    audience: 'changfu-desktop',
    now,
  })
  const claims = verifyAccessToken(signed.token, {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    issuer: 'changfu-gateway',
    audience: 'changfu-desktop',
    now,
  })
  assert.equal(claims.sub, '42')
  assert.equal(claims.device_id, '22222222-2222-4222-8222-222222222222')
  assert.equal(signed.expiresAt.toISOString(), '2026-09-17T02:15:00.000Z')
})
