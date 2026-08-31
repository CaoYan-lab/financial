import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { LiveCandidatePoolHistoryFilter, LiveCandidatePoolItem, LiveHistoryKind, LiveOrderConfirmation, LiveOrderResult, LivePendingOrder, LivePendingOrderSideFilter, LivePendingOrderStatusFilter, LiveSignalDirectionFilter, LiveSignalHistoryItem, LiveSignalLifecycleFilter, LiveSkippedTicker, LlmTradingDecision, SimulationHistoryPage } from '../../shared/types.js'
import type { LongbridgeStrategyMarketData } from '../../shared/longbridgeTypes.js'

type LongbridgeCandidateRecord = LiveCandidatePoolItem & {
  signal: LiveSignalHistoryItem
  decision: LlmTradingDecision
  marketData: Extract<LongbridgeStrategyMarketData, { ok: true }>
}

const MAX_ITEMS = 500
const MAX_PAGE_SIZE = 100
const DEFAULT_DB_PATH = resolve(process.cwd(), '.data', 'live-trading-history.sqlite3')
const PYTHON_SCRIPT_PATH = resolve(process.cwd(), 'api', 'longbridge', 'longbridge_live_history_db.py')
const PERSISTENCE_DISABLED = process.env.NODE_ENV === 'test' && process.env.LIVE_PERSIST_TEST !== '1'

type PayloadByKind = {
  signals: LiveSignalHistoryItem
  pending_orders: LivePendingOrder
  submitted_orders: LiveOrderResult
  rejected_orders: LivePendingOrder
  skipped: LiveSkippedTicker
  confirmations: LiveOrderConfirmation
  candidate_pool: LongbridgeCandidateRecord
  agent_runs: Record<string, unknown>
}

class LongbridgePersistence {
  private readonly filePath = process.env.LIVE_TRADING_HISTORY_DB_PATH || DEFAULT_DB_PATH
  private readonly signals: LiveSignalHistoryItem[] = []
  private readonly pendingOrders: LivePendingOrder[] = []
  private readonly candidatePool: LongbridgeCandidateRecord[] = []

  appendSignal(signal: LiveSignalHistoryItem) {
    if (!PERSISTENCE_DISABLED) {
      this.append('signals', signal, signal.generatedAt)
      return
    }
    this.signals.unshift(signal)
    this.signals.splice(MAX_ITEMS)
  }

  appendPendingOrder(order: LivePendingOrder) {
    if (!PERSISTENCE_DISABLED) {
      this.append('pending_orders', order, order.createdAt)
      return
    }
    this.pendingOrders.unshift(order)
    this.pendingOrders.splice(MAX_ITEMS)
  }

  appendSubmittedOrder(order: LiveOrderResult) {
    if (!PERSISTENCE_DISABLED) {
      this.append('submitted_orders', order, order.submittedAt)
    }
  }

  appendRejectedOrder(order: LivePendingOrder) {
    if (!PERSISTENCE_DISABLED) {
      this.append('rejected_orders', order, order.updatedAt ?? order.createdAt)
    }
  }

  appendSkipped(skipped: LiveSkippedTicker) {
    if (!PERSISTENCE_DISABLED) {
      this.append('skipped', skipped, skipped.updatedAt)
    }
  }

  appendConfirmation(confirmation: LiveOrderConfirmation) {
    if (!PERSISTENCE_DISABLED) {
      this.append('confirmations', confirmation, confirmation.confirmedAt)
    }
  }

  replacePendingOrder(order: LivePendingOrder) {
    if (!PERSISTENCE_DISABLED) {
      this.append('pending_orders', order, order.updatedAt ?? order.createdAt)
      return
    }
    const index = this.pendingOrders.findIndex((item) => item.id === order.id)
    if (index >= 0) this.pendingOrders[index] = order
    else this.appendPendingOrder(order)
  }

  appendCandidate(record: LongbridgeCandidateRecord) {
    if (!PERSISTENCE_DISABLED) {
      this.append('candidate_pool', record, record.lastSeenAt ?? record.firstSeenAt ?? new Date().toISOString())
      return
    }
    const index = this.candidatePool.findIndex((item) => item.candidateId === record.candidateId)
    if (index >= 0) this.candidatePool[index] = record
    else this.candidatePool.unshift(record)
    this.candidatePool.splice(MAX_ITEMS)
  }

  latestSignals() {
    if (!PERSISTENCE_DISABLED) return this.readLatest('signals', MAX_ITEMS)
    return [...this.signals]
  }

  latestPendingOrders() {
    if (!PERSISTENCE_DISABLED) return this.paginatePendingOrderLifecycle(1, MAX_ITEMS).items
    return [...this.pendingOrders]
  }

  activePendingOrders() {
    return this.latestPendingOrders().filter((order) => order.status === 'PENDING_CONFIRMATION' || order.status === 'CONFIRMED_SUBMITTING')
  }

