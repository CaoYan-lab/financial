import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { QuantSignal, SimulatedOrderResult, SimulationHistoryKind, SimulationHistoryPage, SimulationSkippedTicker } from '../../shared/types.js'

type PayloadByKind = {
  signals: QuantSignal
  orders: SimulatedOrderResult
  skipped: SimulationSkippedTicker
}

const DEFAULT_DB_PATH = resolve(process.cwd(), '.data', 'simulation-history.sqlite3')
const LEGACY_JSONL_PATH = resolve(process.cwd(), '.data', 'simulation-history.jsonl')
const PYTHON_SCRIPT_PATH = resolve(process.cwd(), 'api', 'futu_bridge', 'simulation_history_db.py')
const MAX_PAGE_SIZE = 100
const NEAREST_SIGNAL_WINDOW_SECONDS = 5
const PERSISTENCE_DISABLED = process.env.NODE_ENV === 'test' && process.env.SIMULATION_PERSIST_TEST !== '1'

class SimulationPersistence {
  private readonly filePath = process.env.SIMULATION_HISTORY_DB_PATH || DEFAULT_DB_PATH
  private migrated = false

  appendSignal(signal: QuantSignal) {
    this.append('signals', signal, signal.generatedAt)
  }

  appendOrder(order: SimulatedOrderResult) {
    this.append('orders', order, order.submittedAt)
  }

  appendSkipped(skipped: SimulationSkippedTicker) {
    this.append('skipped', skipped, skipped.updatedAt)
  }

  readLatest(kind: 'signals', limit: number): QuantSignal[]
  readLatest(kind: 'orders', limit: number): SimulatedOrderResult[]
  readLatest(kind: 'skipped', limit: number): SimulationSkippedTicker[]
  readLatest(kind: SimulationHistoryKind, limit: number) {
    if (PERSISTENCE_DISABLED) return []
    this.migrateLegacyJsonl()
    const response = this.runSqlite<{ items: unknown[] }>({ action: 'read_latest', kind, limit })
    return response?.items ?? []
  }

  paginate(kind: 'signals', page: number, pageSize: number): SimulationHistoryPage<QuantSignal>
  paginate(kind: 'orders', page: number, pageSize: number): SimulationHistoryPage<SimulatedOrderResult>
  paginate(kind: 'skipped', page: number, pageSize: number): SimulationHistoryPage<SimulationSkippedTicker>
  paginate(kind: SimulationHistoryKind, page: number, pageSize: number) {
    const normalizedPage = Math.max(1, Math.floor(page) || 1)
    const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 20))
    if (PERSISTENCE_DISABLED) return emptyPage(normalizedPage, normalizedPageSize)
    this.migrateLegacyJsonl()
    return this.runSqlite<SimulationHistoryPage<unknown>>({ action: 'paginate', kind, page: normalizedPage, pageSize: normalizedPageSize }) ?? emptyPage(normalizedPage, normalizedPageSize)
  }

  getOrderByHistoryId(historyId: number): SimulatedOrderResult | undefined {
    return this.getByHistoryId<SimulatedOrderResult>('orders', historyId)
  }

  getSignalByHistoryId(historyId: number): QuantSignal | undefined {
    return this.getByHistoryId<QuantSignal>('signals', historyId)
  }

  findOrderByOrderId(orderId: string): SimulatedOrderResult | undefined {
    if (!orderId || orderId === 'blocked-by-risk' || orderId === 'unavailable') return undefined
    return this.findByPayloadField<SimulatedOrderResult>('orders', 'orderId', orderId)
  }

  findSignalById(signalId: string): QuantSignal | undefined {
    if (!signalId) return undefined
    return this.findByPayloadField<QuantSignal>('signals', 'id', signalId)
  }

  findNearestSignalForOrder(order: SimulatedOrderResult): QuantSignal | undefined {
    if (!order.ticker || !order.side || !order.submittedAt) return undefined
    if (PERSISTENCE_DISABLED) return undefined
    this.migrateLegacyJsonl()
    const response = this.runSqlite<{ item?: QuantSignal | null }>({
      action: 'find_nearest_signal',
      ticker: order.ticker,
      side: order.side,
      submittedAt: order.submittedAt,
      secondsWindow: NEAREST_SIGNAL_WINDOW_SECONDS,
    })
    return response?.item ?? undefined
  }

  clearForTests() {
    if (PERSISTENCE_DISABLED) return
    this.runSqlite({ action: 'clear' })
  }

  private append(kind: SimulationHistoryKind, payload: PayloadByKind[SimulationHistoryKind], createdAt: string) {
    if (PERSISTENCE_DISABLED) return
    this.migrateLegacyJsonl()
    this.runSqlite({ action: 'append', kind, createdAt, payload })
  }

  private getByHistoryId<T>(kind: SimulationHistoryKind, historyId: number): T | undefined {
    if (!Number.isFinite(historyId) || historyId <= 0) return undefined
    if (PERSISTENCE_DISABLED) return undefined
    this.migrateLegacyJsonl()
    const response = this.runSqlite<{ item?: T | null }>({ action: 'get_event_by_id', kind, id: Math.floor(historyId) })
    return response?.item ?? undefined
  }

  private findByPayloadField<T>(kind: SimulationHistoryKind, field: 'id' | 'orderId' | 'signalId', value: string): T | undefined {
    if (PERSISTENCE_DISABLED) return undefined
    this.migrateLegacyJsonl()
    const response = this.runSqlite<{ item?: T | null }>({ action: 'find_event_by_payload_field', kind, field, value })
    return response?.item ?? undefined
  }

  private migrateLegacyJsonl() {
    if (this.migrated) return
    this.migrated = true
    if (existsSync(LEGACY_JSONL_PATH)) {
      this.runSqlite({ action: 'migrate_jsonl', jsonlPath: LEGACY_JSONL_PATH })
    }
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
      console.error(`SQLite history bridge failed: ${result.stderr || result.stdout}`)
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
      console.error(`SQLite history bridge failed: ${parsed.error ?? 'unknown error'}`)
      return undefined
    }
    return parsed
  }
}

export const simulationPersistence = new SimulationPersistence()

function emptyPage<T>(page: number, pageSize: number): SimulationHistoryPage<T> {
  return {
    items: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1,
  }
}
