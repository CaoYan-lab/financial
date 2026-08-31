import type { DataSourceCitation, RawCompanyData, SourceStatusResponse, UniverseCompany } from '../../shared/types.js'

export type MarketDataBundle = {
  rows: RawCompanyData[]
  source: DataSourceCitation
  warnings: string[]
}

export interface DataProvider {
  getStatus(): Promise<SourceStatusResponse>
  fetchUniverse(asOfDate?: string): Promise<UniverseCompany[]>
  fetchMarketSnapshot(universe: UniverseCompany[]): Promise<MarketDataBundle>
}

