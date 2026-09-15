import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { logger } from '../../utils/logger.js'

let pool: Pool | null = null
const PG_CONNECTION_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.PG_CONNECTION_RETRY_ATTEMPTS || 3) || 3,
)
const PG_CONNECTION_RETRY_DELAY_MS = Math.max(
  0,
  Number(process.env.PG_CONNECTION_RETRY_DELAY_MS || 250) || 250,
)

type ErrorWithCause = {
  cause?: unknown
  code?: unknown
  message?: unknown
}

type PgRetryOptions = {
  maxAttempts?: number
  initialDelayMs?: number
  operation?: string
}

export function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  return ''
}

export function isPgEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL) || process.env.CLOUD_MODE === '1'
}

export function getPool(): Pool {
  if (pool) return pool
  const connectionString = databaseUrl()
  if (!connectionString) {
    throw new Error('DATABASE_URL 未配置，无法连接 PostgreSQL')
  }
  pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'financial-workbench-cloud',
  })
  pool.on('error', (error) => {
    logger.error({ event: 'pg.pool.error', error: error.message }, 'PostgreSQL pool error')
  })
  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await withPgConnectionRetry(
    () => getPool().query<T>(text, params as never[]),
    { operation: 'query' },
  )
  return result.rows
}

export function connectPgClient(
  operation = 'transaction',
): Promise<PoolClient> {
  return withPgConnectionRetry(
    () => getPool().connect(),
    { operation },
  )
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/**
 * pg-pool only emits this message after a new connection failed before a
 * query was sent, so retrying is safe for both reads and writes.
 */
export function isRetryablePgConnectionError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = current as ErrorWithCause
    const message = typeof record.message === 'string'
      ? record.message.toLowerCase()
      : String(current).toLowerCase()
    const code = typeof record.code === 'string'
      ? record.code.toUpperCase()
      : ''
    if (message.includes('connection terminated due to connection timeout')) {
      return true
    }
    if (code === 'ETIMEDOUT' && /\bconnect(?:ion)?\b/.test(message)) {
      return true
    }
    current = record.cause
  }
  return false
}

export async function withPgConnectionRetry<T>(
  operation: () => Promise<T>,
  options: PgRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? PG_CONNECTION_RETRY_ATTEMPTS),
  )
  const initialDelayMs = Math.max(
    0,
    Math.floor(options.initialDelayMs ?? PG_CONNECTION_RETRY_DELAY_MS),
  )

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (
        attempt >= maxAttempts
        || !isRetryablePgConnectionError(error)
      ) {
        throw error
      }
      const retryDelayMs = initialDelayMs * (2 ** (attempt - 1))
      logger.warn(
        {
          event: 'pg.connection.retry',
          operation: options.operation ?? 'database_operation',
          attempt,
          maxAttempts,
          retryDelayMs,
          error: error instanceof Error ? error.message : String(error),
        },
        'PostgreSQL 建连超时，等待后重试',
      )
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }
}
