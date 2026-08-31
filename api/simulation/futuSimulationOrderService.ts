import type { FutuSimulationOrdersResponse } from '../../shared/types.js'
import { runPythonBridge } from '../utils/runPythonBridge.js'
import { loadSimulationAccountDashboard } from './simulationAccountService.js'
import { isInLlmSimulationUniverse } from './simulationUniverse.js'

type FutuOrderQuery = {
  page?: number
  pageSize?: number
  startDate?: string
  endDate?: string
  ticker?: string
}

const FUTU_ORDER_CACHE_TTL_MS = 10_000
const futuOrderCache = new Map<string, { cachedAt: number; response: FutuSimulationOrdersResponse }>()

export async function loadFutuSimulationOrders(query: FutuOrderQuery = {}): Promise<FutuSimulationOrdersResponse> {
  const account = await loadSimulationAccountDashboard()
  const range = normalizeDateRange(query.startDate, query.endDate)
  const page = clampInteger(query.page, 1, 1_000_000, 1)
  const pageSize = clampInteger(query.pageSize, 1, 100, 12)
  const ticker = normalizeTicker(query.ticker)
  const cacheKey = JSON.stringify({ accountId: account.selectedAccountId, page, pageSize, startDate: range.startDate, endDate: range.endDate, ticker })
  const cached = futuOrderCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < FUTU_ORDER_CACHE_TTL_MS) return cached.response

  if (!account.ok || account.selectedAccountId === 'unavailable') {
    return emptyResponse(page, pageSize, range.startDate, range.endDate, 'unavailable', account.warnings[0] ?? '模拟账户不可用，无法查询 Futu 订单状态。')
  }

  const bridge = await runPythonBridge<FutuSimulationOrdersResponse>('futu_sim_orders.py', {
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: Number(process.env.FUTU_OPEND_PORT || 11111),
    accountId: account.selectedAccountId,
    page,
    pageSize,
    startDate: range.startDate,
    endDate: range.endDate,
    ticker,
  })
  const response =
    bridge.ok && bridge.data
      ? bridge.data
      : emptyResponse(page, pageSize, range.startDate, range.endDate, account.selectedAccountId, `Futu 订单状态查询失败：${bridge.error ?? 'unknown error'}`)
  futuOrderCache.set(cacheKey, { cachedAt: Date.now(), response })
  return response
}

export function normalizeFutuOrderQuery(query: FutuOrderQuery) {
  const range = normalizeDateRange(query.startDate, query.endDate)
  return {
    page: clampInteger(query.page, 1, 1_000_000, 1),
    pageSize: clampInteger(query.pageSize, 1, 100, 12),
    startDate: range.startDate,
    endDate: range.endDate,
    ticker: normalizeTicker(query.ticker),
  }
}

function normalizeTicker(ticker?: string): string | undefined {
  const normalized = ticker?.toUpperCase().trim()
  if (!normalized) return undefined
  return isInLlmSimulationUniverse(normalized) ? normalized : undefined
}

function normalizeDateRange(startDate?: string, endDate?: string) {
  const end = parseDate(endDate) ?? todayUtc()
  const start = parseDate(startDate) ?? addDays(end, -7)
  if (start.getTime() > end.getTime()) {
    return { startDate: formatDate(end), endDate: formatDate(start) }
  }
  return { startDate: formatDate(start), endDate: formatDate(end) }
}

function parseDate(value?: string): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) return undefined
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function todayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value as number)))
}

function emptyResponse(page: number, pageSize: number, startDate: string, endDate: string, accountId: string, warning: string): FutuSimulationOrdersResponse {
  return {
    ok: false,
    orders: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1,
    startDate,
    endDate,
    accountId,
    warnings: [warning],
  }
}
