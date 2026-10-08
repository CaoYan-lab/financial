import type { PublicSourceCache } from './publicSourceCache.js'

const secDataOrigin = 'https://data.sec.gov'
const secFilesOrigin = 'https://www.sec.gov'

const factConcepts = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  researchAndDevelopment: ['ResearchAndDevelopmentExpense'],
  sharesOutstanding: ['EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding'],
} as const

export type SecFactName = keyof typeof factConcepts

export type SecFactValue = {
  concept: string
  value: number
  unit: string
  filedAt: string
  periodStart: string | null
  periodEnd: string
  form: string
  fiscalYear: number | null
  fiscalPeriod: string | null
  accession: string
  frame: string | null
}

export type SecFilingEvent = {
  accession: string
  form: string
  filedAt: string
  acceptedAt: string | null
  periodEnd: string | null
  primaryDocument: string | null
  sourceUrl: string
}

export type SecCompanyResearch = {
  availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'
  cik: string | null
  facts: Partial<Record<SecFactName, SecFactValue>>
  events: SecFilingEvent[]
  dataGaps: string[]
  capturedAt: string
}

type SecTickerRecord = {
  cik_str?: number
  ticker?: string
  title?: string
}

type SecFactUnit = {
  val?: number
  start?: string
  end?: string
  filed?: string
  form?: string
  fy?: number
  fp?: string
  accn?: string
  frame?: string
}

type SecCompanyFacts = {
  facts?: {
    'us-gaap'?: Record<string, {
      units?: Record<string, SecFactUnit[]>
    }>
    dei?: Record<string, {
      units?: Record<string, SecFactUnit[]>
    }>
  }
}

type SecSubmissions = {
  filings?: {
    recent?: Record<string, unknown>
  }
}

export class SecResearchClient {
  constructor(
    private readonly cache: PublicSourceCache,
    private readonly fetcher: typeof fetch = fetch,
    private readonly userAgent = process.env.CHANGFU_SEC_USER_AGENT ?? '',
  ) {}

  async companyResearch(ticker: string, capturedAt = new Date()): Promise<SecCompanyResearch> {
    if (!validUserAgent(this.userAgent)) {
      return unavailable(capturedAt, 'SEC_USER_AGENT_NOT_CONFIGURED')
    }
    try {
      const cik = await this.cikForTicker(ticker, capturedAt)
      if (!cik) return unavailable(capturedAt, 'SEC_CIK_NOT_FOUND')
      const [factsEntry, submissionsEntry] = await Promise.all([
        this.cache.getOrFetch<SecCompanyFacts>({
          source: 'SEC',
          cacheKey: `companyfacts:${cik}:${tradingDate(capturedAt)}`,
          asOf: capturedAt,
          expiresAt: nextUtcDay(capturedAt),
          fetcher: () => this.fetchJson(`${secDataOrigin}/api/xbrl/companyfacts/CIK${cik}.json`),
        }),
        this.cache.getOrFetch<SecSubmissions>({
          source: 'SEC',
          cacheKey: `submissions:${cik}:${tradingDate(capturedAt)}`,
          asOf: capturedAt,
          expiresAt: nextUtcDay(capturedAt),
          fetcher: () => this.fetchJson(`${secDataOrigin}/submissions/CIK${cik}.json`),
        }),
      ])
      const facts = extractFactsAsOf(factsEntry.payload, capturedAt)
      const events = extractRecentEvents(submissionsEntry.payload, cik, capturedAt)
      const dataGaps = (Object.keys(factConcepts) as SecFactName[])
        .filter(name => facts[name] === undefined)
        .map(name => `SEC_FACT_MISSING:${name}`)
      if (events.length === 0) dataGaps.push('SEC_RECENT_FILINGS_MISSING')
      return {
        availability: dataGaps.length === 0 ? 'AVAILABLE' : 'PARTIAL',
        cik,
        facts,
        events,
        dataGaps,
        capturedAt: capturedAt.toISOString(),
      }
    } catch {
      return unavailable(capturedAt, 'SEC_REQUEST_FAILED')
    }
  }

  private async cikForTicker(ticker: string, capturedAt: Date): Promise<string | null> {
    const entry = await this.cache.getOrFetch<Record<string, SecTickerRecord>>({
      source: 'SEC',
      cacheKey: `company-tickers:${tradingDate(capturedAt)}`,
      asOf: capturedAt,
      expiresAt: nextUtcDay(capturedAt),
      fetcher: () => this.fetchJson(`${secFilesOrigin}/files/company_tickers.json`),
    })
    const expected = ticker.toUpperCase().replace('.', '-')
    const record = Object.values(entry.payload)
      .find(item => item.ticker?.toUpperCase() === expected)
    return typeof record?.cik_str === 'number'
      ? String(record.cik_str).padStart(10, '0')
      : null
  }

