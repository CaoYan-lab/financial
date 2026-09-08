import { Config, QuoteContext, TradeContext } from 'longbridge'
import { createLongbridgeSdkScheduler } from '../../../longbridge/longbridgeSdkRateLimiter.js'
import type { BrokerConnection, LongbridgeCredentialBundle } from '../types.js'
import { credentialsForConnection } from './connectionStore.js'

type QuoteContextInstance = InstanceType<typeof QuoteContext>
type TradeContextInstance = InstanceType<typeof TradeContext>

export type TenantLongbridgeContexts = {
  config: Config
  quote: QuoteContextInstance
  trade: TradeContextInstance
  createdAt: number
  lastUsedAt: number
}

const CONTEXT_TTL_MS = Number(process.env.MULTIUSER_CONTEXT_TTL_MS || 30 * 60_000)
const MAX_CONTEXTS = Number(process.env.MULTIUSER_MAX_CONTEXTS || 20)
const contexts = new Map<string, TenantLongbridgeContexts>()

function createContexts(bundle: LongbridgeCredentialBundle): TenantLongbridgeContexts {
  const config = Config.fromApikey(
    bundle.appKey,
    bundle.appSecret,
    bundle.accessToken,
    { enablePrintQuotePackages: false },
  )
  const scheduler = createLongbridgeSdkScheduler()
  return {
    config,
    quote: scheduler.wrap(QuoteContext.new(config)),
    trade: scheduler.wrap(TradeContext.new(config)),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  }
}

function evictExpired(now = Date.now()): void {
  for (const [id, value] of contexts) {
    if (now - value.lastUsedAt > CONTEXT_TTL_MS) contexts.delete(id)
  }
  if (contexts.size <= MAX_CONTEXTS) return
  const oldest = [...contexts.entries()]
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    .slice(0, contexts.size - MAX_CONTEXTS)
  for (const [id] of oldest) contexts.delete(id)
}

export function contextsForConnection(connection: BrokerConnection): TenantLongbridgeContexts {
  evictExpired()
  const cached = contexts.get(connection.id)
  if (cached) {
    cached.lastUsedAt = Date.now()
    return cached
  }
  const created = createContexts(credentialsForConnection(connection))
  contexts.set(connection.id, created)
  return created
}

export function evictConnectionContext(connectionId: string): void {
  contexts.delete(connectionId)
}

export function contextRegistrySnapshot(): { active: number; ids: string[] } {
  evictExpired()
  return { active: contexts.size, ids: [...contexts.keys()] }
}
