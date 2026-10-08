import { createHash } from 'node:crypto'
import type { Pool } from 'pg'

export type PublicSource = 'SEC' | 'FINRA'

export type PublicSourceCacheEntry<T> = {
  source: PublicSource
  cacheKey: string
  asOf: string
  fetchedAt: string
  expiresAt: string
  checksum: string
  payload: T
}

export type PublicSourceCacheLogger = (event: {
  source: PublicSource
  cacheKey: string
  status: 'HIT' | 'MISS' | 'FETCHED' | 'FAILED'
  durationMs: number
  itemCount: number | null
}) => void

export interface PublicSourceCache {
  getOrFetch<T>(input: {
    source: PublicSource
    cacheKey: string
    asOf: Date
    expiresAt: Date
    fetcher: () => Promise<T>
  }): Promise<PublicSourceCacheEntry<T>>
}

const inFlightFetches = new Map<string, Promise<PublicSourceCacheEntry<unknown>>>()

export class PostgresPublicSourceCache implements PublicSourceCache {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly logger: PublicSourceCacheLogger = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getOrFetch<T>(input: {
    source: PublicSource
    cacheKey: string
    asOf: Date
    expiresAt: Date
    fetcher: () => Promise<T>
  }): Promise<PublicSourceCacheEntry<T>> {
    const startedAt = Date.now()
    const cached = await this.pool.query<{
      source: PublicSource
      cache_key: string
      as_of: Date
      fetched_at: Date
      expires_at: Date
      checksum: string
      payload: T
    }>(
      `SELECT source, cache_key, as_of, fetched_at, expires_at, checksum, payload
         FROM changfu.quantitative_public_source_cache
        WHERE source = $1 AND cache_key = $2 AND expires_at > $3::timestamptz`,
      [input.source, input.cacheKey, this.now().toISOString()],
    )
    const hit = cached.rows[0]
    if (hit) {
      this.log(input.source, input.cacheKey, 'HIT', startedAt, hit.payload)
      return {
        source: hit.source,
        cacheKey: hit.cache_key,
        asOf: hit.as_of.toISOString(),
        fetchedAt: hit.fetched_at.toISOString(),
        expiresAt: hit.expires_at.toISOString(),
        checksum: hit.checksum,
        payload: hit.payload,
      }
    }

    this.log(input.source, input.cacheKey, 'MISS', startedAt, null)
    const inFlightKey = `${input.source}:${input.cacheKey}`
    const existing = inFlightFetches.get(inFlightKey)
    if (existing) return await existing as PublicSourceCacheEntry<T>
    const operation = this.fetchAndStore(input, startedAt)
    inFlightFetches.set(
      inFlightKey,
      operation as Promise<PublicSourceCacheEntry<unknown>>,
    )
    try {
      return await operation
    } finally {
      if (inFlightFetches.get(inFlightKey) === operation) {
        inFlightFetches.delete(inFlightKey)
      }
    }
  }

  private async fetchAndStore<T>(
    input: {
      source: PublicSource
      cacheKey: string
      asOf: Date
      expiresAt: Date
      fetcher: () => Promise<T>
    },
    startedAt: number,
  ): Promise<PublicSourceCacheEntry<T>> {
    try {
      const payload = await input.fetcher()
      const serialized = JSON.stringify(payload)
      const checksum = createHash('sha256').update(serialized).digest('hex')
      const fetchedAt = this.now()
      await this.pool.query(
        `INSERT INTO changfu.quantitative_public_source_cache (
           source, cache_key, as_of, fetched_at, expires_at, checksum, payload
         ) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6, $7::jsonb)
         ON CONFLICT (source, cache_key) DO UPDATE
           SET as_of = EXCLUDED.as_of, fetched_at = EXCLUDED.fetched_at,
               expires_at = EXCLUDED.expires_at, checksum = EXCLUDED.checksum,
               payload = EXCLUDED.payload`,
        [
          input.source,
          input.cacheKey,
          input.asOf.toISOString(),
          fetchedAt.toISOString(),
          input.expiresAt.toISOString(),
          checksum,
          serialized,
        ],
      )
      this.log(input.source, input.cacheKey, 'FETCHED', startedAt, payload)
      return {
        source: input.source,
        cacheKey: input.cacheKey,
        asOf: input.asOf.toISOString(),
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        checksum,
        payload,
      }
    } catch (error) {
      this.log(input.source, input.cacheKey, 'FAILED', startedAt, null)
      throw error
    }
  }

  private log(
    source: PublicSource,
    cacheKey: string,
    status: 'HIT' | 'MISS' | 'FETCHED' | 'FAILED',
    startedAt: number,
    payload: unknown,
  ): void {
    this.logger({
      source,
      cacheKey,
      status,
      durationMs: Date.now() - startedAt,
      itemCount: Array.isArray(payload) ? payload.length : null,
    })
  }
}
