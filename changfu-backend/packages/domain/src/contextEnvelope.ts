import { createHash } from 'node:crypto'
import type { ContextEnvelope, ContextMetadata } from './contracts.js'

export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024
export const MAX_EXECUTABLE_AGE_MS = 60_000
export const MAX_FUTURE_SKEW_MS = 5_000
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const allowedRootKeys = new Set([
  'schemaVersion',
  'requestId',
  'deviceId',
  'brokerConnectionId',
  'provider',
  'purpose',
  'capturedAt',
  'expiresAt',
  'sequence',
  'account',
  'positions',
  'marketSessions',
  'quotes',
  'minuteBars',
  'tickerPoints',
  'orderBooks',
  'openOrders',
  'recentDeals',
  'research',
  'decisionContext',
  'capabilities',
  'strategyConfigVersion',
  'researchPoolVersion',
  'tradingConfigVersion',
  'catalogVersion',
  'tradingSessionId',
  'requestedSymbols',
  'clientPolicyVersion',
  'dataGaps',
  'contentHash',
  'deviceSignature',
])

export class ContextValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ContextValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `${field} 必须是非空字符串`)
  }
  return value
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `${field} 必须是数组`)
  }
  return value
}

function requiredUuid(value: unknown, field: string): string {
  const text = requiredString(value, field)
  if (!uuidPattern.test(text)) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `${field} 必须是 UUID`)
  }
  return text
}

function cappedArray(value: unknown, field: string, maxItems: number): unknown[] {
  const list = requiredArray(value, field)
  if (list.length > maxItems) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `${field} 条目数超过 ${maxItems}`)
  }
  return list
}

function parseTime(value: unknown, field: string): { raw: string; epochMs: number } {
  const raw = requiredString(value, field)
  const epochMs = Date.parse(raw)
  if (!Number.isFinite(epochMs)) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `${field} 必须是 ISO 时间`)
  }
  return { raw, epochMs }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function calculateEnvelopeContentHash(value: Record<string, unknown>): string {
  const unsigned = { ...value }
  delete unsigned.contentHash
  delete unsigned.deviceSignature
  return createHash('sha256').update(canonicalize(unsigned)).digest('hex')
}

