import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { leaderKeepAlive, tryAcquireLeader } from '../../api/cloud/state/leaderLock.js'

describe('worker leader lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.WORKER_DEPLOYMENT_GENERATION
  })

  afterEach(() => {
    delete process.env.WORKER_DEPLOYMENT_GENERATION
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

  it('allows a newer deployment generation to replace the current leader immediately', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ got: false }] })
        .mockResolvedValueOnce({ rows: [{ got: true }] })
        .mockResolvedValueOnce({ rows: [{ stale: false, leader_generation: '55' }] })
        .mockResolvedValueOnce({ rows: [{ pid: 42, terminated: true }] })
        .mockResolvedValueOnce({ rows: [{ got: true }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    await expect(tryAcquireLeader(56)).resolves.toBe(client)
    expect(client.query).toHaveBeenCalledTimes(7)
    expect(client.query.mock.calls[4]?.[0]).toContain('pg_terminate_backend')
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateGeneration: 56,
        leaderGeneration: 55,
        reason: 'newer_deployment',
      }),
      expect.any(String),
    )
  })

  it('does not let an older deployment generation replace a newer leader', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ got: false }] })
        .mockResolvedValueOnce({ rows: [{ got: true }] })
        .mockResolvedValueOnce({ rows: [{ stale: false, leader_generation: '57' }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    await expect(tryAcquireLeader(56)).resolves.toBeNull()
    expect(client.query).toHaveBeenCalledTimes(5)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('pg_terminate_backend'))).toBe(false)
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('asks the old leader to exit after a newer generation is announced', async () => {
    process.env.WORKER_DEPLOYMENT_GENERATION = '56'
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ generation: '57' }] }),
    }

    await expect(leaderKeepAlive(client as never)).resolves.toBe(false)
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cloud.worker.leader.handoff_requested',
        deploymentGeneration: 56,
        targetGeneration: 57,
      }),
      expect.any(String),
    )
  })
})
