import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type {
  LiveHistoryKind,
  LiveCandidatePoolHistoryFilter,
  LiveCandidatePoolItem,
  LiveOrderConfirmation,
  LiveOrderResult,
  LivePendingOrder,
  LiveSignalHistoryItem,
  LiveSkippedTicker,
  QuantSignal,
  SimulationHistoryPage,
} from '../../shared/types.js'

type PayloadByKind = {
  signals: QuantSignal
  pending_orders: LivePendingOrder
  submitted_orders: LiveOrderResult
  rejected_orders: LivePendingOrder
  skipped: LiveSkippedTicker
  confirmations: LiveOrderConfirmation
  candidate_pool: Record<string, unknown>
  agent_runs: Record<string, unknown>
}

const DEFAULT_DB_PATH = resolve(process.cwd(), '.data', 'live-trading-history.sqlite3')
const PYTHON_SCRIPT_PATH = resolve(process.cwd(), 'api', 'futu_bridge', 'live_history_db.py')
const MAX_PAGE_SIZE = 100
const PERSISTENCE_DISABLED = process.env.NODE_ENV === 'test' && process.env.LIVE_PERSIST_TEST !== '1'

class LivePersistence {
  private readonly filePath = process.env.LIVE_TRADING_HISTORY_DB_PATH || DEFAULT_DB_PATH

  appendSignal(signal: QuantSignal) {
    this.append('signals', signal, signal.generatedAt)
  }

  appendPendingOrder(order: LivePendingOrder) {
    this.append('pending_orders', order, order.createdAt)
  }

  appendSubmittedOrder(order: LiveOrderResult) {
    this.append('submitted_orders', order, order.submittedAt)
  }

  appendRejectedOrder(order: LivePendingOrder) {
    this.append('rejected_orders', order, order.updatedAt)
  }

  appendSkipped(skipped: LiveSkippedTicker) {
    this.append('skipped', skipped, skipped.updatedAt)
  }

  appendConfirmation(confirmation: LiveOrderConfirmation) {
    this.append('confirmations', confirmation, confirmation.confirmedAt)
  }

  appendCandidatePoolRecord(record: Record<string, unknown> & { updatedAt?: string; lastSeenAt?: string; createdAt?: string }) {
    this.append('candidate_pool', record, record.updatedAt ?? record.lastSeenAt ?? record.createdAt ?? new Date().toISOString())
  }

  readLatest(kind: 'signals', limit: number): QuantSignal[]
  readLatest(kind: 'pending_orders', limit: number): LivePendingOrder[]
  readLatest(kind: 'submitted_orders', limit: number): LiveOrderResult[]
  readLatest(kind: 'rejected_orders', limit: number): LivePendingOrder[]
  readLatest(kind: 'skipped', limit: number): LiveSkippedTicker[]
  readLatest(kind: 'confirmations', limit: number): LiveOrderConfirmation[]
  readLatest(kind: 'candidate_pool', limit: number): Record<string, unknown>[]
  readLatest(kind: LiveHistoryKind, limit: number) {
    if (PERSISTENCE_DISABLED) return []
    const response = this.runSqlite<{ items: unknown[] }>({ action: 'read_latest', kind, limit })
    return response?.items ?? []
  }

