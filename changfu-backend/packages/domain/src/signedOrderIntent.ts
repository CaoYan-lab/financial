import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'

export type OrderSpec = {
  broker: 'FUTU' | 'LONGBRIDGE'
  environment: 'SIMULATE' | 'REAL'
  market: 'US' | 'HK'
  symbol: string
  side: 'BUY' | 'SELL'
  positionEffect:
    | 'OPEN_LONG'
    | 'ADD_LONG'
    | 'REDUCE_LONG'
    | 'OPEN_SHORT'
    | 'ADD_SHORT'
    | 'COVER_SHORT'
  orderType: 'MARKETABLE_LIMIT'
  tradingSession: 'RTH'
  timeInForce: 'DAY'
  quantity: string
  limitPrice: string
  currency: string
  maxSlippageBps: number
}

export type UnsignedOrderIntent = {
  schemaVersion: '2.0'
  intentId: string
  userId: string
  deviceId: string
  brokerConnectionId: string
  provider: 'FUTU' | 'LONGBRIDGE'
  accountIdHash: string
  contextHash: string
  strategyVersion: string
  sessionId: string | null
  poolVersion: number
  configVersion: number
  riskPolicyVersion: string
  executionMode: 'MANUAL_CONFIRM' | 'AUTO_EXECUTE'
  clientRevalidation: {
    quoteMaxAgeMs: number
    accountMaxAgeMs: number
    mustCheckOpenOrders: true
  }
  order: OrderSpec
  issuedAt: string
  expiresAt: string
  keyId: string
}

export type SignedOrderIntent = UnsignedOrderIntent & {
  signature: string
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function signingPayload(intent: UnsignedOrderIntent): Buffer {
  return Buffer.from(canonicalize(intent), 'utf8')
}

export function createSignedOrderIntent(input: {
  userId: string
  deviceId: string
  brokerConnectionId: string
  provider: 'FUTU' | 'LONGBRIDGE'
  accountIdHash: string
  contextHash: string
  strategyVersion: string
  sessionId: string | null
  poolVersion: number
  configVersion: number
  riskPolicyVersion: string
  executionMode: 'MANUAL_CONFIRM' | 'AUTO_EXECUTE'
  clientRevalidation: {
    quoteMaxAgeMs: number
    accountMaxAgeMs: number
    mustCheckOpenOrders: true
  }
  order: OrderSpec
  sourceValidUntil: Date
  keyId: string
  privateKeyPem: string | KeyObject
  now?: Date
}): SignedOrderIntent {
  const now = input.now ?? new Date()
  const expiresAt = new Date(Math.min(
    input.sourceValidUntil.getTime(),
    now.getTime() + 60_000,
  ))
  if (expiresAt.getTime() <= now.getTime()) throw new Error('订单意图源数据已过期')
  if (input.order.maxSlippageBps < 0 || input.order.maxSlippageBps > 15) {
    throw new Error('最大滑点必须在 0 到 15 bps 之间')
  }
  if (
    input.order.broker !== input.provider
    || !Number.isInteger(input.poolVersion)
    || input.poolVersion < 1
    || !Number.isInteger(input.configVersion)
    || input.configVersion < 1
    || (input.executionMode === 'AUTO_EXECUTE' && !input.sessionId)
  ) {
    throw new Error('订单意图版本、券商或自动交易会话无效')
  }

  const unsigned: UnsignedOrderIntent = {
    schemaVersion: '2.0',
    intentId: randomUUID(),
    userId: input.userId,
    deviceId: input.deviceId,
    brokerConnectionId: input.brokerConnectionId,
    provider: input.provider,
    accountIdHash: input.accountIdHash,
    contextHash: input.contextHash,
    strategyVersion: input.strategyVersion,
    sessionId: input.sessionId,
    poolVersion: input.poolVersion,
    configVersion: input.configVersion,
    riskPolicyVersion: input.riskPolicyVersion,
    executionMode: input.executionMode,
    clientRevalidation: input.clientRevalidation,
    order: input.order,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    keyId: input.keyId,
  }
  const key = typeof input.privateKeyPem === 'string'
    ? createPrivateKey(input.privateKeyPem)
    : input.privateKeyPem
  const signature = sign(null, signingPayload(unsigned), key).toString('base64url')
  return { ...unsigned, signature }
}

export function verifySignedOrderIntent(
  intent: SignedOrderIntent,
  publicKeyPem: string | KeyObject,
  expected: {
    userId: string
    deviceId: string
    brokerConnectionId: string
    accountIdHash: string
    now?: Date
  },
): boolean {
  const now = expected.now ?? new Date()
  if (
    intent.userId !== expected.userId
    || intent.deviceId !== expected.deviceId
    || intent.brokerConnectionId !== expected.brokerConnectionId
    || intent.accountIdHash !== expected.accountIdHash
    || intent.provider !== intent.order.broker
    || Date.parse(intent.expiresAt) <= now.getTime()
    || Date.parse(intent.issuedAt) > now.getTime() + 5_000
  ) {
    return false
  }
  const { signature, ...unsigned } = intent
  const key = typeof publicKeyPem === 'string'
    ? createPublicKey(publicKeyPem)
    : publicKeyPem
  return verify(
    null,
    signingPayload(unsigned),
    key,
    Buffer.from(signature, 'base64url'),
  )
}
