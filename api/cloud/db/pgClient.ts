import { Pool, type QueryResultRow } from 'pg'
import { logger } from '../../utils/logger.js'

let pool: Pool | null = null

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
  const result = await getPool().query<T>(text, params as never[])
  return result.rows
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
