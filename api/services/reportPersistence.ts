import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type {
  ReportGenerationResult,
  ReportHistoryPage,
  ReportPromptArchive,
  TopOpportunityHistoryPage,
  TopOpportunitySnapshot,
} from '../../shared/types.js'

const DEFAULT_DB_PATH = resolve(process.cwd(), '.data', 'top30-report-history.sqlite3')
const PYTHON_SCRIPT_PATH = resolve(process.cwd(), 'api', 'futu_bridge', 'report_history_db.py')
const MAX_PAGE_SIZE = 100
const SQLITE_BRIDGE_TIMEOUT_MS = 8_000

class ReportPersistence {
  private readonly filePath = process.env.REPORT_HISTORY_DB_PATH || DEFAULT_DB_PATH

  appendReport(report: ReportGenerationResult, promptArchive: ReportPromptArchive) {
    if (this.persistenceDisabled()) return
    this.runSqlite<{ id: number }>({
      action: 'append_report',
      report,
      promptArchive,
      createdAt: new Date().toISOString(),
    })
  }

  readLatestReport(): ReportGenerationResult | undefined {
    if (this.persistenceDisabled()) return undefined
    const response = this.runSqlite<{ item?: ReportGenerationResult | null }>({ action: 'latest_report' })
    return response?.item ?? undefined
  }

  paginateReports(page: number, pageSize: number): ReportHistoryPage {
    const normalizedPage = normalizePage(page)
    const normalizedPageSize = normalizePageSize(pageSize, 10)
    if (this.persistenceDisabled()) return emptyPage(normalizedPage, normalizedPageSize)
    return (
      this.runSqlite<ReportHistoryPage>({
        action: 'paginate_reports',
        page: normalizedPage,
        pageSize: normalizedPageSize,
      }) ?? emptyPage(normalizedPage, normalizedPageSize)
    )
  }

  getReportByBatchId(batchId: string): ReportGenerationResult | undefined {
    if (!batchId) return undefined
    if (this.persistenceDisabled()) return undefined
    const response = this.runSqlite<{ item?: ReportGenerationResult | null }>({ action: 'get_report_by_batch_id', batchId })
    return response?.item ?? undefined
  }

  readLatestTopOpportunities(): TopOpportunitySnapshot[] {
    if (this.persistenceDisabled()) return []
    const response = this.runSqlite<{ items: TopOpportunitySnapshot[] }>({ action: 'latest_top_opportunities' })
    return response?.items ?? []
  }

  paginateTopOpportunityGroups(page: number, pageSize: number): TopOpportunityHistoryPage {
    const normalizedPage = normalizePage(page)
    const normalizedPageSize = normalizePageSize(pageSize, 10)
    if (this.persistenceDisabled()) {
      return {
        items: [],
        page: normalizedPage,
        pageSize: normalizedPageSize,
        total: 0,
        totalPages: 1,
      }
    }
    return (
      this.runSqlite<TopOpportunityHistoryPage>({
        action: 'paginate_top_opportunity_groups',
        page: normalizedPage,
        pageSize: normalizedPageSize,
      }) ?? {
        items: [],
        page: normalizedPage,
        pageSize: normalizedPageSize,
        total: 0,
        totalPages: 1,
      }
    )
  }

  clearForTests() {
    if (this.persistenceDisabled()) return
    this.runSqlite({ action: 'clear' })
  }

  private persistenceDisabled() {
    return process.env.NODE_ENV === 'test' && process.env.REPORT_PERSIST_TEST !== '1'
  }

  private runSqlite<T>(payload: Record<string, unknown>): T | undefined {
    const pythonBin = process.env.FUTU_PYTHON_BIN || 'python3'
    const result = spawnSync(pythonBin, [PYTHON_SCRIPT_PATH], {
      input: JSON.stringify({ dbPath: this.filePath, ...payload }),
      encoding: 'utf8',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: SQLITE_BRIDGE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })
    if (result.error) {
      console.error(`Report SQLite history bridge failed for action ${String(payload.action ?? 'unknown')}: ${result.error.message}`)
      return undefined
    }
    if (result.status !== 0) {
      console.error(`Report SQLite history bridge failed for action ${String(payload.action ?? 'unknown')}: ${result.stderr || result.stdout || result.signal || 'unknown error'}`)
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
      console.error(`Report SQLite history bridge failed: ${parsed.error ?? 'unknown error'}`)
      return undefined
    }
    return parsed
  }
}

export const reportPersistence = new ReportPersistence()

function normalizePage(page: number) {
  return Math.max(1, Math.floor(page) || 1)
}

function normalizePageSize(pageSize: number, fallback: number) {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || fallback))
}

function emptyPage<T>(page: number, pageSize: number): ReportHistoryPage & { items: T[] } {
  return {
    items: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1,
  }
}
