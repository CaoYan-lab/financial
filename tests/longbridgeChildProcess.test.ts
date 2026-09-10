import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('Longbridge 订单子进程退出', () => {
  it('写完结果后主动退出，不受 SDK 长连接句柄阻塞', async () => {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'api/longbridge/longbridgeChildProcess.mjs'),
    ).href
    const script = [
      `import { writeChildResult } from ${JSON.stringify(moduleUrl)}`,
      'setInterval(() => undefined, 10_000)',
      "writeChildResult({ ok: true, source: 'test' })",
    ].join(';')

    const result = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      script,
    ], { timeout: 1_000 })

    expect(JSON.parse(result.stdout)).toEqual({ ok: true, source: 'test' })
  })
})