  private async fetchJson<T>(url: string): Promise<T> {
    if (!url.startsWith(`${secDataOrigin}/`) && !url.startsWith(`${secFilesOrigin}/`)) {
      throw new Error('SEC_URL_NOT_ALLOWED')
    }
    const response = await this.fetcher(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`SEC_HTTP_${response.status}`)
    return await response.json() as T
  }
}

export function extractFactsAsOf(
  companyFacts: SecCompanyFacts,
  capturedAt: Date,
): Partial<Record<SecFactName, SecFactValue>> {
  const result: Partial<Record<SecFactName, SecFactValue>> = {}
  for (const [name, concepts] of Object.entries(factConcepts) as Array<
    [SecFactName, readonly string[]]
  >) {
    for (const concept of concepts) {
      const taxonomy = concept.startsWith('Entity')
        ? companyFacts.facts?.dei
        : companyFacts.facts?.['us-gaap']
      const selected = selectLatestFactAsOf(
        concept,
        taxonomy?.[concept]?.units ?? {},
        capturedAt,
      )
      if (selected) {
        result[name] = selected
        break
      }
    }
  }
  return result
}

export function selectLatestFactAsOf(
  concept: string,
  units: Record<string, SecFactUnit[]>,
  capturedAt: Date,
): SecFactValue | null {
  const cutoff = capturedAt.getTime()
  const values = Object.entries(units).flatMap(([unit, entries]) => entries
    .filter(entry => (
      typeof entry.val === 'number'
      && Number.isFinite(entry.val)
      && typeof entry.filed === 'string'
      && Date.parse(entry.filed) <= cutoff
      && typeof entry.end === 'string'
      && typeof entry.form === 'string'
      && typeof entry.accn === 'string'
      && ['10-K', '10-Q', '8-K'].includes(entry.form)
    ))
    .map(entry => ({ unit, entry })))
    .sort((left, right) => (
      Date.parse(right.entry.filed!) - Date.parse(left.entry.filed!)
      || Date.parse(right.entry.end!) - Date.parse(left.entry.end!)
      || right.entry.accn!.localeCompare(left.entry.accn!)
    ))
  const selected = values[0]
  if (!selected) return null
  return {
    concept,
    value: selected.entry.val!,
    unit: selected.unit,
    filedAt: selected.entry.filed!,
    periodStart: selected.entry.start ?? null,
    periodEnd: selected.entry.end!,
    form: selected.entry.form!,
    fiscalYear: selected.entry.fy ?? null,
    fiscalPeriod: selected.entry.fp ?? null,
    accession: selected.entry.accn!,
    frame: selected.entry.frame ?? null,
  }
}

export function extractRecentEvents(
  submissions: SecSubmissions,
  cik: string,
  capturedAt: Date,
): SecFilingEvent[] {
  const recent = submissions.filings?.recent
  if (!recent) return []
  const accession = array(recent.accessionNumber)
  const forms = array(recent.form)
  const filed = array(recent.filingDate)
  const accepted = array(recent.acceptanceDateTime)
  const periods = array(recent.reportDate)
  const documents = array(recent.primaryDocument)
  const cutoff = capturedAt.getTime()
  return accession.flatMap((accessionValue, index) => {
    const form = textAt(forms, index)
    const filedAt = textAt(filed, index)
    if (
      !form
      || !filedAt
      || !['10-K', '10-Q', '8-K', '4'].includes(form)
      || Date.parse(filedAt) > cutoff
    ) return []
    const accessionId = String(accessionValue)
    const document = textAt(documents, index)
    return [{
      accession: accessionId,
      form: form === '4' ? 'Form 4' : form,
      filedAt,
      acceptedAt: textAt(accepted, index),
      periodEnd: textAt(periods, index),
      primaryDocument: document,
      sourceUrl: `${secFilesOrigin}/Archives/edgar/data/${Number(cik)}/${accessionId.replaceAll('-', '')}/${document ?? ''}`,
    }]
  }).slice(0, 100)
}

function validUserAgent(value: string): boolean {
  return value.length >= 8 && value.includes('@')
}

function unavailable(capturedAt: Date, reason: string): SecCompanyResearch {
  return {
    availability: 'UNAVAILABLE',
    cik: null,
    facts: {},
    events: [],
    dataGaps: [reason],
    capturedAt: capturedAt.toISOString(),
  }
}

function tradingDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function nextUtcDay(value: Date): Date {
  const date = new Date(value)
  date.setUTCHours(24, 0, 0, 0)
  return date
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function textAt(values: unknown[], index: number): string | null {
  const value = values[index]
  return typeof value === 'string' && value.length > 0 ? value : null
}
