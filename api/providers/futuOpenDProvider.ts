import { DATA_SOURCES, UNAVAILABLE } from '../../shared/constants.js'
import type { RawCompanyData, SourceStatusResponse, UniverseCompany } from '../../shared/types.js'
import { runPythonBridge, type PythonBridgeResult } from '../utils/runPythonBridge.js'
import type { DataProvider, MarketDataBundle } from './DataProvider.js'
import { fetchUniverseFromStockAnalysis } from './stockAnalysisUniverseProvider.js'

type FutuBridgeSource = {
  source: string
  url?: string
  accessedAt: string
  timestamp: string
}

type FutuStatusPayload = {
  ok: boolean
  futuPythonSdkAvailable: boolean
  futuOpenDAvailable: boolean
  futuOpenDLoggedIn: boolean
  optionsDataAvailable: boolean
  technicalDataAvailable: boolean
  missingCapabilities: string[]
}

type FutuSnapshotRow = Partial<RawCompanyData> & {
  ticker: string
  selectedOptionCode?: string
  selectedOptionStrike?: string
  selectedOptionExpiry?: string
  selectedOptionPremium?: string
  selectedOptionDelta?: string
  selectedOptionPremiumSource?: string
}

type FutuSnapshotPayload = {
  ok: boolean
  source: FutuBridgeSource
  rows: FutuSnapshotRow[]
  warnings: string[]
}

type BridgeRunner = <T>(
  scriptName: string,
  payload: unknown,
  options?: { timeoutMs?: number },
) => Promise<PythonBridgeResult<T>>

const FUTU_REPORT_SNAPSHOT_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.FUTU_REPORT_SNAPSHOT_TIMEOUT_MS || 240_000) || 240_000,
)
const FUTU_REPORT_QUOTE_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.FUTU_REPORT_QUOTE_TIMEOUT_MS || 30_000) || 30_000,
)

export class FutuOpenDProvider implements DataProvider {
  constructor(private readonly bridgeRunner: BridgeRunner = runPythonBridge) {}

  async getStatus(): Promise<SourceStatusResponse> {
    const bridge = await this.bridgeRunner<FutuStatusPayload>('futu_status.py', this.basePayload())
    const now = new Date().toISOString()

    if (!bridge.ok || !bridge.data) {
      return {
        futuOpenDAvailable: false,
        futuPythonSdkAvailable: false,
        futuOpenDLoggedIn: false,
        optionsDataAvailable: false,
        technicalDataAvailable: false,
        universePrimaryAvailable: true,
        universeFallbackAvailable: true,
        lastCheckedAt: now,
        missingCapabilities: [
          `Futu OpenD status check failed: ${bridge.error ?? 'unknown error'}`,
          bridge.stderr ?? '',
        ].filter(Boolean),
      }
    }

    return {
      futuOpenDAvailable: bridge.data.futuOpenDAvailable,
      futuPythonSdkAvailable: bridge.data.futuPythonSdkAvailable,
      futuOpenDLoggedIn: bridge.data.futuOpenDLoggedIn,
      optionsDataAvailable: bridge.data.optionsDataAvailable,
      technicalDataAvailable: bridge.data.technicalDataAvailable,
      universePrimaryAvailable: true,
      universeFallbackAvailable: true,
      lastCheckedAt: now,
      missingCapabilities: bridge.data.missingCapabilities ?? [],
    }
  }

  async fetchUniverse(asOfDate?: string): Promise<UniverseCompany[]> {
    return fetchUniverseFromStockAnalysis(asOfDate)
  }

