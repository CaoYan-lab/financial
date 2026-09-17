const DEFAULT_CACHE_TTL_MS = 60_000
const TOTAL_CACHE_TTL_MS = 15 * 60_000
const DEFAULT_TIMEOUT_MS = 5_000
export const LONGBRIDGE_ACCOUNT_HISTORY_START_DATE = '2026-09-01'

type ProfitAnalysisSummary = {
  currency?: unknown
  startDate?: unknown
  start_date?: unknown
  endDate?: unknown
  end_date?: unknown
  sumProfit?: unknown
  sum_profit?: unknown
  updatedAt?: unknown
  updated_at?: unknown
}

export type LongbridgePnlHttpClient = {
  request(
    method: string,
    path: string,
    headers?: Record<string, string> | null,
    body?: unknown,
  ): Promise<ProfitAnalysisSummary>
}

export type LongbridgeAccountPnl = {
  value?: number
  currency: string
  startDate: string
  endDate: string
  updatedAt?: string
  error?: string
}

type CacheEntry = {
  expiresAt: number
  value?: LongbridgeAccountPnl
  inFlight?: Promise<LongbridgeAccountPnl>
}

const cache = new WeakMap<object, Map<string, CacheEntry>>()

export async function loadLongbridgeAccountTodayPnl(
  context: LongbridgePnlHttpClient,
  currency: string,
  options: {
    now?: Date
    force?: boolean
    cacheTtlMs?: number
    timeoutMs?: number
  } = {},
): Promise<LongbridgeAccountPnl> {
  const now = options.now ?? new Date()
  const tradingDate = now.toISOString().slice(0, 10)
  return loadLongbridgeAccountPnlRange(
    context,
    currency,
    tradingDate,
    tradingDate,
    options,
  )
}

export async function loadLongbridgeAccountTotalPnl(
  context: LongbridgePnlHttpClient,
  currency: string,
  options: {
    now?: Date
    force?: boolean
    cacheTtlMs?: number
    timeoutMs?: number
  } = {},
): Promise<LongbridgeAccountPnl> {
  const now = options.now ?? new Date()
  return loadLongbridgeAccountPnlRange(
    context,
    currency,
    LONGBRIDGE_ACCOUNT_HISTORY_START_DATE,
    now.toISOString().slice(0, 10),
    {
      ...options,
      cacheTtlMs: options.cacheTtlMs ?? TOTAL_CACHE_TTL_MS,
    },
  )
}

async function loadLongbridgeAccountPnlRange(
  context: LongbridgePnlHttpClient,
  currency: string,
  startDate: string,
  endDate: string,
  options: {
    now?: Date
    force?: boolean
    cacheTtlMs?: number
    timeoutMs?: number
  },
): Promise<LongbridgeAccountPnl> {
  const now = options.now ?? new Date()
  const normalizedCurrency = currency.trim().toUpperCase()
  const key = `${normalizedCurrency}:${startDate}:${endDate}`
  const entries = cache.get(context) ?? new Map<string, CacheEntry>()
  cache.set(context, entries)
  const existing = entries.get(key)

  if (!options.force && existing?.value && existing.expiresAt > now.getTime()) {
    return existing.value
  }

  const request = existing?.inFlight ?? requestAccountPnl(
    context,
    normalizedCurrency,
    startDate,
    endDate,
  ).then((value) => {
    entries.set(key, {
      expiresAt: Date.now() + (options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
      value,
    })
    return value
  })
  if (!existing?.inFlight) {
    entries.set(key, {
      expiresAt: existing?.expiresAt ?? 0,
      value: existing?.value,
      inFlight: request,
    })
  }

  return withTimeout(
    request,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    normalizedCurrency,
    startDate,
    endDate,
  )
}

async function requestAccountPnl(
  context: LongbridgePnlHttpClient,
  currency: string,
  startDate: string,
  endDate: string,
): Promise<LongbridgeAccountPnl> {
  try {
    const response = await context.request(
      'GET',
      profitAnalysisSummaryPath(startDate, endDate),
    )
    const summary = response
    const responseCurrency = String(summary?.currency ?? '').trim().toUpperCase()
    if (responseCurrency !== currency) {
      return unavailable(
        currency,
        startDate,
        endDate,
        `账户盈亏币种不匹配：${responseCurrency || '未知'}`,
      )
    }
    const responseStartDate = optionalText(summary.startDate ?? summary.start_date)
    const responseEndDate = optionalText(summary.endDate ?? summary.end_date)
    const startMatches = !responseStartDate || responseStartDate === startDate
    if (!startMatches || (responseEndDate && responseEndDate !== endDate)) {
      return unavailable(currency, startDate, endDate, '账户盈亏日期不匹配')
    }
    const value = optionalNumber(summary?.sumProfit ?? summary?.sum_profit)
    if (value === undefined) {
      return unavailable(currency, startDate, endDate, '账户盈亏字段缺失')
    }
    const updatedAt = optionalText(summary.updatedAt ?? summary.updated_at)
    return {
      value,
      currency,
      startDate: responseStartDate ?? startDate,
      endDate: responseEndDate ?? endDate,
      updatedAt,
    }
  } catch (error) {
    return unavailable(
      currency,
      startDate,
      endDate,
      error instanceof Error ? error.message : String(error),
    )
  }
}

function withTimeout(
  request: Promise<LongbridgeAccountPnl>,
  timeoutMs: number,
  currency: string,
  startDate: string,
  endDate: string,
): Promise<LongbridgeAccountPnl> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(unavailable(currency, startDate, endDate, '账户盈亏查询超时'))
    }, Math.max(100, timeoutMs))
    request.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        resolve(unavailable(
          currency,
          startDate,
          endDate,
          error instanceof Error ? error.message : String(error),
        ))
      },
    )
  })
}

function unavailable(
  currency: string,
  startDate: string,
  endDate: string,
  error: string,
): LongbridgeAccountPnl {
  return { currency, startDate, endDate, error }
}

function profitAnalysisSummaryPath(startDate: string, endDate: string): string {
  const start = Date.parse(`${startDate}T00:00:00Z`) / 1_000
  const end = Date.parse(`${endDate}T23:59:59Z`) / 1_000
  return `/v1/portfolio/profit-analysis-summary?start=${start}&end=${end}`
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || String(value).trim() === '') {
    return undefined
  }
  const parsed = Number(String(value))
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text || undefined
}
