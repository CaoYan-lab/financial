import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const DEFAULT_CLI_MIN_INTERVAL_MS = Math.max(0, Number(process.env.LONGBRIDGE_CLI_MIN_INTERVAL_MS || 1_500) || 1_500)
const DEFAULT_CLI_QUEUE_WAIT_TIMEOUT_MS = Math.max(5_000, Number(process.env.LONGBRIDGE_CLI_QUEUE_WAIT_TIMEOUT_MS || 20_000) || 20_000)
let cliQueue: Promise<unknown> = Promise.resolve()
let lastCliStartedAt = 0

export type LongbridgeCliResult = {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export function resolveLongbridgeCliPath(): string {
  const localPath = path.resolve(process.cwd(), '.tools', 'longbridge', 'longbridge')
  if (fs.existsSync(localPath)) return localPath
  return process.env.LONGBRIDGE_CLI_BIN || 'longbridge'
}

export async function runLongbridgeCli(args: string[], options: { timeoutMs?: number } = {}): Promise<LongbridgeCliResult> {
  try {
    return await enqueueLongbridgeCli(() => runLongbridgeCliNow(args, options), args)
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : 'Longbridge CLI queue failed.',
    }
  }
}

async function runLongbridgeCliNow(args: string[], options: { timeoutMs?: number } = {}): Promise<LongbridgeCliResult> {
  const cliPath = resolveLongbridgeCliPath()
  const localHome = path.resolve(process.cwd(), '.tools', 'longbridge-home')
  const home = fs.existsSync(localHome) ? localHome : process.env.HOME
  const env: NodeJS.ProcessEnv = { ...process.env, ...(home ? { HOME: home } : {}) }
  try {
    const result = await execFileAsync(cliPath, args, {
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: 1024 * 1024 * 4,
      env,
    })
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    }
  } catch (error) {
    const maybe = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: maybe.stdout?.trim() ?? '',
      stderr: maybe.stderr?.trim() ?? '',
      error: maybe.message ?? 'Longbridge CLI failed.',
    }
  }
}

async function enqueueLongbridgeCli<T>(task: () => Promise<T>, args: string[]): Promise<T> {
  const previous = cliQueue
  let release: () => void = () => {}
  cliQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await withTimeout(previous.catch(() => undefined), DEFAULT_CLI_QUEUE_WAIT_TIMEOUT_MS, `Longbridge CLI queue wait timed out before ${args.join(' ')}.`)
  } catch (error) {
    release()
    throw error
  }
  try {
    const waitMs = DEFAULT_CLI_MIN_INTERVAL_MS - (Date.now() - lastCliStartedAt)
    if (waitMs > 0) await sleep(waitMs)
    lastCliStartedAt = Date.now()
    return await task()
  } finally {
    release()
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseJsonOutput<T>(result: LongbridgeCliResult | undefined): T | undefined {
  if (!result) return undefined
  if (!result.stdout) return undefined
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    return undefined
  }
}
