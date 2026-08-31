import type { RawCompanyData, ReportMarketContext, ReportMarketHeadline } from '../../shared/types.js'
import { errorMessage, logger } from '../utils/logger.js'

const MAX_TICKERS_WITH_HEADLINES = 12
const MAX_HEADLINES_PER_TICKER = 3

export async function collectReportMarketContext(rows: RawCompanyData[]): Promise<ReportMarketContext> {
  const generatedAt = new Date().toISOString()
  const tickers = rows.slice(0, MAX_TICKERS_WITH_HEADLINES).map((row) => row.ticker)
  const results = await Promise.all(tickers.map((ticker) => fetchYahooHeadlines(ticker)))
  const headlines = results.flatMap((result) => result.headlines)
  const warnings = results.flatMap((result) => result.warning ? [result.warning] : [])

  return {
    generatedAt,
    source: 'Yahoo Finance RSS headline search',
    headlines,
    warnings,
  }
}

async function fetchYahooHeadlines(ticker: string): Promise<{ headlines: ReportMarketHeadline[]; warning?: string }> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return { headlines: [], warning: `${ticker} headline search failed with HTTP ${response.status}.` }
    const text = await response.text()
    return { headlines: parseRssItems(text, ticker).slice(0, MAX_HEADLINES_PER_TICKER) }
  } catch (error) {
    const warning = `${ticker} headline search failed: ${errorMessage(error)}`
    logger.warn({ event: 'report.market_context.headline_failed', ticker, error: errorMessage(error) }, 'Report headline search failed')
    return { headlines: [], warning }
  }
}

function parseRssItems(xml: string, ticker: string): ReportMarketHeadline[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const item = match[1]
    return {
      ticker,
      title: decodeXml(extractTag(item, 'title')),
      url: decodeXml(extractTag(item, 'link')) || undefined,
      publishedAt: decodeXml(extractTag(item, 'pubDate')) || undefined,
      source: 'Yahoo Finance RSS',
    }
  }).filter((item) => item.title)
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return match?.[1]?.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() ?? ''
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