  latestCandidates() {
    if (!PERSISTENCE_DISABLED) return dedupeCandidates(this.readLatest('candidate_pool', MAX_ITEMS))
    return [...this.candidatePool]
  }

  findPendingOrder(id: string) {
    if (!PERSISTENCE_DISABLED) return this.findByPayloadField<LivePendingOrder>('pending_orders', 'id', id)
    return this.pendingOrders.find((order) => order.id === id)
  }

  paginate<T>(items: T[], page = 1, pageSize = 20): SimulationHistoryPage<T> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 20))
    const total = items.length
    const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize))
    const start = (normalizedPage - 1) * normalizedPageSize
    return {
      items: items.slice(start, start + normalizedPageSize),
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total,
      totalPages,
    }
  }

  paginateKind(kind: LiveHistoryKind, page = 1, pageSize = 20) {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) {
      if (kind === 'signals') return this.paginate(this.signals, normalizedPage, normalizedPageSize)
      if (kind === 'pending_orders') return this.paginate(this.pendingOrders, normalizedPage, normalizedPageSize)
      if (kind === 'candidate_pool') return this.paginate(this.candidatePool, normalizedPage, normalizedPageSize)
      return emptyPage(normalizedPage, normalizedPageSize)
    }
    return this.runSqlite<SimulationHistoryPage<unknown>>({ action: 'paginate', kind, page: normalizedPage, pageSize: normalizedPageSize }) ?? emptyPage(normalizedPage, normalizedPageSize)
  }

  paginateSignalLifecycle(page: number, pageSize: number, direction: LiveSignalDirectionFilter | 'ALL' = 'ALL', lifecycleStatus: LiveSignalLifecycleFilter | 'ALL' = 'ALL', ticker = 'ALL'): SimulationHistoryPage<LiveSignalHistoryItem> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) return this.paginate(this.signals, normalizedPage, normalizedPageSize)
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

  paginatePendingOrderLifecycle(page: number, pageSize: number, status: LivePendingOrderStatusFilter | 'ALL' = 'ALL', ticker = 'ALL', side: LivePendingOrderSideFilter | 'ALL' = 'ALL'): SimulationHistoryPage<LivePendingOrder> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) return this.paginate(this.pendingOrders, normalizedPage, normalizedPageSize)
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

  paginateCandidatePoolHistory(page: number, pageSize: number, statusGroup: LiveCandidatePoolHistoryFilter = 'ACTIVE'): SimulationHistoryPage<LiveCandidatePoolItem> {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) {
      const items = this.candidatePool.filter((item) => {
        const active = ['ACTIVE', 'WATCH', 'PROMOTED'].includes(item.status)
        return statusGroup === 'ACTIVE' ? active : !active
      })
      return this.paginate(items, normalizedPage, normalizedPageSize)
    }
    return (
      this.runSqlite<SimulationHistoryPage<LiveCandidatePoolItem>>({
        action: 'paginate_candidate_pool_history',
        page: normalizedPage,
        pageSize: normalizedPageSize,
        statusGroup,
      }) ?? emptyPage(normalizedPage, normalizedPageSize)
    )
  }

  clearForTests() {
    if (!PERSISTENCE_DISABLED) {
      this.runSqlite({ action: 'clear' })
      return
    }
    this.signals.splice(0)
    this.pendingOrders.splice(0)
    this.candidatePool.splice(0)
  }

  private append<K extends LiveHistoryKind>(kind: K, payload: PayloadByKind[K], createdAt: string) {
    this.runSqlite({ action: 'append', kind, createdAt, payload })
  }

  private readLatest<K extends LiveHistoryKind>(kind: K, limit: number): PayloadByKind[K][] {
    const response = this.runSqlite<{ items: PayloadByKind[K][] }>({ action: 'read_latest', kind, limit })
    return response?.items ?? []
  }

  private findByPayloadField<T>(kind: LiveHistoryKind, field: 'id' | 'orderId' | 'signalId', value: string): T | undefined {
    if (!value) return undefined
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
      console.error(`Longbridge SQLite history bridge failed: ${result.stderr || result.stdout}`)
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
      console.error(`Longbridge SQLite history bridge failed: ${parsed.error ?? 'unknown error'}`)
      return undefined
    }
    return parsed
  }
}

export const longbridgePersistence = new LongbridgePersistence()
export type { LongbridgeCandidateRecord }

function emptyPage<T>(page: number, pageSize: number): SimulationHistoryPage<T> {
  return {
    items: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1,
  }
}

function dedupeCandidates(items: LongbridgeCandidateRecord[]) {
  const byId = new Map<string, LongbridgeCandidateRecord>()
  for (const item of items) {
    if (!byId.has(item.candidateId)) byId.set(item.candidateId, item)
  }
  return [...byId.values()]
}
