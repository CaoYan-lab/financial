import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  analyzeQuantitativeItem,
  buildQuantitativeReport,
  compareQuantitativeReports,
  QUANT_POOL_CAPACITY,
  QUANT_PROMPT_VERSION,
  QUANT_SCORING_VERSION,
  type QuantitativeItemStatus,
  type QuantitativeItemResult,
  type QuantitativeObservation,
  type QuantitativeScoredInput,
} from '../../domain/src/quantitativeResearch.js'
import {
  providerSymbol,
  type TopThirtyProvider,
  type TopThirtyUniverseCompany,
} from '../../domain/src/topThirtyUniverse.js'

export type QuantitativeProvider = TopThirtyProvider

export class QuantitativeResearchError extends Error {
  constructor(readonly code: string) {
    super('量化研究模块状态冲突')
    this.name = 'QuantitativeResearchError'
  }
}

type StoredItem = {
  request_id: string
  status: QuantitativeItemStatus | 'PENDING'
  broker_observation: QuantitativeObservation | null
  model_result: unknown
  error_code: string | null
}

export class PostgresQuantitativeResearchRepository {
  constructor(private readonly pool: Pool) {}

  async syncTopThirty(input: {
    userId: string
    providerId: QuantitativeProvider
    companies: TopThirtyUniverseCompany[]
    source: string
    sourceAccessedAt: string
  }): Promise<unknown> {
    if (input.companies.length !== QUANT_POOL_CAPACITY) {
      throw new QuantitativeResearchError('QUANTITATIVE_TOP30_INCOMPLETE')
    }
    return this.transaction(async client => {
      await client.query(
        `INSERT INTO changfu.quantitative_research_pools (
           user_id, provider_id, universe_source, universe_accessed_at
         ) VALUES ($1::bigint, $2, $3, $4::timestamptz)
         ON CONFLICT (user_id, provider_id) DO NOTHING`,
        [input.userId, input.providerId, input.source, input.sourceAccessedAt],
      )
      const locked = await client.query<{ version: string }>(
        `SELECT version
           FROM changfu.quantitative_research_pools
          WHERE user_id = $1::bigint AND provider_id = $2
          FOR UPDATE`,
        [input.userId, input.providerId],
      )
      const previousVersion = Number(locked.rows[0]?.version ?? 0)
      const version = previousVersion + 1
      if (previousVersion < 1) {
        throw new QuantitativeResearchError('QUANTITATIVE_POOL_NOT_FOUND')
      }
      const symbols = input.companies.map(company => providerSymbol(input.providerId, company.ticker))
      if (new Set(symbols).size !== QUANT_POOL_CAPACITY) {
        throw new QuantitativeResearchError('QUANTITATIVE_TOP30_DUPLICATE')
      }
      await client.query(
        `UPDATE changfu.quantitative_research_pools
            SET version = $3, universe_source = $4,
                universe_accessed_at = $5::timestamptz, updated_at = now()
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [
          input.userId,
          input.providerId,
          version,
          input.source,
          input.sourceAccessedAt,
        ],
      )
      for (const company of input.companies) {
        await client.query(
          `INSERT INTO changfu.quantitative_research_pool_items (
             item_id, user_id, provider_id, pool_version, market_cap_rank,
             ticker, provider_symbol, display_name, market_cap_text
           ) VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8, $9)`,
          [
            randomUUID(),
            input.userId,
            input.providerId,
            version,
            company.rank,
            company.ticker,
            providerSymbol(input.providerId, company.ticker),
            company.companyName,
            company.marketCap,
          ],
        )
      }
      return this.getPoolWith(client, input.userId, input.providerId, version)
    })
  }

  async getPool(
    userId: string,
    providerId: QuantitativeProvider,
  ): Promise<unknown | null> {
    const pool = await this.pool.query<{ version: string }>(
      `SELECT version FROM changfu.quantitative_research_pools
        WHERE user_id = $1::bigint AND provider_id = $2`,
      [userId, providerId],
    )
    const version = Number(pool.rows[0]?.version ?? 0)
    return version > 0 ? this.getPoolWith(this.pool, userId, providerId, version) : null
  }

  async startRun(input: {
    userId: string
    providerId: QuantitativeProvider
    poolVersion: number
    modelProfile: string | null
    sourceStatus?: Record<string, unknown>
  }): Promise<unknown> {
    return this.transaction(async client => {
      const pool = await client.query<{ version: string }>(
        `SELECT version FROM changfu.quantitative_research_pools
          WHERE user_id = $1::bigint AND provider_id = $2 FOR UPDATE`,
        [input.userId, input.providerId],
      )
      if (Number(pool.rows[0]?.version ?? 0) !== input.poolVersion) {
        throw new QuantitativeResearchError('QUANTITATIVE_POOL_VERSION_CONFLICT')
      }
      const poolItems = await client.query<{
        market_cap_rank: number
        ticker: string
        provider_symbol: string
        display_name: string
      }>(
        `SELECT market_cap_rank, ticker, provider_symbol, display_name
           FROM changfu.quantitative_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2 AND pool_version = $3
          ORDER BY market_cap_rank`,
        [input.userId, input.providerId, input.poolVersion],
      )
      if (poolItems.rows.length !== QUANT_POOL_CAPACITY) {
        throw new QuantitativeResearchError('QUANTITATIVE_TOP30_INCOMPLETE')
      }
      const runId = randomUUID()
      try {
        await client.query(
          `INSERT INTO changfu.quantitative_report_runs (
             run_id, user_id, provider_id, pool_version, prompt_version,
             scoring_version, model_profile, status, source_status
           ) VALUES (
             $1::uuid, $2::bigint, $3, $4, $5, $6, $7, 'COLLECTING', $8::jsonb
           )`,
          [
            runId,
            input.userId,
            input.providerId,
            input.poolVersion,
            QUANT_PROMPT_VERSION,
            QUANT_SCORING_VERSION,
            input.modelProfile,
            JSON.stringify(input.sourceStatus ?? {}),
          ],
        )
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new QuantitativeResearchError('QUANTITATIVE_RUN_ALREADY_ACTIVE')
        }
        throw error
      }
      const items = []
      for (const item of poolItems.rows) {
        const requestId = randomUUID()
        await client.query(
          `INSERT INTO changfu.quantitative_report_items (
             run_id, user_id, provider_id, request_id, symbol, ticker,
             market_cap_rank, status
           ) VALUES ($1::uuid, $2::bigint, $3, $4::uuid, $5, $6, $7, 'PENDING')`,
          [
            runId,
            input.userId,
            input.providerId,
            requestId,
            item.provider_symbol,
            item.ticker,
            item.market_cap_rank,
          ],
        )
        items.push({
          requestId,
          rank: item.market_cap_rank,
          symbol: item.provider_symbol,
          ticker: item.ticker,
          displayName: item.display_name,
          status: 'PENDING',
        })
      }
      return {
        runId,
        providerId: input.providerId,
        poolVersion: input.poolVersion,
        promptVersion: QUANT_PROMPT_VERSION,
        scoringVersion: QUANT_SCORING_VERSION,
        status: 'COLLECTING',
        symbolCount: QUANT_POOL_CAPACITY,
        terminalCount: 0,
        items,
      }
    })
  }

  async runModelProfile(input: {
    userId: string
    providerId: QuantitativeProvider
    runId: string
    requestId: string
    symbol: string
    ticker: string
    rank: number
  }): Promise<string> {
    const result = await this.pool.query<{ model_profile: string | null }>(
      `SELECT run.model_profile
         FROM changfu.quantitative_report_runs run
         JOIN changfu.quantitative_report_items item ON item.run_id = run.run_id
        WHERE run.run_id = $1::uuid AND run.user_id = $2::bigint
          AND run.provider_id = $3 AND run.status IN ('COLLECTING', 'SCORING')
          AND item.request_id = $4::uuid AND item.symbol = $5
          AND item.ticker = $6 AND item.market_cap_rank = $7`,
      [
        input.runId,
        input.userId,
        input.providerId,
        input.requestId,
        input.symbol,
        input.ticker,
        input.rank,
      ],
    )
    const profile = result.rows[0]?.model_profile
    if (!profile) throw new QuantitativeResearchError('QUANTITATIVE_RUN_NOT_ACTIVE')
    return profile
  }

  async submitItem(input: {
    userId: string
    providerId: QuantitativeProvider
    runId: string
    requestId: string
    observation: QuantitativeObservation
    scoreResult?: unknown
    unavailableReason?: string
    rejectionReason?: string
  }): Promise<unknown> {
    if (
      input.observation.providerId !== input.providerId
      || input.observation.requestId !== input.requestId
    ) {
      throw new QuantitativeResearchError('QUANTITATIVE_ITEM_PROVIDER_MISMATCH')
    }
    const scoredInput: QuantitativeScoredInput = {
      observation: input.observation,
      ...(input.scoreResult === undefined ? {} : { scoreResult: input.scoreResult }),
      ...(input.unavailableReason === undefined
        ? {}
        : { unavailableReason: input.unavailableReason }),
      ...(input.rejectionReason === undefined
        ? {}
        : { rejectionReason: input.rejectionReason }),
    }
    const analysis = analyzeQuantitativeItem(scoredInput)
    return this.transaction(async client => {
      const updated = await client.query(
        `UPDATE changfu.quantitative_report_items item
            SET status = $6, broker_observation = $7::jsonb,
                official_evidence = $8::jsonb, model_result = $9::jsonb,
                analysis = $10::jsonb, error_code = $11,
                attempts = attempts + 1, updated_at = now(), finished_at = now()
           FROM changfu.quantitative_report_runs run
          WHERE item.run_id = run.run_id
            AND item.run_id = $1::uuid AND item.user_id = $2::bigint
            AND item.provider_id = $3 AND item.request_id = $4::uuid
            AND item.symbol = $5 AND item.ticker = $12
            AND item.market_cap_rank = $13 AND item.status = 'PENDING'
            AND run.user_id = $2::bigint AND run.provider_id = $3
            AND run.status IN ('COLLECTING', 'SCORING')
        RETURNING item.request_id`,
        [
          input.runId,
          input.userId,
          input.providerId,
          input.requestId,
          input.observation.symbol,
          analysis.status,
          JSON.stringify(input.observation),
          JSON.stringify(input.observation.evidence),
          input.scoreResult === undefined ? null : JSON.stringify(input.scoreResult),
          JSON.stringify(analysis),
          analysis.rejectionReason,
          input.observation.ticker,
          input.observation.rank,
        ],
      )
      if (updated.rowCount !== 1) {
        const existing = await client.query<{ status: string; analysis: unknown }>(
          `SELECT status, analysis
             FROM changfu.quantitative_report_items
            WHERE run_id = $1::uuid AND user_id = $2::bigint
              AND provider_id = $3 AND request_id = $4::uuid`,
          [input.runId, input.userId, input.providerId, input.requestId],
        )
        if (existing.rows[0]?.status && existing.rows[0].status !== 'PENDING') {
          const progress = await this.refreshProgress(client, input.runId)
          return { analysis: existing.rows[0].analysis, progress }
        }
        throw new QuantitativeResearchError('QUANTITATIVE_ITEM_CONFLICT')
      }
      const progress = await this.refreshProgress(client, input.runId)
      return { analysis, progress }
    })
  }

  async finalizeRun(input: {
    userId: string
    providerId: QuantitativeProvider
    runId: string
    markdown?: string
  }): Promise<unknown> {
    return this.transaction(async client => {
      const run = await client.query<{ status: string }>(
        `SELECT status FROM changfu.quantitative_report_runs
          WHERE run_id = $1::uuid AND user_id = $2::bigint AND provider_id = $3
          FOR UPDATE`,
        [input.runId, input.userId, input.providerId],
      )
      if (run.rows[0]?.status === 'COMPLETED') {
        return this.getReportWith(client, input.userId, input.providerId, input.runId)
      }
      if (!run.rows[0] || !['COLLECTING', 'SCORING', 'FINALIZING'].includes(run.rows[0].status)) {
        throw new QuantitativeResearchError('QUANTITATIVE_RUN_NOT_ACTIVE')
      }
      const stored = await client.query<StoredItem>(
        `SELECT request_id, status, broker_observation, model_result, error_code
           FROM changfu.quantitative_report_items
          WHERE run_id = $1::uuid ORDER BY market_cap_rank`,
        [input.runId],
      )
      if (
        stored.rows.length !== QUANT_POOL_CAPACITY
        || stored.rows.some(item => item.status === 'PENDING' || item.broker_observation === null)
      ) {
        throw new QuantitativeResearchError('QUANTITATIVE_RUN_INCOMPLETE')
      }
      await client.query(
        `UPDATE changfu.quantitative_report_runs
            SET status = 'FINALIZING', updated_at = now()
          WHERE run_id = $1::uuid`,
        [input.runId],
      )
      const report = buildQuantitativeReport(stored.rows.map(item => ({
        observation: item.broker_observation!,
        ...(item.status === 'UNAVAILABLE'
          ? { unavailableReason: item.error_code ?? 'BROKER_OBSERVATION_UNAVAILABLE' }
          : item.status === 'REJECTED'
            ? { rejectionReason: item.error_code ?? 'MODEL_SCORE_REJECTED' }
            : { scoreResult: item.model_result }),
      })))
      for (const item of report.items) {
        await client.query(
          `UPDATE changfu.quantitative_report_items
              SET analysis = $2::jsonb, updated_at = now()
            WHERE run_id = $1::uuid AND request_id = $3::uuid`,
          [input.runId, JSON.stringify(item), item.requestId],
        )
      }
      const summary = {
        generatedAt: report.generatedAt,
        topFive: report.topFive,
        watchlist: report.watchlist,
        bottomFive: report.bottomFive,
        insufficient: report.insufficient,
      }
      const sourceStatus = Object.fromEntries(
        (['SEC', 'FINRA', input.providerId] as const).map(source => {
          const supportedItems = stored.rows.filter(item => (
            item.broker_observation?.evidence.some(evidence => evidence.source === source)
          )).length
          return [source, {
            status: supportedItems === QUANT_POOL_CAPACITY
              ? 'AVAILABLE'
              : supportedItems > 0 ? 'PARTIAL' : 'UNAVAILABLE',
            supportedItems,
          }]
        }),
      )
      await client.query(
        `UPDATE changfu.quantitative_report_runs
            SET status = 'COMPLETED', terminal_count = 30,
                completed_count = $2, rejected_count = $3,
                unavailable_count = $4, candidate_count = $5,
                data_gap_count = $6, summary = $7::jsonb, markdown = $8,
                source_status = $10::jsonb,
                updated_at = now(), finished_at = $9::timestamptz
          WHERE run_id = $1::uuid`,
        [
          input.runId,
          report.completedCount,
          report.rejectedCount,
          report.unavailableCount,
          report.candidateCount,
          report.dataGapCount,
          JSON.stringify(summary),
          input.markdown ?? report.markdown,
          report.generatedAt,
          JSON.stringify(sourceStatus),
        ],
      )
      return this.getReportWith(client, input.userId, input.providerId, input.runId)
    })
  }

  async getReport(
    userId: string,
    providerId: QuantitativeProvider,
    runId: string,
  ): Promise<unknown | null> {
    return this.getReportWith(this.pool, userId, providerId, runId)
  }

  async latestReport(
    userId: string,
    providerId: QuantitativeProvider,
  ): Promise<unknown | null> {
    const result = await this.pool.query<{ run_id: string }>(
      `SELECT run_id FROM changfu.quantitative_report_runs
        WHERE user_id = $1::bigint AND provider_id = $2 AND status = 'COMPLETED'
        ORDER BY started_at DESC LIMIT 1`,
      [userId, providerId],
    )
    return result.rows[0]
      ? this.getReport(userId, providerId, result.rows[0].run_id)
      : null
  }

  async activeRun(
    userId: string,
    providerId: QuantitativeProvider,
  ): Promise<unknown | null> {
    const result = await this.pool.query<{ run_id: string }>(
      `SELECT run_id FROM changfu.quantitative_report_runs
        WHERE user_id = $1::bigint AND provider_id = $2
          AND status IN ('COLLECTING', 'SCORING', 'FINALIZING')
        ORDER BY started_at DESC LIMIT 1`,
      [userId, providerId],
    )
    return result.rows[0]
      ? this.getReport(userId, providerId, result.rows[0].run_id)
      : null
  }

  async cancelRun(input: {
    userId: string
    providerId: QuantitativeProvider
    runId: string
  }): Promise<unknown> {
    const result = await this.pool.query(
      `UPDATE changfu.quantitative_report_runs
          SET status = 'CANCELLED', updated_at = now(), finished_at = now()
        WHERE run_id = $1::uuid AND user_id = $2::bigint AND provider_id = $3
          AND status IN ('COLLECTING', 'SCORING', 'FINALIZING')
      RETURNING run_id`,
      [input.runId, input.userId, input.providerId],
    )
    if (result.rowCount !== 1) {
      throw new QuantitativeResearchError('QUANTITATIVE_RUN_NOT_ACTIVE')
    }
    return { runId: input.runId, status: 'CANCELLED' }
  }

  async reportHistory(input: {
    userId: string
    providerId: QuantitativeProvider
    page: number
    pageSize: number
  }): Promise<unknown> {
    const offset = (input.page - 1) * input.pageSize
    const [rows, count] = await Promise.all([
      this.pool.query(
        `SELECT run_id AS "runId", provider_id AS "providerId",
                pool_version::int AS "poolVersion",
                prompt_version AS "promptVersion", scoring_version AS "scoringVersion",
                model_profile AS "modelProfile", status,
                symbol_count AS "symbolCount", terminal_count AS "terminalCount",
                candidate_count AS "candidateCount", data_gap_count AS "dataGapCount",
                started_at AS "startedAt", finished_at AS "finishedAt"
           FROM changfu.quantitative_report_runs
          WHERE user_id = $1::bigint AND provider_id = $2
          ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
        [input.userId, input.providerId, input.pageSize, offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM changfu.quantitative_report_runs
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

  async compareReports(input: {
    userId: string
    leftProviderId: QuantitativeProvider
    leftRunId: string
    rightProviderId: QuantitativeProvider
    rightRunId: string
  }): Promise<unknown> {
    if (input.leftProviderId === input.rightProviderId) {
      throw new QuantitativeResearchError('QUANTITATIVE_COMPARE_PROVIDER_MUST_DIFFER')
    }
    const reports = await this.pool.query<{
      run_id: string
      provider_id: QuantitativeProvider
      prompt_version: string
      scoring_version: string
    }>(
      `SELECT run_id, provider_id, prompt_version, scoring_version
         FROM changfu.quantitative_report_runs
        WHERE user_id = $1::bigint
          AND (
            (run_id = $2::uuid AND provider_id = $3)
            OR (run_id = $4::uuid AND provider_id = $5)
          )
          AND status = 'COMPLETED'`,
      [
        input.userId,
        input.leftRunId,
        input.leftProviderId,
        input.rightRunId,
        input.rightProviderId,
      ],
    )
    if (reports.rows.length !== 2) {
      throw new QuantitativeResearchError('QUANTITATIVE_COMPARE_REPORT_NOT_FOUND')
    }
    const items = await this.pool.query<{
      run_id: string
      analysis: QuantitativeItemResult
    }>(
      `SELECT run_id, analysis
         FROM changfu.quantitative_report_items
        WHERE user_id = $1::bigint AND run_id IN ($2::uuid, $3::uuid)
        ORDER BY market_cap_rank`,
      [input.userId, input.leftRunId, input.rightRunId],
    )
    const left = reports.rows.find(row => row.run_id === input.leftRunId)!
    const right = reports.rows.find(row => row.run_id === input.rightRunId)!
    return compareQuantitativeReports({
      runId: left.run_id,
      providerId: left.provider_id,
      promptVersion: left.prompt_version,
      scoringVersion: left.scoring_version,
      items: items.rows
        .filter(item => item.run_id === left.run_id)
        .map(item => item.analysis),
    }, {
      runId: right.run_id,
      providerId: right.provider_id,
      promptVersion: right.prompt_version,
      scoringVersion: right.scoring_version,
      items: items.rows
        .filter(item => item.run_id === right.run_id)
        .map(item => item.analysis),
    })
  }

  private async refreshProgress(client: PoolClient, runId: string): Promise<unknown> {
    const counts = await client.query<{
      terminal_count: number
      completed_count: number
      rejected_count: number
      unavailable_count: number
    }>(
      `SELECT
         count(*) FILTER (WHERE status <> 'PENDING')::int AS terminal_count,
         count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_count,
         count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected_count,
         count(*) FILTER (WHERE status = 'UNAVAILABLE')::int AS unavailable_count
       FROM changfu.quantitative_report_items WHERE run_id = $1::uuid`,
      [runId],
    )
    const progress = counts.rows[0]!
    await client.query(
      `UPDATE changfu.quantitative_report_runs
          SET status = CASE WHEN $2 < 30 THEN 'SCORING' ELSE status END,
              terminal_count = $2, completed_count = $3,
              rejected_count = $4, unavailable_count = $5, updated_at = now()
        WHERE run_id = $1::uuid`,
      [
        runId,
        progress.terminal_count,
        progress.completed_count,
        progress.rejected_count,
        progress.unavailable_count,
      ],
    )
    return {
      terminalCount: progress.terminal_count,
      completedCount: progress.completed_count,
      rejectedCount: progress.rejected_count,
      unavailableCount: progress.unavailable_count,
    }
  }

  private async getPoolWith(
    client: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    userId: string,
    providerId: QuantitativeProvider,
    version: number,
  ): Promise<unknown> {
    const [pool, items] = await Promise.all([
      client.query(
        `SELECT version::int AS version, universe_source AS "universeSource",
                universe_accessed_at AS "universeAccessedAt", updated_at AS "updatedAt"
           FROM changfu.quantitative_research_pools
          WHERE user_id = $1::bigint AND provider_id = $2`,
        [userId, providerId],
      ),
      client.query(
        `SELECT item_id AS "itemId", market_cap_rank AS rank, ticker,
                provider_symbol AS symbol, display_name AS "displayName",
                market_cap_text AS "marketCap"
           FROM changfu.quantitative_research_pool_items
          WHERE user_id = $1::bigint AND provider_id = $2 AND pool_version = $3
          ORDER BY market_cap_rank`,
        [userId, providerId, version],
      ),
    ])
    return {
      providerId,
      capacity: QUANT_POOL_CAPACITY,
      ...pool.rows[0],
      items: items.rows,
    }
  }

  private async getReportWith(
    client: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    userId: string,
    providerId: QuantitativeProvider,
    runId: string,
  ): Promise<unknown | null> {
    const [run, items] = await Promise.all([
      client.query(
        `SELECT run_id AS "runId", provider_id AS "providerId",
                pool_version::int AS "poolVersion",
                prompt_version AS "promptVersion", scoring_version AS "scoringVersion",
                model_profile AS "modelProfile", status,
                symbol_count AS "symbolCount", terminal_count AS "terminalCount",
                completed_count AS "completedCount", rejected_count AS "rejectedCount",
                unavailable_count AS "unavailableCount",
                candidate_count AS "candidateCount", data_gap_count AS "dataGapCount",
                source_status AS "sourceStatus", summary, markdown,
                error_code AS "errorCode", started_at AS "startedAt",
                finished_at AS "finishedAt"
           FROM changfu.quantitative_report_runs
          WHERE run_id = $1::uuid AND user_id = $2::bigint AND provider_id = $3`,
        [runId, userId, providerId],
      ),
      client.query(
        `SELECT item.request_id AS "requestId", item.symbol, item.ticker,
                item.market_cap_rank AS rank, item.status,
                item.broker_observation AS "brokerObservation",
                item.official_evidence AS "officialEvidence", item.analysis,
                item.error_code AS "errorCode", item.attempts,
                item.updated_at AS "updatedAt",
                COALESCE(
                  item.broker_observation->>'displayName',
                  pool_item.display_name
                ) AS "displayName"
           FROM changfu.quantitative_report_items item
           JOIN changfu.quantitative_report_runs run ON run.run_id = item.run_id
           LEFT JOIN changfu.quantitative_research_pool_items pool_item
             ON pool_item.user_id = item.user_id
            AND pool_item.provider_id = item.provider_id
            AND pool_item.pool_version = run.pool_version
            AND pool_item.ticker = item.ticker
          WHERE item.run_id = $1::uuid AND item.user_id = $2::bigint
            AND item.provider_id = $3
          ORDER BY COALESCE((item.analysis->>'finalRank')::int, 2147483647),
                   item.market_cap_rank`,
        [runId, userId, providerId],
      ),
    ])
    return run.rows[0] ? { ...run.rows[0], items: items.rows } : null
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