  paginate(kind: 'signals', page: number, pageSize: number): SimulationHistoryPage<QuantSignal>
  paginate(kind: 'pending_orders', page: number, pageSize: number): SimulationHistoryPage<LivePendingOrder>
  paginate(kind: 'submitted_orders', page: number, pageSize: number): SimulationHistoryPage<LiveOrderResult>
  paginate(kind: 'rejected_orders', page: number, pageSize: number): SimulationHistoryPage<LivePendingOrder>
  paginate(kind: 'skipped', page: number, pageSize: number): SimulationHistoryPage<LiveSkippedTicker>
  paginate(kind: 'confirmations', page: number, pageSize: number): SimulationHistoryPage<LiveOrderConfirmation>
  paginate(kind: 'candidate_pool', page: number, pageSize: number): SimulationHistoryPage<Record<string, unknown>>
  paginate(kind: LiveHistoryKind, page: number, pageSize: number) {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) return emptyPage(normalizedPage, normalizedPageSize)
    return this.runSqlite<SimulationHistoryPage<unknown>>({ action: 'paginate', kind, page: normalizedPage, pageSize: normalizedPageSize }) ?? emptyPage(normalizedPage, normalizedPageSize)
  }

  paginatePendingOrderLifecycle(page: number, pageSize: number, status = 'ALL', ticker = 'ALL', side = 'ALL'): SimulationHistoryPage<LivePendingOrder> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) return emptyPage(normalizedPage, normalizedPageSize)
    return (
      this.runSqlite<SimulationHistoryPage<LivePendingOrder>>({
        action: 'paginate_pending_order_lifecycle',
        page: normalizedPage,
        pageSize: normalizedPageSize,
        status,
        ticker,
        side,
      }) ?? emptyPage(normalizedPage, normalizedPageSize)
    )
  }

  paginateSignalLifecycle(page: number, pageSize: number, direction = 'ALL', lifecycleStatus = 'ALL', ticker = 'ALL'): SimulationHistoryPage<LiveSignalHistoryItem> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) return emptyPage(normalizedPage, normalizedPageSize)
    return (
      this.runSqlite<SimulationHistoryPage<LiveSignalHistoryItem>>({
        action: 'paginate_signal_lifecycle',
        page: normalizedPage,
        pageSize: normalizedPageSize,
        direction,
        lifecycleStatus,
        ticker,
      }) ?? emptyPage(normalizedPage, normalizedPageSize)
    )
  }

  paginateCandidatePoolHistory(page: number, pageSize: number, statusGroup: LiveCandidatePoolHistoryFilter = 'ACTIVE'): SimulationHistoryPage<LiveCandidatePoolItem> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) return emptyPage(normalizedPage, normalizedPageSize)
    return (
      this.runSqlite<SimulationHistoryPage<LiveCandidatePoolItem>>({
        action: 'paginate_candidate_pool_history',
        page: normalizedPage,
        pageSize: normalizedPageSize,
        statusGroup,
      }) ?? emptyPage(normalizedPage, normalizedPageSize)
    )
  }

  getPendingOrderByHistoryId(historyId: number): LivePendingOrder | undefined {
    return this.getByHistoryId<LivePendingOrder>('pending_orders', historyId)
  }

  findPendingOrderById(id: string): LivePendingOrder | undefined {
    if (!id) return undefined
    return this.findByPayloadField<LivePendingOrder>('pending_orders', 'id', id)
  }

  clearForTests() {
    if (PERSISTENCE_DISABLED) return
    this.runSqlite({ action: 'clear' })
  }

  private append(kind: LiveHistoryKind, payload: PayloadByKind[LiveHistoryKind], createdAt: string) {
    if (PERSISTENCE_DISABLED) return
    this.runSqlite({ action: 'append', kind, createdAt, payload })
  }

  private getByHistoryId<T>(kind: LiveHistoryKind, historyId: number): T | undefined {
    if (!Number.isFinite(historyId) || historyId <= 0) return undefined
    if (PERSISTENCE_DISABLED) return undefined
    const response = this.runSqlite<{ item?: T | null }>({ action: 'get_event_by_id', kind, id: Math.floor(historyId) })
    return response?.item ?? undefined
  }

  private findByPayloadField<T>(kind: LiveHistoryKind, field: 'id' | 'orderId' | 'signalId', value: string): T | undefined {
    if (PERSISTENCE_DISABLED) return undefined
    const response = this.runSqlite<{ item?: T | null }>({ action: 'find_event_by_payload_field', kind, field, value })
    return response?.item ?? undefined
  }

  private runSqlite<T>(payload: Record<string, unknown>): T | undefined {
    const pythonBin = process.env.FUTU_PYTHON_BIN || 'python3'
    const result = spawnSync(pythonBin, [PYTHON_SCRIPT_PATH], {
      input: JSON.stringify({ dbPath: this.filePath, ...payload }),
      encoding: 'utf8',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      maxBuffer: 20 * 1024 * 1024,
    })
    if (result.status !== 0) {
      console.error(`Live SQLite history bridge failed: ${result.stderr || result.stdout}`)
      return undefined
    }
    const jsonLine = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') && line.endsWith('}'))
      .at(-1)
    if (!jsonLine) return undefined
    const parsed = JSON.parse(jsonLine) as { ok: boolean; error?: string } & T
    if (!parsed.ok) {
      console.error(`Live SQLite history bridge failed: ${parsed.error ?? 'unknown error'}`)
      return undefined
    }
    return parsed
  }
}

export const livePersistence = new LivePersistence()

function emptyPage<T>(page: number, pageSize: number): SimulationHistoryPage<T> {
  return {
    items: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1,
  }
}