  async fetchMarketSnapshot(universe: UniverseCompany[]): Promise<MarketDataBundle> {
    const timestamp = new Date().toISOString()
    const fallbackSource = {
      source: DATA_SOURCES.futuOpenD,
      url: DATA_SOURCES.futuDocs,
      accessedAt: timestamp,
      timestamp,
    }
    const tickers = universe.map((company) => company.ticker)
    const quoteBridge = await this.runSnapshotPhase('quotes', tickers, false, false, FUTU_REPORT_QUOTE_TIMEOUT_MS)

    if (!this.hasUsableBridgeData(quoteBridge)) {
      return {
        source: fallbackSource,
        warnings: this.bridgeWarnings('quotes', quoteBridge),
        rows: this.unavailableRows(universe, fallbackSource, 'unavailable - Futu OpenD bridge failed'),
      }
    }

    const rowByTicker = new Map<string, FutuSnapshotRow>()
    this.mergeAvailableRows(rowByTicker, quoteBridge.data.rows)
    const source = quoteBridge.data.source ?? fallbackSource
    const warnings = [...(quoteBridge.data.warnings ?? [])]

    const enrichmentPhases: Array<Promise<{ phase: string; bridge: PythonBridgeResult<FutuSnapshotPayload> }>> = []
    if (process.env.FUTU_ENABLE_TECHNICALS !== 'false') {
      enrichmentPhases.push(
        this.runSnapshotPhase('technicals', tickers, true, false, FUTU_REPORT_SNAPSHOT_TIMEOUT_MS)
          .then((bridge) => ({ phase: 'technicals', bridge })),
      )
    }
    if (process.env.FUTU_ENABLE_OPTIONS !== 'false') {
      enrichmentPhases.push(
        this.runSnapshotPhase('options', tickers, false, true, FUTU_REPORT_SNAPSHOT_TIMEOUT_MS)
          .then((bridge) => ({ phase: 'options', bridge })),
      )
    }
    const enrichmentResults = await Promise.all(enrichmentPhases)
    for (const { phase, bridge } of enrichmentResults) {
      if (this.hasUsableBridgeData(bridge)) {
        this.mergeAvailableRows(rowByTicker, bridge.data.rows)
        warnings.push(...(bridge.data.warnings ?? []))
      } else {
        warnings.push(...this.bridgeWarnings(phase, bridge))
      }
    }

    return {
      source,
      warnings,
      rows: universe.slice(0, 30).map((company) => this.normalizeRow(company, rowByTicker.get(company.ticker), source)),
    }
  }

  private async runSnapshotPhase(
    phase: string,
    tickers: string[],
    includeTechnicals: boolean,
    includeOptions: boolean,
    timeoutMs: number,
  ): Promise<PythonBridgeResult<FutuSnapshotPayload>> {
    const startedAt = Date.now()
    const bridge = await this.bridgeRunner<FutuSnapshotPayload>('futu_snapshot.py', {
      ...this.basePayload(),
      tickers,
      includeOptions,
      includeTechnicals,
    }, { timeoutMs })
    // #region debug-point E:bridge-result
    if (process.env.DEBUG_SERVER_URL) await fetch(process.env.DEBUG_SERVER_URL, { method: 'POST', body: JSON.stringify({ sessionId: 'cloud-report-queue', runId: process.env.DEBUG_RUN_ID || 'post-fix', hypothesisId: 'E', location: 'futuOpenDProvider.runSnapshotPhase', msg: '[DEBUG] Futu report bridge phase completed', data: { phase, ok: bridge.ok && bridge.data?.ok !== false, durationMs: Date.now() - startedAt, tickerCount: tickers.length, error: bridge.error ?? bridge.data?.warnings?.[0] ?? null }, ts: Date.now() }) }).catch(() => {})
    // #endregion
    return bridge
  }

  private hasUsableBridgeData(bridge: PythonBridgeResult<FutuSnapshotPayload>): bridge is PythonBridgeResult<FutuSnapshotPayload> & { data: FutuSnapshotPayload } {
    return bridge.ok && Boolean(bridge.data) && bridge.data?.ok !== false
  }

