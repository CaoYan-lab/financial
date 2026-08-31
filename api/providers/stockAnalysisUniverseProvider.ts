import { DATA_SOURCES, UNAVAILABLE } from '../../shared/constants.js'
import type { DataSourceCitation, UniverseCompany } from '../../shared/types.js'

const seedCompanies = [
  ['NVDA', 'NVIDIA', 'United States'],
  ['MSFT', 'Microsoft', 'United States'],
  ['AAPL', 'Apple', 'United States'],
  ['GOOG', 'Alphabet', 'United States'],
  ['AMZN', 'Amazon', 'United States'],
  ['META', 'Meta Platforms', 'United States'],
  ['AVGO', 'Broadcom', 'United States'],
  ['TSM', 'Taiwan Semiconductor Manufacturing', 'Taiwan'],
  ['BRK.B', 'Berkshire Hathaway', 'United States'],
  ['LLY', 'Eli Lilly', 'United States'],
  ['TSLA', 'Tesla', 'United States'],
  ['WMT', 'Walmart', 'United States'],
  ['JPM', 'JPMorgan Chase', 'United States'],
  ['V', 'Visa', 'United States'],
  ['ORCL', 'Oracle', 'United States'],
  ['MA', 'Mastercard', 'United States'],
  ['NFLX', 'Netflix', 'United States'],
  ['XOM', 'Exxon Mobil', 'United States'],
  ['COST', 'Costco Wholesale', 'United States'],
  ['JNJ', 'Johnson & Johnson', 'United States'],
  ['HD', 'Home Depot', 'United States'],
  ['PLTR', 'Palantir Technologies', 'United States'],
  ['PG', 'Procter & Gamble', 'United States'],
  ['ABBV', 'AbbVie', 'United States'],
  ['BAC', 'Bank of America', 'United States'],
  ['ASML', 'ASML Holding', 'Netherlands'],
  ['KO', 'Coca-Cola', 'United States'],
  ['SAP', 'SAP', 'Germany'],
  ['GE', 'GE Aerospace', 'United States'],
  ['CSCO', 'Cisco Systems', 'United States'],
] as const

function citation(url: string, timestamp = new Date().toISOString()): DataSourceCitation {
  return {
    source: 'StockAnalysis biggest companies universe',
    url,
    accessedAt: timestamp,
    timestamp,
  }
}

export async function fetchUniverseFromStockAnalysis(asOfDate?: string): Promise<UniverseCompany[]> {
  const timestamp = new Date().toISOString()
  const source = citation(DATA_SOURCES.universePrimary, timestamp)

  try {
    const response = await fetch(DATA_SOURCES.universePrimary)
    if (!response.ok) {
      throw new Error(`StockAnalysis returned ${response.status}`)
    }
    const html = await response.text()
    const rows = parseStockAnalysisRows(html, source)
    if (rows.length >= 30) {
      return rows
    }
  } catch {
    return seedCompanies.map(([ticker, companyName, country], index) => ({
      sourceRank: index + 1,
      rank: index + 1,
      ticker,
      companyName,
      country,
      marketCap: UNAVAILABLE,
      source: {
        ...source,
        source: `Mock universe fallback; live StockAnalysis unavailable; asOfDate=${asOfDate ?? 'today'}`,
      },
    }))
  }

  return seedCompanies.map(([ticker, companyName, country], index) => ({
    sourceRank: index + 1,
    rank: index + 1,
    ticker,
    companyName,
    country,
    marketCap: UNAVAILABLE,
    source,
  }))
}

function parseStockAnalysisRows(html: string, source: DataSourceCitation): UniverseCompany[] {
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
  const rows: UniverseCompany[] = []
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowPattern.exec(html))) {
    const cells = [...rowMatch[1].matchAll(cellPattern)].map((match) => cleanHtml(match[1]))
    if (cells.length < 4 || Number.isNaN(Number(cells[0]))) {
      continue
    }

    const tickerMatch = rowMatch[1].match(/\/stocks\/([a-z0-9.-]+)\//i)
    rows.push({
      sourceRank: Number(cells[0]),
      rank: Number(cells[0]),
      ticker: tickerMatch?.[1]?.toUpperCase() ?? cells[2],
      companyName: cells[1],
      country: UNAVAILABLE,
      marketCap: cells[3] ?? UNAVAILABLE,
      source,
    })
  }

  return rows
}

function cleanHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
