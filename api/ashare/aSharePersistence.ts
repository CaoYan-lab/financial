import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type {
  AShareTradingAgentRun,
  LiveCandidatePoolItem,
  LiveHistoryKind,
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
  candidate_pool: LiveCandidatePoolItem
  agent_runs: AShareTradingAgentRun
}

const DEFAULT_DB_PATH = resolve(process.cwd(), '.data', 'a-share-live-history.sqlite3')
const PYTHON_SCRIPT_PATH = resolve(process.cwd(), 'api', 'futu_bridge', 'live_history_db.py')
const MAX_PAGE_SIZE = 100

class ASharePersistence {
  private readonly filePath = process.env.ASHARE_LIVE_HISTORY_DB_PATH || DEFAULT_DB_PATH

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

  appendConfirmation(confirmation: LiveOrderConfirmation) {
    this.append('confirmations', confirmation, confirmation.confirmedAt)
  }

  appendSkipped(skipped: LiveSkippedTicker) {
    this.append('skipped', skipped, skipped.updatedAt)
  }

  appendCandidate(candidate: LiveCandidatePoolItem) {
    this.append('candidate_pool', candidate, candidate.lastSeenAt)
  }

  appendAgentRun(run: AShareTradingAgentRun) {
    this.append('agent_runs', run, run.completedAt || run.startedAt)
  }

  readLatest(kind: 'signals', limit: number): QuantSignal[]
  readLatest(kind: 'pending_orders', limit: number): LivePendingOrder[]
  readLatest(kind: 'submitted_orders', limit: number): LiveOrderResult[]
  readLatest(kind: 'skipped', limit: number): LiveSkippedTicker[]
  readLatest(kind: 'candidate_pool', limit: number): LiveCandidatePoolItem[]
  readLatest(kind: 'agent_runs', limit: number): AShareTradingAgentRun[]
  readLatest(kind: LiveHistoryKind, limit: number) {
    const response = this.runSqlite<{ items: unknown[] }>({ action: 'read_latest', kind, limit })
    return response?.items ?? []
  }

  paginateSignals(page: number, pageSize: number, direction = 'ALL', lifecycleStatus = 'ALL', ticker = 'ALL'): SimulationHistoryPage<LiveSignalHistoryItem> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
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

  paginatePendingOrders(page: number, pageSize: number, status = 'ALL', ticker = 'ALL', side = 'ALL'): SimulationHistoryPage<LivePendingOrder> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
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

  paginateCandidatePool(page: number, pageSize: number, statusGroup = 'ACTIVE'): SimulationHistoryPage<LiveCandidatePoolItem> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    return (
      this.runSqlite<SimulationHistoryPage<LiveCandidatePoolItem>>({
        action: 'paginate_candidate_pool_history',
        page: normalizedPage,
        pageSize: normalizedPageSize,
        statusGroup,
      }) ?? emptyPage(normalizedPage, normalizedPageSize)
    )
  }

  paginateAgentRuns(page: number, pageSize: number): SimulationHistoryPage<AShareTradingAgentRun> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    return (
      this.runSqlite<SimulationHistoryPage<AShareTradingAgentRun>>({
        action: 'paginate',
        kind: 'agent_runs',
        page: normalizedPage,
        pageSize: normalizedPageSize,
      }) ?? emptyPage(normalizedPage, normalizedPageSize)
    )
  }

  private append(kind: LiveHistoryKind, payload: PayloadByKind[LiveHistoryKind], createdAt: string) {
    this.runSqlite({ action: 'append', kind, createdAt, payload })
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
      console.error(`A-share SQLite history bridge failed: ${result.stderr || result.stdout}`)
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
      console.error(`A-share SQLite history bridge failed: ${parsed.error ?? 'unknown error'}`)
      return undefined
    }
    return parsed
  }
}

export const aSharePersistence = new ASharePersistence()

function emptyPage<T>(page: number, pageSize: number): SimulationHistoryPage<T> {
  return { items: [], page, pageSize, total: 0, totalPages: 1 }
}
