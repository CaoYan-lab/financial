import { describe, expect, it, vi } from 'vitest'
import {
  isRetryablePgConnectionError,
  withPgConnectionRetry,
} from '../../api/cloud/db/pgClient.js'

describe('PostgreSQL connection retry', () => {
  it('retries a pg-pool connection establishment timeout', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValue('ok')

    await expect(withPgConnectionRetry(operation, {
      maxAttempts: 3,
      initialDelayMs: 0,
      operation: 'test',
    })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('recognizes a wrapped connect ETIMEDOUT error', () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:5432'), {
      code: 'ETIMEDOUT',
    })

    expect(isRetryablePgConnectionError(
      new Error('database unavailable', { cause }),
    )).toBe(true)
  })

  it('does not retry SQL or statement timeout failures', async () => {
    const operation = vi.fn().mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    )

    await expect(withPgConnectionRetry(operation, {
      maxAttempts: 3,
      initialDelayMs: 0,
      operation: 'test',
    })).rejects.toThrow('statement timeout')
    expect(operation).toHaveBeenCalledOnce()
  })

  it('stops after the configured number of connection attempts', async () => {
    const operation = vi.fn().mockRejectedValue(
      new Error('Connection terminated due to connection timeout'),
    )

    await expect(withPgConnectionRetry(operation, {
      maxAttempts: 3,
      initialDelayMs: 0,
      operation: 'test',
    })).rejects.toThrow('connection timeout')
    expect(operation).toHaveBeenCalledTimes(3)
  })
})
