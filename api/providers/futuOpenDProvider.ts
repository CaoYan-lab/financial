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

type BridgeRunner = <T>(scriptName: string, payload: unknown) => Promise<PythonBridgeResult<T>>

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
    const bridge = await this.bridgeRunner<FutuSnapshotPayload>('futu_snapshot.py', {
      ...this.basePayload(),
      tickers: universe.map((company) => company.ticker),
      includeOptions: process.env.FUTU_ENABLE_OPTIONS !== 'false',
      includeTechnicals: process.env.FUTU_ENABLE_TECHNICALS !== 'false',
    })

    if (!bridge.ok || !bridge.data) {
      return {
        source: fallbackSource,
        warnings: [`Futu OpenD bridge failed: ${bridge.error ?? 'unknown error'}`, bridge.stderr ?? ''].filter(Boolean),
        rows: this.unavailableRows(universe, fallbackSource, 'unavailable - Futu OpenD bridge failed'),
      }
    }

    const rowByTicker = new Map(bridge.data.rows.map((row) => [row.ticker, row]))
    const source = bridge.data.source ?? fallbackSource

    return {
      source,
      warnings: bridge.data.warnings ?? [],
      rows: universe.slice(0, 30).map((company) => this.normalizeRow(company, rowByTicker.get(company.ticker), source)),
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
