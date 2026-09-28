import { randomUUID } from 'node:crypto'

export const LEASE_TTL_MS = 90_000

export type TradingLease = {
  leaseId: string
  userId: string
  brokerConnectionId: string
  deviceId: string
  expiresAt: Date
  version: number
}

export class TradingLeaseConflictError extends Error {
  constructor(readonly activeDeviceId: string) {
    super('该券商连接已由另一台设备持有交易租约')
    this.name = 'TradingLeaseConflictError'
  }
}

export function acquireTradingLease(
  current: TradingLease | null,
  request: {
    userId: string
    brokerConnectionId: string
    deviceId: string
  },
  now = new Date(),
): TradingLease {
  const matchesOwner = current
    && current.userId === request.userId
    && current.brokerConnectionId === request.brokerConnectionId
  const active = matchesOwner && current.expiresAt.getTime() > now.getTime()

  if (active && current.deviceId !== request.deviceId) {
    throw new TradingLeaseConflictError(current.deviceId)
  }

  return {
    leaseId: active ? current.leaseId : randomUUID(),
    userId: request.userId,
    brokerConnectionId: request.brokerConnectionId,
    deviceId: request.deviceId,
    expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
    version: active ? current.version + 1 : 1,
  }
}

export function assertTradingLease(
  lease: TradingLease | null,
  expected: {
    userId: string
    brokerConnectionId: string
    deviceId: string
  },
  now = new Date(),
): asserts lease is TradingLease {
  if (
    !lease
    || lease.userId !== expected.userId
    || lease.brokerConnectionId !== expected.brokerConnectionId
    || lease.deviceId !== expected.deviceId
    || lease.expiresAt.getTime() <= now.getTime()
  ) {
    throw new Error('交易租约无效或已过期')
  }
}
