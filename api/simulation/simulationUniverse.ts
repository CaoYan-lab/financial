import type { SimulationUniverseItem } from '../../shared/types.js'

export const LLM_SIMULATION_UNIVERSE: SimulationUniverseItem[] = [
  { ticker: 'MU', label: 'Micron', assetType: 'STOCK' },
  { ticker: 'MULL', label: 'GraniteShares 2x Long MU Daily ETF', assetType: 'ETF', underlyingTicker: 'MU', leverageFactor: '2x long daily' },
  { ticker: 'NVDA', label: 'NVIDIA', assetType: 'STOCK' },
  { ticker: 'AMD', label: 'Advanced Micro Devices', assetType: 'STOCK' },
  { ticker: 'AMDL', label: 'GraniteShares 2x Long AMD Daily ETF', assetType: 'ETF', underlyingTicker: 'AMD', leverageFactor: '2x long daily' },
  { ticker: 'INTC', label: 'Intel', assetType: 'STOCK' },
  { ticker: 'INTW', label: 'GraniteShares 2x Long INTC Daily ETF', assetType: 'ETF', underlyingTicker: 'INTC', leverageFactor: '2x long daily' },
  { ticker: 'GOOG', label: 'Alphabet / Google-C', assetType: 'STOCK' },
  { ticker: 'AAPL', label: 'Apple', assetType: 'STOCK' },
  { ticker: 'TSM', label: 'TSMC ADR', assetType: 'STOCK' },
  { ticker: 'TSMU', label: 'GraniteShares 2x Long TSM Daily ETF', assetType: 'ETF', underlyingTicker: 'TSM', leverageFactor: '2x long daily' },
  { ticker: 'TSLA', label: 'Tesla', assetType: 'STOCK' },
  { ticker: 'SPCX', label: 'SpaceX', assetType: 'STOCK' },
  { ticker: 'SPCU', label: 'Defiance Daily Target 2X Long SpaceX ETF', assetType: 'ETF', underlyingTicker: 'SPCX', leverageFactor: '2x long daily' },
  { ticker: 'SNDK', label: 'SanDisk', assetType: 'STOCK' },
  { ticker: 'SNDU', label: 'T-REX 2x Long SanDisk Daily Target ETF', assetType: 'ETF', underlyingTicker: 'SNDK', leverageFactor: '2x long daily' },
  { ticker: 'TQQQ', label: 'ProShares UltraPro QQQ 3x Nasdaq-100 ETF', assetType: 'ETF', leverageFactor: '3x long daily' },
  { ticker: '09660', label: 'Horizon Robotics', assetType: 'STOCK', market: 'HK', futuCode: 'HK.09660', tradingCurrency: 'HKD' },
  { ticker: '07709', label: 'CSOP SK Hynix Daily Leveraged 2x Product', assetType: 'ETF', market: 'HK', futuCode: 'HK.07709', tradingCurrency: 'HKD', underlyingTicker: 'SK Hynix', leverageFactor: '2x long daily' },
  { ticker: '07747', label: 'CSOP Samsung Electronics Daily Leveraged 2x Product', assetType: 'ETF', market: 'HK', futuCode: 'HK.07747', tradingCurrency: 'HKD', underlyingTicker: 'Samsung Electronics', leverageFactor: '2x long daily' },
]

export function llmSimulationTickers(): string[] {
  return LLM_SIMULATION_UNIVERSE.map((item) => item.ticker)
}

export function isInLlmSimulationUniverse(ticker: string): boolean {
  const upper = ticker.toUpperCase()
  return LLM_SIMULATION_UNIVERSE.some((item) => item.ticker === upper)
}

export function llmUniverseItem(ticker: string): SimulationUniverseItem | undefined {
  const upper = ticker.toUpperCase()
  return LLM_SIMULATION_UNIVERSE.find((item) => item.ticker === upper)
}
