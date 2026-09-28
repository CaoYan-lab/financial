import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  analyzeSellPutReport,
  SELL_PUT_POOL_CAPACITY,
  SELL_PUT_PROMPT_VERSION,
  type SellPutObservation,
} from '../../domain/src/sellPutResearch.js'
import {
  providerSymbol,
  type SellPutUniverseCompany,
} from '../../domain/src/sellPutUniverse.js'

export type SellPutProvider = 'FUTU' | 'LONGBRIDGE'

export class SellPutResearchError extends Error {
  constructor(readonly code: string) {
    super('SELL PUT 研究模块状态冲突')
    this.name = 'SellPutResearchError'
  }
}

export class PostgresSellPutResearchRepository {
  constructor(private readonly pool: Pool) {}

  async getPool(userId: string, providerId: SellPutProvider): Promise<unknown> {
    await this.ensurePool(this.pool, userId, providerId)
    const [pool, items] = await Promise.all([
      this.pool.query<{ version: string; updated_at: Date }>(
        `SELECT version, updated_at
           FROM changfu.sell_put_research_pools
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [userId, providerId],
      ),
      this.pool.query(
        `SELECT item_id AS "itemId",
                row_number() OVER (ORDER BY added_at, symbol)::integer AS rank,
                symbol, display_name AS "displayName",
                market, added_at AS "addedAt"
           FROM changfu.sell_put_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2 AND status = 'ACTIVE'
          ORDER BY added_at, symbol`,
        [userId, providerId],
      ),
    ])
    const row = pool.rows[0]!
    return {
      providerId,
      version: Number(row.version),
      capacity: SELL_PUT_POOL_CAPACITY,
      items: items.rows,
      updatedAt: row.updated_at.toISOString(),
    }
  }

  async addPoolItem(input: {
    userId: string
    providerId: SellPutProvider
    symbol: string
    displayName: string
    market: 'US' | 'HK'
  }): Promise<unknown> {
    return this.transaction(async client => {
      await this.ensurePool(client, input.userId, input.providerId)
      await client.query(
        `SELECT version FROM changfu.sell_put_research_pools
          WHERE user_id = $1::bigint AND provider_id = $2 FOR UPDATE`,
        [input.userId, input.providerId],
      )
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM changfu.sell_put_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2 AND status = 'ACTIVE'`,
        [input.userId, input.providerId],
      )
      if (Number(count.rows[0]?.count ?? 0) >= SELL_PUT_POOL_CAPACITY) {
        throw new SellPutResearchError('SELL_PUT_POOL_CAPACITY_EXCEEDED')
      }
      try {
        await client.query(
          `INSERT INTO changfu.sell_put_research_pool_items (
             item_id, user_id, provider_id, symbol, display_name, market
           ) VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6)`,
          [randomUUID(), input.userId, input.providerId, input.symbol, input.displayName, input.market],
        )
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new SellPutResearchError('SELL_PUT_SYMBOL_EXISTS')
        }
        throw error
      }
      await this.bumpPool(client, input.userId, input.providerId)
      return this.getPoolWith(client, input.userId, input.providerId)
    })
  }

  async removePoolItem(input: {
    userId: string
    providerId: SellPutProvider
    itemId: string
  }): Promise<unknown> {
    return this.transaction(async client => {
      await this.ensurePool(client, input.userId, input.providerId)
      const removed = await client.query(
        `UPDATE changfu.sell_put_research_pool_items
            SET status = 'REMOVED', removed_at = now(), updated_at = now()
          WHERE item_id = $1::uuid AND user_id = $2::bigint
            AND provider_id = $3 AND status = 'ACTIVE'`,
        [input.itemId, input.userId, input.providerId],
      )
      if (removed.rowCount !== 1) {
        throw new SellPutResearchError('SELL_PUT_SYMBOL_NOT_FOUND')
      }
      await this.bumpPool(client, input.userId, input.providerId)
      return this.getPoolWith(client, input.userId, input.providerId)
    })
  }

  async syncTopThirty(input: {
    userId: string
    providerId: SellPutProvider
    companies: SellPutUniverseCompany[]
    source: string
    sourceAccessedAt: string
    fallback: boolean
  }): Promise<unknown> {
    if (input.companies.length !== SELL_PUT_POOL_CAPACITY) {
      throw new SellPutResearchError('SELL_PUT_TOP30_INCOMPLETE')
    }
    return this.transaction(async client => {
      await this.ensurePool(client, input.userId, input.providerId)
      await client.query(
        `SELECT version FROM changfu.sell_put_research_pools
          WHERE user_id = $1::bigint AND provider_id = $2 FOR UPDATE`,
        [input.userId, input.providerId],
      )
      const symbols = input.companies.map(company => providerSymbol(input.providerId, company.ticker))
      if (new Set(symbols).size !== SELL_PUT_POOL_CAPACITY) {
        throw new SellPutResearchError('SELL_PUT_TOP30_DUPLICATE')
      }
      await client.query(
        `UPDATE changfu.sell_put_research_pool_items
            SET status = 'REMOVED', removed_at = now(), updated_at = now()
          WHERE user_id = $1::bigint AND provider_id = $2 AND status = 'ACTIVE'`,
        [input.userId, input.providerId],
      )
      for (const company of input.companies) {
        await client.query(
          `INSERT INTO changfu.sell_put_research_pool_items (
             item_id, user_id, provider_id, symbol, display_name, market, added_at
           ) VALUES (
             $1::uuid, $2::bigint, $3, $4, $5, 'US',
             $6::timestamptz + ($7::text || ' milliseconds')::interval
           )`,
          [
            randomUUID(),
            input.userId,
            input.providerId,
            providerSymbol(input.providerId, company.ticker),
            company.companyName,
            input.sourceAccessedAt,
            company.rank,
          ],
        )
      }
      await this.bumpPool(client, input.userId, input.providerId)
      const result = await this.getPoolWith(client, input.userId, input.providerId)
      return {
        ...(result as Record<string, unknown>),
        universe: {
          kind: 'US_GLOBAL_MARKET_CAP_TOP30',
          source: input.source,
          sourceAccessedAt: input.sourceAccessedAt,
          fallback: input.fallback,
        },
      }
    })
  }

  async createReport(input: {
    userId: string
    providerId: SellPutProvider
    poolVersion: number
    observations: SellPutObservation[]
    runId?: string
    markdown?: string
    generationMode?: 'MODEL' | 'DETERMINISTIC_FALLBACK'
    modelErrorCode?: string | null
  }): Promise<unknown> {
    return this.transaction(async client => {
      const pool = await client.query<{ version: string }>(
        `SELECT version FROM changfu.sell_put_research_pools
          WHERE user_id = $1::bigint AND provider_id = $2 FOR UPDATE`,
        [input.userId, input.providerId],
      )
      if (Number(pool.rows[0]?.version ?? 0) !== input.poolVersion) {
        throw new SellPutResearchError('SELL_PUT_POOL_VERSION_CONFLICT')
      }
      const items = await client.query<{ symbol: string }>(
        `SELECT symbol
           FROM changfu.sell_put_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2
            AND status = 'ACTIVE'
          ORDER BY symbol`,
        [input.userId, input.providerId],
      )
      const expected = items.rows.map(row => row.symbol).sort()
      const actual = input.observations.map(item => item.symbol).sort()
      if (
        expected.length === 0
        || expected.length !== actual.length
        || expected.some((symbol, index) => symbol !== actual[index])
      ) {
        throw new SellPutResearchError('SELL_PUT_REPORT_POOL_MISMATCH')
      }

      const analysis = analyzeSellPutReport(input.observations)
      const runId = input.runId ?? randomUUID()
      const summary = {
        generatedAt: analysis.generatedAt,
        isUsableForAnalysis: analysis.isUsableForAnalysis,
        candidateCount: analysis.candidateCount,
        dataGapCount: analysis.dataGapCount,
        generationMode: input.generationMode ?? 'DETERMINISTIC_FALLBACK',
        modelErrorCode: input.modelErrorCode ?? null,
        topOpportunities: analysis.topOpportunities,
        bottomRisks: analysis.bottomRisks,
      }
      await client.query(
        `INSERT INTO changfu.sell_put_report_runs (
           run_id, user_id, provider_id, pool_version, report_window_days,
           prompt_version, status, symbol_count, candidate_count, data_gap_count,
           data_quality, summary, markdown, finished_at
         ) VALUES (
           $1::uuid, $2::bigint, $3, $4, 30, $5, 'COMPLETED', $6, $7, $8,
           $9::jsonb, $10::jsonb, $11, $12::timestamptz
         )`,
        [
          runId,
          input.userId,
          input.providerId,
          input.poolVersion,
          SELL_PUT_PROMPT_VERSION,
          input.observations.length,
          analysis.candidateCount,
          analysis.dataGapCount,
          JSON.stringify({
            isUsableForAnalysis: analysis.isUsableForAnalysis,
            issueCount: analysis.dataGapCount,
            generationMode: input.generationMode ?? 'DETERMINISTIC_FALLBACK',
            modelErrorCode: input.modelErrorCode ?? null,
          }),
          JSON.stringify(summary),
          input.markdown ?? analysis.markdown,
          analysis.generatedAt,
        ],
      )
      for (const item of analysis.items) {
        const observation = input.observations.find(value => value.symbol === item.symbol)!
        await client.query(
          `INSERT INTO changfu.sell_put_report_items (
             run_id, user_id, symbol, source_snapshot, analysis
           ) VALUES ($1::uuid, $2::bigint, $3, $4::jsonb, $5::jsonb)`,
          [runId, input.userId, item.symbol, JSON.stringify(observation), JSON.stringify(item)],
        )
      }
      return {
        runId,
        providerId: input.providerId,
        poolVersion: input.poolVersion,
        reportWindowDays: 30,
        promptVersion: SELL_PUT_PROMPT_VERSION,
        status: 'COMPLETED',
        symbolCount: input.observations.length,
        candidateCount: analysis.candidateCount,
        dataGapCount: analysis.dataGapCount,
        dataQuality: {
          isUsableForAnalysis: analysis.isUsableForAnalysis,
          issueCount: analysis.dataGapCount,
          generationMode: input.generationMode ?? 'DETERMINISTIC_FALLBACK',
          modelErrorCode: input.modelErrorCode ?? null,
        },
        summary,
        markdown: input.markdown ?? analysis.markdown,
        startedAt: analysis.generatedAt,
        finishedAt: analysis.generatedAt,
        errorCode: null,
        items: analysis.items.map(item => ({
          symbol: item.symbol,
          sourceSnapshot: input.observations.find(value => value.symbol === item.symbol)!,
          analysis: item,
        })),
      }
    })
  }

  async latestReport(userId: string, providerId: SellPutProvider): Promise<unknown | null> {
    const result = await this.pool.query<{ run_id: string }>(
      `SELECT run_id FROM changfu.sell_put_report_runs
        WHERE user_id = $1::bigint AND provider_id = $2
        ORDER BY started_at DESC LIMIT 1`,
      [userId, providerId],
    )
    return result.rows[0] ? this.getReport(userId, providerId, result.rows[0].run_id) : null
  }

  async reportHistory(input: {
    userId: string
    providerId: SellPutProvider
    page: number
    pageSize: number
  }): Promise<unknown> {
    const offset = (input.page - 1) * input.pageSize
    const [rows, count] = await Promise.all([
      this.pool.query(
        `SELECT run_id AS "runId", provider_id AS "providerId",
                pool_version::int AS "poolVersion", report_window_days AS "reportWindowDays",
                prompt_version AS "promptVersion", status, symbol_count AS "symbolCount",
                candidate_count AS "candidateCount", data_gap_count AS "dataGapCount",
                started_at AS "startedAt", finished_at AS "finishedAt"
           FROM changfu.sell_put_report_runs
          WHERE user_id = $1::bigint AND provider_id = $2
          ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
        [input.userId, input.providerId, input.pageSize, offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM changfu.sell_put_report_runs
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [input.userId, input.providerId],
      ),
    ])
    const total = Number(count.rows[0]?.total ?? 0)
    return {
      items: rows.rows,
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize),
    }
  }

  async getReport(
    userId: string,
    providerId: SellPutProvider,
    runId: string,
  ): Promise<unknown | null> {
    const [run, items] = await Promise.all([
      this.pool.query(
        `SELECT run_id AS "runId", provider_id AS "providerId",
                pool_version::int AS "poolVersion", report_window_days AS "reportWindowDays",
                prompt_version AS "promptVersion", status, symbol_count AS "symbolCount",
                candidate_count AS "candidateCount", data_gap_count AS "dataGapCount",
                data_quality AS "dataQuality", summary, markdown,
                error_code AS "errorCode", started_at AS "startedAt",
                finished_at AS "finishedAt"
           FROM changfu.sell_put_report_runs
          WHERE user_id = $1::bigint AND provider_id = $2 AND run_id = $3::uuid`,
        [userId, providerId, runId],
      ),
      this.pool.query(
        `SELECT item.symbol, item.source_snapshot AS "sourceSnapshot", item.analysis
           FROM changfu.sell_put_report_items item
           JOIN changfu.sell_put_report_runs run ON run.run_id = item.run_id
          WHERE item.user_id = $1::bigint AND run.provider_id = $2
            AND item.run_id = $3::uuid
          ORDER BY COALESCE((item.analysis->>'score')::numeric, -1) DESC, item.symbol`,
        [userId, providerId, runId],
      ),
    ])
    return run.rows[0] ? { ...run.rows[0], items: items.rows } : null
  }

  private async ensurePool(
    client: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    userId: string,
    providerId: SellPutProvider,
  ): Promise<void> {
    await client.query(
      `INSERT INTO changfu.sell_put_research_pools (user_id, provider_id)
       VALUES ($1::bigint, $2) ON CONFLICT (user_id, provider_id) DO NOTHING`,
      [userId, providerId],
    )
  }

  private async bumpPool(
    client: PoolClient,
    userId: string,
    providerId: SellPutProvider,
  ): Promise<void> {
    await client.query(
      `UPDATE changfu.sell_put_research_pools
          SET version = version + 1, updated_at = now()
        WHERE user_id = $1::bigint AND provider_id = $2`,
      [userId, providerId],
    )
  }

  private async getPoolWith(
    client: PoolClient,
    userId: string,
    providerId: SellPutProvider,
  ): Promise<unknown> {
    const pool = await client.query<{ version: string; updated_at: Date }>(
      `SELECT version, updated_at FROM changfu.sell_put_research_pools
        WHERE user_id = $1::bigint AND provider_id = $2`,
      [userId, providerId],
    )
    const items = await client.query(
      `SELECT item_id AS "itemId",
              row_number() OVER (ORDER BY added_at, symbol)::integer AS rank,
              symbol, display_name AS "displayName",
              market, added_at AS "addedAt"
         FROM changfu.sell_put_research_pool_items
        WHERE user_id = $1::bigint AND provider_id = $2 AND status = 'ACTIVE'
        ORDER BY added_at, symbol`,
      [userId, providerId],
    )
    return {
      providerId,
      version: Number(pool.rows[0]!.version),
      capacity: SELL_PUT_POOL_CAPACITY,
      items: items.rows,
      updatedAt: pool.rows[0]!.updated_at.toISOString(),
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
