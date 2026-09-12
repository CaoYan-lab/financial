import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}))

vi.mock('../../api/utils/logger.js', () => ({
  logger: { warn: mocks.warn },
}))

import { tryAcquireLeader } from '../../api/cloud/state/leaderLock.js'

describe('worker leader lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the held connection when the advisory lock is acquired', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ got: true }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    await expect(tryAcquireLeader()).resolves.toBe(client)
    expect(client.release).not.toHaveBeenCalled()
  })

  it('does not interrupt a leader whose heartbeat is current', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ got: false }] })
        .mockResolvedValueOnce({ rows: [{ got: true }] })
        .mockResolvedValueOnce({ rows: [{ stale: false }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    await expect(tryAcquireLeader()).resolves.toBeNull()
    expect(client.query).toHaveBeenCalledTimes(4)
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('serializes recovery and atomically acquires the leader lock after terminating the stale owner', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ got: false }] })
        .mockResolvedValueOnce({ rows: [{ got: true }] })
        .mockResolvedValueOnce({ rows: [{ stale: true }] })
        .mockResolvedValueOnce({ rows: [{ pid: 42, terminated: true }] })
        .mockResolvedValueOnce({ rows: [{ got: true }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    await expect(tryAcquireLeader()).resolves.toBe(client)
    expect(client.query).toHaveBeenCalledTimes(6)
    expect(client.query.mock.calls[3]?.[0]).toContain("a.application_name = 'financial-workbench-cloud'")
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cloud.worker.leader.stale_connection_recovered',
        backendPids: [42],
      }),
      expect.any(String),
    )
    expect(client.release).not.toHaveBeenCalled()
  })

  it('does not recover when another standby owns the recovery lock', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ got: false }] })
        .mockResolvedValueOnce({ rows: [{ got: false }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    await expect(tryAcquireLeader()).resolves.toBeNull()
    expect(client.query).toHaveBeenCalledTimes(2)
    expect(client.release).toHaveBeenCalledOnce()
  })
})
