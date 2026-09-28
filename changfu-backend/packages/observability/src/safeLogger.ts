const forbiddenKeys = new Set([
  'account',
  'authorization',
  'context',
  'contextenvelope',
  'devicesignature',
  'minutebars',
  'openorders',
  'orderbooks',
  'password',
  'positions',
  'prompt',
  'quotes',
  'recentdeals',
  'refreshtoken',
  'tickerpoints',
  'token',
  'apikey',
  'privatekey',
  'databaseurl',
  'connectionstring',
  'internaltoken',
  'modelresponse',
  'rawmodelresponse',
])

export class UnsafeLogPayloadError extends Error {
  constructor(readonly keyPath: string) {
    super(`日志字段包含禁止内容：${keyPath}`)
    this.name = 'UnsafeLogPayloadError'
  }
}

function assertSafe(value: unknown, path = '$', seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null) return
  if (seen.has(value)) return
  seen.add(value)

  for (const [key, child] of Object.entries(value)) {
    const keyPath = `${path}.${key}`
    const normalizedKey = key.replaceAll('-', '').replaceAll('_', '').toLowerCase()
    if (
      forbiddenKeys.has(normalizedKey)
      || normalizedKey.endsWith('apikey')
      || normalizedKey.includes('privatekey')
      || normalizedKey.endsWith('privkey')
      || normalizedKey.endsWith('token')
    ) {
      throw new UnsafeLogPayloadError(keyPath)
    }
    assertSafe(child, keyPath, seen)
  }
}

export type SafeLogger = {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  assertSafe(fields)
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  })
  const destination = level === 'error' ? process.stderr : process.stdout
  destination.write(`${line}\n`)
}

export const safeLogger: SafeLogger = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
}
