import { createHash } from 'node:crypto'
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const STALE_MS = 10 * 60 * 1000

export async function acquireOrderSubmissionLock(key: string): Promise<() => Promise<void>> {
  const directory = resolve(process.env.ORDER_SUBMISSION_LOCK_DIR ?? '.data/order-submission-locks')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = `${createHash('sha256').update(key).digest('hex')}.lock`
  const path = resolve(directory, filename)
  try {
    const info = await stat(path)
    if (Date.now() - info.mtimeMs > STALE_MS) await unlink(path)
  } catch {
    // Missing lock is the normal path.
  }
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    await handle.close()
  } catch {
    throw new Error('账户已有跨进程提交校验进行中，请等待结果。')
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await unlink(path).catch(() => {})
  }
}
