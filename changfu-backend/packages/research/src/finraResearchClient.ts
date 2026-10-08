import type { PublicSourceCache } from './publicSourceCache.js'

const finraDailyOrigin = 'https://cdn.finra.org/equity/regsho/daily'

export type FinraShortVolumePoint = {
  date: string
  symbol: string
  shortVolume: number
  shortExemptVolume: number
  totalVolume: number
  shortVolumeRatio: number
  denominator: 'FINRA_CONSOLIDATED_REPORTED_TOTAL_VOLUME'
}

export type FinraShortMetrics = {
  availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'
  observations: number
  latest: FinraShortVolumePoint | null
  mean20: number | null
  mean60: number | null
  zScore60: number | null
  change5Day: number | null
  denominator: 'FINRA_CONSOLIDATED_REPORTED_TOTAL_VOLUME'
  dataGaps: string[]
  capturedAt: string
}

export class FinraResearchClient {
  constructor(
    private readonly cache: PublicSourceCache,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async shortVolume(
    ticker: string,
    capturedAt = new Date(),
    maximumTradingDays = 60,
  ): Promise<FinraShortMetrics> {
    const dates = recentWeekdays(capturedAt, Math.max(maximumTradingDays + 35, 90))
    const points: FinraShortVolumePoint[] = []
    for (const batch of chunks(dates, 10)) {
      const fetched = await Promise.all(batch.map(date => this.pointForDate(
        ticker,
        date,
        capturedAt,
      )))
      points.push(...fetched.filter((point): point is FinraShortVolumePoint => point !== null))
      if (points.length >= maximumTradingDays) break
    }
    return calculateFinraShortMetrics(
      points
        .sort((left, right) => right.date.localeCompare(left.date))
        .slice(0, maximumTradingDays),
      capturedAt,
    )
  }

  private async pointForDate(
    ticker: string,
    date: string,
    capturedAt: Date,
  ): Promise<FinraShortVolumePoint | null> {
    try {
      const immutableAt = new Date(`${date}T23:59:59.000Z`)
      const isLatestWindow = capturedAt.getTime() - immutableAt.getTime() < 3 * 86_400_000
      const entry = await this.cache.getOrFetch<string>({
        source: 'FINRA',
        cacheKey: `cnms-short-volume:${date}`,
        asOf: immutableAt,
        expiresAt: isLatestWindow
          ? nextUtcDay(capturedAt)
          : new Date('2100-01-01T00:00:00.000Z'),
        fetcher: () => this.fetchDailyFile(date),
      })
      return parseFinraShortVolume(entry.payload, ticker, date)
    } catch {
      return null
    }
  }

  private async fetchDailyFile(date: string): Promise<string> {
    const compactDate = date.replaceAll('-', '')
    const url = `${finraDailyOrigin}/CNMSshvol${compactDate}.txt`
    if (!url.startsWith(`${finraDailyOrigin}/`)) throw new Error('FINRA_URL_NOT_ALLOWED')
    const response = await this.fetcher(url, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`FINRA_HTTP_${response.status}`)
    return response.text()
  }
}

export function parseFinraShortVolume(
  content: string,
  ticker: string,
  date: string,
): FinraShortVolumePoint | null {
  const expected = ticker.toUpperCase().replace('.', '-')
  for (const line of content.split(/\r?\n/).slice(1)) {
    const [rawDate, symbol, shortVolume, shortExemptVolume, totalVolume] = line.split('|')
    if (symbol?.toUpperCase() !== expected) continue
    const short = Number(shortVolume)
    const exempt = Number(shortExemptVolume)
    const total = Number(totalVolume)
    if (
      !Number.isFinite(short)
      || !Number.isFinite(exempt)
      || !Number.isFinite(total)
      || total <= 0
    ) return null
    return {
      date: normalizeFinraDate(rawDate) ?? date,
      symbol: ticker.toUpperCase(),
      shortVolume: short,
      shortExemptVolume: exempt,
      totalVolume: total,
      shortVolumeRatio: short / total,
      denominator: 'FINRA_CONSOLIDATED_REPORTED_TOTAL_VOLUME',
    }
  }
  return null
}

export function calculateFinraShortMetrics(
  input: FinraShortVolumePoint[],
  capturedAt = new Date(),
): FinraShortMetrics {
  const points = [...input].sort((left, right) => right.date.localeCompare(left.date))
  const ratios = points.map(point => point.shortVolumeRatio)
  const latest = points[0] ?? null
  const mean20 = mean(ratios.slice(0, 20))
  const mean60 = mean(ratios.slice(0, 60))
  const standardDeviation60 = standardDeviation(ratios.slice(0, 60), mean60)
  const zScore60 = latest && mean60 !== null && standardDeviation60 !== null
    && standardDeviation60 > 0
    ? (latest.shortVolumeRatio - mean60) / standardDeviation60
    : null
  const change5Day = ratios[0] !== undefined && ratios[5] !== undefined
    ? ratios[0] - ratios[5]
    : null
  const dataGaps: string[] = []
  if (!latest) dataGaps.push('FINRA_SHORT_VOLUME_UNAVAILABLE')
  if (points.length < 20) dataGaps.push('FINRA_SHORT_VOLUME_LESS_THAN_20_DAYS')
  if (points.length < 60) dataGaps.push('FINRA_SHORT_VOLUME_LESS_THAN_60_DAYS')
  return {
    availability: points.length >= 60
      ? 'AVAILABLE'
      : points.length > 0 ? 'PARTIAL' : 'UNAVAILABLE',
    observations: points.length,
    latest,
    mean20,
    mean60,
    zScore60,
    change5Day,
    denominator: 'FINRA_CONSOLIDATED_REPORTED_TOTAL_VOLUME',
    dataGaps,
    capturedAt: capturedAt.toISOString(),
  }
}

function recentWeekdays(capturedAt: Date, count: number): string[] {
  const dates: string[] = []
  const cursor = new Date(capturedAt)
  cursor.setUTCHours(0, 0, 0, 0)
  while (dates.length < count) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return dates
}

function normalizeFinraDate(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function mean(values: number[]): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function standardDeviation(values: number[], average: number | null): number | null {
  if (values.length === 0 || average === null) return null
  const variance = values.reduce(
    (sum, value) => sum + ((value - average) ** 2),
    0,
  ) / values.length
  return Math.sqrt(variance)
}

function nextUtcDay(value: Date): Date {
  const date = new Date(value)
  date.setUTCHours(24, 0, 0, 0)
  return date
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}