export function validateContextEnvelope(
  input: unknown,
  options: {
    now?: Date
    byteLength?: number
    verifyContentHash?: boolean
  } = {},
): { envelope: ContextEnvelope; metadata: ContextMetadata } {
  if (!isRecord(input)) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '上下文必须是对象')
  }
  for (const key of Object.keys(input)) {
    if (!allowedRootKeys.has(key)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `不允许的上下文字段：${key}`)
    }
  }

  const serializedBytes = options.byteLength ?? Buffer.byteLength(JSON.stringify(input), 'utf8')
  if (serializedBytes > MAX_ENVELOPE_BYTES) {
    throw new ContextValidationError('CONTEXT_TOO_LARGE', '上下文解压后不得超过 2 MiB')
  }

  if (input.schemaVersion !== '1.0' && input.schemaVersion !== '2.0') {
    throw new ContextValidationError('CONTEXT_VERSION_UNSUPPORTED', '不支持的上下文版本')
  }

  const purposes = new Set([
    'CHAT',
    'SINGLE_DECISION',
    'PORTFOLIO_REVIEW',
    'MANAGED_ORDER_REVIEW',
    'REPORT',
  ])
  const purpose = requiredString(input.purpose, 'purpose')
  if (!purposes.has(purpose)) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'purpose 非法')
  }
  const executable = purpose !== 'CHAT' && purpose !== 'REPORT'
  if (input.schemaVersion === '1.0' && executable) {
    throw new ContextValidationError('CONTEXT_VERSION_UNSUPPORTED', '交易用途必须使用 ContextEnvelope 2.0')
  }
  const provider = input.schemaVersion === '1.0'
    ? 'FUTU'
    : requiredString(input.provider, 'provider')
  if (provider !== 'FUTU' && provider !== 'LONGBRIDGE') {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'provider 非法')
  }
  if (input.schemaVersion === '2.0') {
    for (const [field, value] of [
      ['researchPoolVersion', input.researchPoolVersion],
      ['tradingConfigVersion', input.tradingConfigVersion],
    ] as const) {
      if (!Number.isInteger(value) || Number(value) < 1) {
        throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `${field} 必须是正整数`)
      }
    }
    requiredString(input.catalogVersion, 'catalogVersion')
    if (
      input.tradingSessionId !== null
      && input.tradingSessionId !== undefined
      && !uuidPattern.test(String(input.tradingSessionId))
    ) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'tradingSessionId 必须是 UUID 或 null')
    }
    const requestedSymbols = cappedArray(input.requestedSymbols, 'requestedSymbols', 100)
    if (
      requestedSymbols.length === 0
      || !requestedSymbols.every(item => typeof item === 'string' && item.length > 0 && item.length <= 32)
      || new Set(requestedSymbols).size !== requestedSymbols.length
    ) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'requestedSymbols 非法或重复')
    }
  } else {
    requiredString(input.strategyConfigVersion, 'strategyConfigVersion')
  }

  const capturedAt = parseTime(input.capturedAt, 'capturedAt')
  const expiresAt = parseTime(input.expiresAt, 'expiresAt')
  const nowMs = (options.now ?? new Date()).getTime()
  if (capturedAt.epochMs > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new ContextValidationError('CONTEXT_CLOCK_SKEW', '采集时间晚于服务端时间')
  }
  if (expiresAt.epochMs <= nowMs) {
    throw new ContextValidationError('CONTEXT_EXPIRED', '上下文已过期')
  }
  if (
    executable
    && expiresAt.epochMs - capturedAt.epochMs > MAX_EXECUTABLE_AGE_MS
  ) {
    throw new ContextValidationError('CONTEXT_TTL_INVALID', '可执行上下文有效期不得超过 60 秒')
  }

  const contentHash = requiredString(input.contentHash, 'contentHash')
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new ContextValidationError('CONTEXT_HASH_INVALID', 'contentHash 格式非法')
  }
  const calculatedContentHash = calculateEnvelopeContentHash(input)
  if (options.verifyContentHash !== false && calculatedContentHash !== contentHash) {
    throw new ContextValidationError('CONTEXT_HASH_MISMATCH', '上下文内容哈希不匹配')
  }

  const requestId = requiredUuid(input.requestId, 'requestId')
  const deviceId = requiredUuid(input.deviceId, 'deviceId')
  const brokerConnectionId = requiredUuid(input.brokerConnectionId, 'brokerConnectionId')
  const positions = cappedArray(input.positions, 'positions', 500)
  cappedArray(input.marketSessions, 'marketSessions', 20)
  const quotes = cappedArray(input.quotes, 'quotes', 500)
  const minuteBars = cappedArray(input.minuteBars, 'minuteBars', 4_000)
  const tickerPoints = cappedArray(input.tickerPoints, 'tickerPoints', 4_000)
  const orderBooks = cappedArray(input.orderBooks, 'orderBooks', 1_000)
  const openOrders = cappedArray(input.openOrders, 'openOrders', 500)
  const recentDeals = cappedArray(input.recentDeals, 'recentDeals', 1_000)
  const dataGaps = cappedArray(input.dataGaps, 'dataGaps', 100)
  if (!isRecord(input.account)) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'account 必须是对象')
  }
  if (input.account.broker !== undefined && input.account.broker !== provider) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'account.broker 与 provider 不一致')
  }
  if (input.research !== undefined) {
    if (!isRecord(input.research)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'research 必须是对象')
    }
    const allowedResearchKeys = new Set([
      'entitlementStatus',
      'planName',
      'poolLimit',
      'poolSymbols',
      'conversationSymbols',
    ])
    for (const key of Object.keys(input.research)) {
      if (!allowedResearchKeys.has(key)) {
        throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `不允许的研究字段：${key}`)
      }
    }
    const poolSymbols = cappedArray(input.research.poolSymbols, 'research.poolSymbols', 100)
    const conversationSymbols = cappedArray(
      input.research.conversationSymbols,
      'research.conversationSymbols',
      100,
    )
    const validSymbols = (items: unknown[]) => items.every(
      item => typeof item === 'string' && item.length > 0 && item.length <= 32,
    )
    if (!validSymbols(poolSymbols) || !validSymbols(conversationSymbols)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '研究标的代码非法')
    }
    if (new Set(poolSymbols).size !== poolSymbols.length
      || new Set(conversationSymbols).size !== conversationSymbols.length) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '研究标的不得重复')
    }
    const pool = new Set(poolSymbols)
    if (!conversationSymbols.every(symbol => pool.has(symbol))) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '对话标的必须来自标的池')
    }
    const poolLimit = input.research.poolLimit
    if (!Number.isInteger(poolLimit) || Number(poolLimit) < 0 || Number(poolLimit) > 10_000) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '标的池容量非法')
    }
    if (poolSymbols.length > Number(poolLimit)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '标的池超过套餐额度')
    }
    const entitlementStatus = requiredString(
      input.research.entitlementStatus,
      'research.entitlementStatus',
    )
    if (!new Set(['unavailable', 'active', 'expired']).has(entitlementStatus)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '研究套餐状态非法')
    }
    if (entitlementStatus !== 'active' && conversationSymbols.length > 0) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '无有效套餐时不得选择对话标的')
    }
    if (
      input.research.planName !== null
      && (typeof input.research.planName !== 'string' || input.research.planName.length > 64)
    ) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '研究套餐名称非法')
    }
  }
  if (input.decisionContext !== undefined) {
    if (!isRecord(input.decisionContext)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'decisionContext 必须是对象')
    }
    const decisionKeys = new Set([
      'strategyRequirements',
      'evidenceCatalog',
      'trendContext',
      'positionExposure',
      'accountRisk',
      'ordersKnowledge',
      'dataWindow',
      'extendedSession',
      'gapCatalog',
      'temporalBoundary',
      'outputContract',
    ])
    for (const key of Object.keys(input.decisionContext)) {
      if (!decisionKeys.has(key)) {
        throw new ContextValidationError(
          'CONTEXT_SCHEMA_INVALID',
          `不允许的决策上下文字段：${key}`,
        )
      }
    }
    for (const field of [
      'strategyRequirements',
      'accountRisk',
      'ordersKnowledge',
      'temporalBoundary',
      'outputContract',
    ]) {
      if (!isRecord(input.decisionContext[field])) {
        throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `decisionContext.${field} 必须是对象`)
      }
    }
    const evidenceCatalog = cappedArray(
      input.decisionContext.evidenceCatalog,
      'decisionContext.evidenceCatalog',
      100,
    )
    const evidenceIds = new Set<string>()
    for (const [index, item] of evidenceCatalog.entries()) {
      const entry = isRecord(item) ? item : null
      const id = entry ? requiredString(entry.id, `decisionContext.evidenceCatalog[${index}].id`) : ''
      if (
        !entry
        || id.length > 80
        || evidenceIds.has(id)
        || !new Set(['ACCOUNT', 'POSITION', 'QUOTE', 'TREND', 'ORDER', 'RISK']).has(
          String(entry.kind),
        )
        || typeof entry.summary !== 'string'
        || entry.summary.length === 0
        || entry.summary.length > 500
        || typeof entry.sourceAt !== 'string'
        || !Number.isFinite(Date.parse(entry.sourceAt))
      ) {
        throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'decisionContext 证据目录非法')
      }
      evidenceIds.add(id)
    }
    cappedArray(input.decisionContext.trendContext, 'decisionContext.trendContext', 100)
    cappedArray(input.decisionContext.positionExposure, 'decisionContext.positionExposure', 500)
    cappedArray(input.decisionContext.dataWindow, 'decisionContext.dataWindow', 100)
    cappedArray(input.decisionContext.extendedSession, 'decisionContext.extendedSession', 100)
    const gapCatalog = cappedArray(
      input.decisionContext.gapCatalog,
      'decisionContext.gapCatalog',
      100,
    )
    for (const item of gapCatalog) {
      const entry = isRecord(item) ? item : null
      if (
        !entry
        || typeof entry.code !== 'string'
        || entry.code.length === 0
        || entry.code.length > 80
        || !new Set(['BLOCKING', 'DEGRADING', 'INFORMATIONAL']).has(String(entry.severity))
        || typeof entry.summary !== 'string'
        || entry.summary.length === 0
        || entry.summary.length > 300
        || typeof entry.sourceSupport !== 'string'
      ) {
        throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'decisionContext 缺口目录非法')
      }
    }
  }

  const capabilities = cappedArray(input.capabilities, 'capabilities', 10)
  const knownCapabilities = new Map([
    ['skill:quantitative', {
      promptVersion: 'research-quantitative-v1',
      toolPolicyVersion: 'research-readonly-v1',
    }],
    ['skill:sellPut', {
      promptVersion: 'top30-mega-cap-csp-v3',
      toolPolicyVersion: 'research-readonly-v1',
    }],
  ])
  const capabilityKeys = new Set([
    'id',
    'kind',
    'title',
    'promptVersion',
    'modelProfile',
    'toolPolicyVersion',
  ])
  const seenCapabilities = new Set<string>()
  for (const [index, capability] of capabilities.entries()) {
    if (!isRecord(capability)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `capabilities[${index}] 必须是对象`)
    }
    for (const key of Object.keys(capability)) {
      if (!capabilityKeys.has(key)) {
        throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `不允许的能力字段：${key}`)
      }
    }
    const id = requiredString(capability.id, `capabilities[${index}].id`)
    const kind = requiredString(capability.kind, `capabilities[${index}].kind`)
    const title = requiredString(capability.title, `capabilities[${index}].title`)
    const key = `${kind}:${id}`
    const registration = knownCapabilities.get(key)
    if (!new Set(['skill', 'agent', 'tool']).has(kind) || !registration) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `能力未注册：${key}`)
    }
    if (id.length > 64 || title.length > 64 || seenCapabilities.has(key)) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', '能力标识非法或重复')
    }
    seenCapabilities.add(key)
    if (
      capability.promptVersion !== registration.promptVersion
      || capability.toolPolicyVersion !== registration.toolPolicyVersion
      || !new Set(['fast', 'deep', 'risk']).has(String(capability.modelProfile))
    ) {
      throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', `能力配置非法：${key}`)
    }
  }
  if (!Number.isInteger(input.sequence) || Number(input.sequence) < 1) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'sequence 必须是正整数')
  }
  if (!dataGaps.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200)) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'dataGaps 条目非法')
  }
  if (requiredString(input.deviceSignature, 'deviceSignature').length < 80) {
    throw new ContextValidationError('CONTEXT_SCHEMA_INVALID', 'deviceSignature 长度不足')
  }

  const envelope = input as unknown as ContextEnvelope
  return {
    envelope,
    metadata: {
      requestId,
      deviceId,
      brokerConnectionId,
      provider,
      schemaVersion: envelope.schemaVersion,
      purpose: envelope.purpose,
      contentHash,
      capturedAt: capturedAt.raw,
      expiresAt: expiresAt.raw,
      byteLength: serializedBytes,
      requestedSymbols: envelope.requestedSymbols ?? [],
      counts: {
        positions: positions.length,
        quotes: quotes.length,
        minuteBars: minuteBars.length,
        tickerPoints: tickerPoints.length,
        orderBooks: orderBooks.length,
        openOrders: openOrders.length,
        recentDeals: recentDeals.length,
        capabilities: capabilities.length,
        dataGaps: dataGaps.length,
      },
    },
  }
}
