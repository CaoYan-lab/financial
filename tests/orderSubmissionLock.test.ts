import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireOrderSubmissionLock } from '../api/live/orderSubmissionLock'

describe('跨进程订单提交锁', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'order-submit-lock-'))
    vi.stubEnv('ORDER_SUBMISSION_LOCK_DIR', directory)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it('同一账户同时只能持有一个锁，释放后可再次获取', async () => {
    const release = await acquireOrderSubmissionLock('longbridge:account-a')
    await expect(acquireOrderSubmissionLock('longbridge:account-a')).rejects.toThrow('跨进程')
    await release()
    const releaseAgain = await acquireOrderSubmissionLock('longbridge:account-a')
    await releaseAgain()
  })

  it('不同账户的提交锁相互隔离', async () => {
    const first = await acquireOrderSubmissionLock('longbridge:account-a')
    const second = await acquireOrderSubmissionLock('longbridge:account-b')
    await Promise.all([first(), second()])
  })
})
