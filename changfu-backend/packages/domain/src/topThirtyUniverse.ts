export const TOP_THIRTY_UNIVERSE_SOURCE_URL = 'https://stockanalysis.com/list/biggest-companies/'

export type TopThirtyUniverseCompany = {
  rank: number
  ticker: string
  companyName: string
  marketCap: string
}

export type TopThirtyProvider = 'FUTU' | 'LONGBRIDGE'

const seedCompanies = [
  ['NVDA', 'NVIDIA'], ['MSFT', 'Microsoft'], ['AAPL', 'Apple'],
  ['GOOG', 'Alphabet'], ['AMZN', 'Amazon'], ['META', 'Meta Platforms'],
  ['AVGO', 'Broadcom'], ['TSM', 'Taiwan Semiconductor Manufacturing'],
  ['BRK.B', 'Berkshire Hathaway'], ['LLY', 'Eli Lilly'], ['TSLA', 'Tesla'],
  ['WMT', 'Walmart'], ['JPM', 'JPMorgan Chase'], ['V', 'Visa'],
  ['ORCL', 'Oracle'], ['MA', 'Mastercard'], ['NFLX', 'Netflix'],
  ['XOM', 'Exxon Mobil'], ['COST', 'Costco Wholesale'],
  ['JNJ', 'Johnson & Johnson'], ['HD', 'Home Depot'],
  ['PLTR', 'Palantir Technologies'], ['PG', 'Procter & Gamble'],
  ['ABBV', 'AbbVie'], ['BAC', 'Bank of America'], ['ASML', 'ASML Holding'],
  ['KO', 'Coca-Cola'], ['SAP', 'SAP'], ['GE', 'GE Aerospace'],
  ['CSCO', 'Cisco Systems'],
] as const

const shareClassGroups: Record<string, { group: string; preferredTicker: string }> = {
  GOOG: { group: 'Alphabet', preferredTicker: 'GOOG' },
  GOOGL: { group: 'Alphabet', preferredTicker: 'GOOG' },
  'BRK.A': { group: 'Berkshire Hathaway', preferredTicker: 'BRK.B' },
  'BRK.B': { group: 'Berkshire Hathaway', preferredTicker: 'BRK.B' },
}

const usTickerPattern = /^[A-Z][A-Z0-9]*(?:\.[A-Z])?$/
const usCrossListingByQuote = new Map([
  ['AMS:ASML', 'ASML'],
  ['CPH:NOVO.B', 'NVO'],
  ['ETR:SAP', 'SAP'],
  ['HKG:9988', 'BABA'],
  ['LON:AZN', 'AZN'],
  ['LON:SHEL', 'SHEL'],
  ['TPE:2330', 'TSM'],
  ['TYO:7203', 'TM'],
])

export function parseTopThirtyUniverse(html: string): TopThirtyUniverseCompany[] {
  const rows: TopThirtyUniverseCompany[] = []
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(html))) {
    const rowHtml = rowMatch[1]
    if (rowHtml === undefined) continue
    const cellHtml = [...rowHtml.matchAll(cellPattern)].map(match => match[1] ?? '')
    const rank = cleanHtml(cellHtml[0] ?? '')
    const companyCell = cellHtml[1]
    if (cellHtml.length < 4 || !companyCell || Number.isNaN(Number(rank))) continue

    const directTicker = companyCell
      .match(/href=["']\/stocks\/([a-z0-9.-]+)\//i)?.[1]?.toUpperCase()
    const quoteMatch = companyCell.match(
      /href=["']\/quote\/([a-z0-9.-]+)\/([a-z0-9.-]+)\//i,
    )
    const quoteKey = quoteMatch?.[1] && quoteMatch[2]
      ? `${quoteMatch[1].toUpperCase()}:${quoteMatch[2].toUpperCase()}`
      : null
    const ticker = directTicker ?? (quoteKey ? usCrossListingByQuote.get(quoteKey) : undefined)
    if (!ticker || !usTickerPattern.test(ticker)) continue

    const companyName = decodeHtmlAttribute(
      companyCell.match(/title=["']([^"']+)["']/i)?.[1] ?? '',
    )
    const marketCap = cleanHtml(cellHtml[2] ?? '')
    if (!companyName || !marketCap) continue
    rows.push({
      rank: Number(rank),
      ticker,
      companyName,
      marketCap,
    })
  }
  return rows
}

export function lockTopThirty(
  companies: TopThirtyUniverseCompany[],
): TopThirtyUniverseCompany[] {
  const selected = new Map<string, TopThirtyUniverseCompany>()
  const seenGroups = new Set<string>()
  for (const company of companies) {
    const ticker = company.ticker.toUpperCase()
    const shareClass = shareClassGroups[ticker]
    const group = shareClass?.group ?? ticker
    if (seenGroups.has(group)) {
      if (shareClass?.preferredTicker === ticker) {
        selected.set(group, {
          ...company,
          ticker,
          companyName: shareClass.group,
        })
      }
      continue
    }
    seenGroups.add(group)
    selected.set(group, {
      ...company,
      ticker: shareClass?.preferredTicker ?? ticker,
      companyName: shareClass?.group ?? company.companyName,
    })
    if (selected.size === 30) break
  }
  const locked = [...selected.values()].slice(0, 30).map((company, index) => ({
    ...company,
    rank: index + 1,
  }))
  if (locked.length !== 30) {
    throw new Error(`TOP30_INCOMPLETE:${locked.length}`)
  }
  return locked
}

export async function fetchTopThirty(
  fetcher: typeof fetch = fetch,
): Promise<{
  companies: TopThirtyUniverseCompany[]
  source: string
  accessedAt: string
  fallback: boolean
}> {
  const accessedAt = new Date().toISOString()
  try {
    const response = await fetcher(TOP_THIRTY_UNIVERSE_SOURCE_URL, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`HTTP_${response.status}`)
    const parsed = parseTopThirtyUniverse(await response.text())
    if (parsed.length < 30) throw new Error(`ROWS_${parsed.length}`)
    return {
      companies: lockTopThirty(parsed),
      source: TOP_THIRTY_UNIVERSE_SOURCE_URL,
      accessedAt,
      fallback: false,
    }
  } catch {
    return {
      companies: lockTopThirty(seedCompanies.map(([ticker, companyName], index) => ({
        rank: index + 1,
        ticker,
        companyName,
        marketCap: 'unavailable',
      }))),
      source: TOP_THIRTY_UNIVERSE_SOURCE_URL,
      accessedAt,
      fallback: true,
    }
  }
}

export function providerSymbol(providerId: TopThirtyProvider, ticker: string): string {
  return providerId === 'FUTU' ? `US.${ticker}` : `${ticker}.US`
}

export function canonicalTicker(symbol: string): string {
  if (symbol.startsWith('US.')) return symbol.slice(3).toUpperCase()
  if (symbol.endsWith('.US')) return symbol.slice(0, -3).toUpperCase()
  return symbol.toUpperCase()
}

function cleanHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlAttribute(value: string): string {
  return cleanHtml(value)
}