  private bridgeWarnings(phase: string, bridge: PythonBridgeResult<FutuSnapshotPayload>): string[] {
    return [
      `Futu OpenD ${phase} bridge failed: ${bridge.error ?? bridge.data?.warnings?.[0] ?? 'unknown error'}`,
      bridge.stderr ?? '',
    ].filter(Boolean)
  }

  private mergeAvailableRows(target: Map<string, FutuSnapshotRow>, rows: FutuSnapshotRow[]): void {
    for (const row of rows) {
      const merged = { ...(target.get(row.ticker) ?? { ticker: row.ticker }) }
      for (const [key, value] of Object.entries(row)) {
        if (value === undefined || value === null) continue
        if (typeof value === 'string' && value.toLowerCase().includes(UNAVAILABLE)) continue
        Object.assign(merged, { [key]: value })
      }
      target.set(row.ticker, merged)
    }
  }

  private basePayload() {
    return {
      host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
      port: Number(process.env.FUTU_OPEND_PORT || 11111),
    }
  }

  private normalizeRow(company: UniverseCompany, row: FutuSnapshotRow | undefined, source: FutuBridgeSource): RawCompanyData {
    return {
      rank: company.rank,
      ticker: company.ticker,
      companyName: company.companyName,
      country: company.country,
      currentPrice: row?.currentPrice ?? UNAVAILABLE,
      marketCap: row?.marketCap ?? company.marketCap ?? UNAVAILABLE,
      peRatio: row?.peRatio ?? UNAVAILABLE,
      rsi14: row?.rsi14 ?? UNAVAILABLE,
      ma50: row?.ma50 ?? UNAVAILABLE,
      ma200: row?.ma200 ?? UNAVAILABLE,
      ivRank: row?.ivRank ?? UNAVAILABLE,
      iv30: row?.iv30 ?? UNAVAILABLE,
      nextEarningsDate: row?.nextEarningsDate ?? UNAVAILABLE,
      capitalPerContract: row?.capitalPerContract ?? UNAVAILABLE,
      sevenDayNews: row?.sevenDayNews ?? UNAVAILABLE,
      selectedOptionCode: row?.selectedOptionCode ?? UNAVAILABLE,
      selectedOptionStrike: row?.selectedOptionStrike ?? UNAVAILABLE,
      selectedOptionExpiry: row?.selectedOptionExpiry ?? UNAVAILABLE,
      selectedOptionPremium: row?.selectedOptionPremium ?? UNAVAILABLE,
      selectedOptionDelta: row?.selectedOptionDelta ?? UNAVAILABLE,
      selectedOptionPremiumSource: row?.selectedOptionPremiumSource ?? UNAVAILABLE,
      trend20d: row?.trend20d ?? UNAVAILABLE,
      trend60d: row?.trend60d ?? UNAVAILABLE,
      trend120d: row?.trend120d ?? UNAVAILABLE,
      distanceTo52wHigh: row?.distanceTo52wHigh ?? UNAVAILABLE,
      distanceTo52wLow: row?.distanceTo52wLow ?? UNAVAILABLE,
      realizedVol30d: row?.realizedVol30d ?? UNAVAILABLE,
      source,
    }
  }

  private unavailableRows(universe: UniverseCompany[], source: FutuBridgeSource, reason: string): RawCompanyData[] {
    return universe.slice(0, 30).map((company) => ({
      rank: company.rank,
      ticker: company.ticker,
      companyName: company.companyName,
      country: company.country,
      currentPrice: UNAVAILABLE,
      marketCap: company.marketCap || UNAVAILABLE,
      peRatio: UNAVAILABLE,
      rsi14: UNAVAILABLE,
      ma50: UNAVAILABLE,
      ma200: UNAVAILABLE,
      ivRank: UNAVAILABLE,
      iv30: UNAVAILABLE,
      nextEarningsDate: UNAVAILABLE,
      capitalPerContract: UNAVAILABLE,
      sevenDayNews: reason,
      source,
    }))
  }
}
