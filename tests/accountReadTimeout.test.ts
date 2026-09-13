import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('fs', () => ({ default: { mkdirSync: vi.fn() } }))
import { runPythonBridge } from '../api/utils/runPythonBridge'

afterEach(() => vi.useRealTimers())
it('账户查询超时终止子进程并返回不可用', async () => {
  vi.useFakeTimers()
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
  child.kill = vi.fn(() => { child.emit('close', null); return true })
  mocks.spawn.mockReturnValue(child)
  const result = runPythonBridge('futu_account.py', {}, { timeoutMs: 30_000 })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('timed out') })
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
})
