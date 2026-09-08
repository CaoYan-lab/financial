import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConnection } from '../../api/cloud/multiuser/types.js'

const mocks = vi.hoisted(() => ({
  fromApikey: vi.fn((appKey: string) => ({ appKey })),
  quoteNew: vi.fn((config: unknown) => ({ kind: 'quote', config })),
  tradeNew: vi.fn((config: unknown) => ({ kind: 'trade', config })),
  credentialsForConnection: vi.fn((connection: BrokerConnection) => ({
    appKey: `key-${connection.id}`,
    appSecret: `secret-${connection.id}`,
    accessToken: `token-${connection.id}`,
  })),
}))

vi.mock('longbridge', () => ({
  Config: { fromApikey: mocks.fromApikey },
  QuoteContext: { new: mocks.quoteNew },
  TradeContext: { new: mocks.tradeNew },
}))

vi.mock('../../api/cloud/multiuser/longbridge/connectionStore.js', () => ({
  credentialsForConnection: mocks.credentialsForConnection,
}))

import {
  contextRegistrySnapshot,
  contextsForConnection,
  evictConnectionContext,
} from '../../api/cloud/multiuser/longbridge/contextRegistry.js'

function connection(id: string, userId: string): BrokerConnection {
  return {
    id,
    userId,
    platform: 'longbridge',
    credentialSource: 'encrypted_bundle',
    status: 'verified',
  }
}

describe('Longbridge 租户 Context 注册表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const id of contextRegistrySnapshot().ids) evictConnectionContext(id)
  })

  it('相同 binding 复用 Context，不同 binding 完全隔离', () => {
    const firstConnection = connection('binding-a', 'user-a')
    const secondConnection = connection('binding-b', 'user-b')

    const first = contextsForConnection(firstConnection)
    const firstAgain = contextsForConnection(firstConnection)
    const second = contextsForConnection(secondConnection)

    expect(firstAgain).toBe(first)
    expect(second).not.toBe(first)
    expect(first.trade).not.toBe(second.trade)
    expect(mocks.fromApikey).toHaveBeenCalledTimes(2)
    expect(contextRegistrySnapshot().ids.sort()).toEqual(['binding-a', 'binding-b'])
  })

  it('创建 Context 不修改进程级 Longbridge 凭据', () => {
    const original = {
      appKey: process.env.LONGBRIDGE_APP_KEY,
      appSecret: process.env.LONGBRIDGE_APP_SECRET,
      accessToken: process.env.LONGBRIDGE_ACCESS_TOKEN,
    }

    contextsForConnection(connection('binding-c', 'user-c'))

    expect(process.env.LONGBRIDGE_APP_KEY).toBe(original.appKey)
    expect(process.env.LONGBRIDGE_APP_SECRET).toBe(original.appSecret)
    expect(process.env.LONGBRIDGE_ACCESS_TOKEN).toBe(original.accessToken)
  })

  it('绑定失效后立即驱逐缓存 Context', () => {
    contextsForConnection(connection('binding-d', 'user-d'))
    evictConnectionContext('binding-d')

    expect(contextRegistrySnapshot().ids).not.toContain('binding-d')
  })
})
