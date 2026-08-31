import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import pino from 'pino'

type LogContext = {
  traceId: string
}

const storage = new AsyncLocalStorage<LogContext>()
const usePretty = process.env.LOG_PRETTY !== 'false' && process.env.NODE_ENV !== 'test'

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: undefined,
  mixin() {
    return {
      traceId: currentTraceId(),
      logId: randomUUID(),
    }
  },
  transport: usePretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          messageFormat: '{event} {msg}',
        },
      }
    : undefined,
})

export function createTraceId(prefix = 'trace'): string {
  return `${prefix}-${randomUUID()}`
}

export function withLogContext<T>(traceId: string, callback: () => T): T {
  return storage.run({ traceId }, callback)
}

export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined
}

export function durationMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
