import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  TradingPromptComparisonResult,
  TradingPromptComparisonRun,
} from '../../shared/tradingPromptTypes.js'

const DEFAULT_PATH = resolve(process.cwd(), '.data', 'trading-prompt-comparison.sqlite3')

function database() {
  const db = new DatabaseSync(process.env.TRADING_PROMPT_COMPARISON_DB_PATH ?? DEFAULT_PATH)
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS prompt_comparison_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      universe_count INTEGER NOT NULL,
      total_cases INTEGER NOT NULL,
      completed_cases INTEGER NOT NULL DEFAULT 0,
      passed_cases INTEGER NOT NULL DEFAULT 0,
      failed_cases INTEGER NOT NULL DEFAULT 0,
      report_path TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS prompt_comparison_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      broker TEXT NOT NULL,
      mode TEXT NOT NULL,
      ticker TEXT NOT NULL,
      model_requested INTEGER NOT NULL,
      context_ok INTEGER NOT NULL,
      market_price REAL,
      market_updated_at TEXT,
      action TEXT NOT NULL,
      approved INTEGER NOT NULL,
      request_ok INTEGER NOT NULL,
      contract_valid INTEGER,
      policy_valid INTEGER,
      context_usable_at_response INTEGER,
      duration_ms INTEGER NOT NULL,
      reason TEXT NOT NULL,
      risk_assessment TEXT NOT NULL,
      errors_json TEXT NOT NULL,
      raw_output_json TEXT,
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, broker, mode, ticker)
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_comparison_results_run
      ON prompt_comparison_results(run_id, broker, mode, ticker);
  `)
  return db
}

export function createTradingPromptComparisonRun(run: TradingPromptComparisonRun) {
  const db = database()
  try {
    db.prepare(`
      INSERT INTO prompt_comparison_runs (
        id, started_at, completed_at, status, universe_count, total_cases,
        completed_cases, passed_cases, failed_cases, report_path, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.startedAt, run.completedAt, run.status, run.universeCount, run.totalCases,
      run.completedCases, run.passedCases, run.failedCases, run.reportPath, run.error)
  } finally {
    db.close()
  }
}

export function appendTradingPromptComparisonResult(result: Omit<TradingPromptComparisonResult, 'id'>) {
  const db = database()
  try {
    db.prepare(`
      INSERT INTO prompt_comparison_results (
        run_id, broker, mode, ticker, model_requested, context_ok, market_price,
        market_updated_at, action, approved, request_ok, contract_valid, policy_valid,
        context_usable_at_response, duration_ms, reason, risk_assessment, errors_json,
        raw_output_json, context_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, broker, mode, ticker) DO UPDATE SET
        model_requested=excluded.model_requested, context_ok=excluded.context_ok,
        market_price=excluded.market_price, market_updated_at=excluded.market_updated_at,
        action=excluded.action, approved=excluded.approved, request_ok=excluded.request_ok,
        contract_valid=excluded.contract_valid, policy_valid=excluded.policy_valid,
        context_usable_at_response=excluded.context_usable_at_response,
        duration_ms=excluded.duration_ms, reason=excluded.reason,
        risk_assessment=excluded.risk_assessment, errors_json=excluded.errors_json,
        raw_output_json=excluded.raw_output_json, context_json=excluded.context_json,
        created_at=excluded.created_at
    `).run(
      result.runId, result.broker, result.mode, result.ticker,
      bool(result.modelRequested), bool(result.contextOk), result.marketPrice,
      result.marketUpdatedAt, result.action, bool(result.approved), bool(result.requestOk),
      nullableBool(result.contractValid), nullableBool(result.policyValid),
      nullableBool(result.contextUsableAtResponse), result.durationMs, result.reason,
      result.riskAssessment, JSON.stringify(result.errors), JSON.stringify(result.rawOutput ?? null),
      JSON.stringify(result.contextSummary), result.createdAt,
    )
    db.prepare(`
      UPDATE prompt_comparison_runs SET
        completed_cases=(SELECT COUNT(*) FROM prompt_comparison_results WHERE run_id=?),
        passed_cases=(SELECT COUNT(*) FROM prompt_comparison_results WHERE run_id=? AND request_ok=1),
        failed_cases=(SELECT COUNT(*) FROM prompt_comparison_results WHERE run_id=? AND request_ok=0)
      WHERE id=?
    `).run(result.runId, result.runId, result.runId, result.runId)
  } finally {
    db.close()
  }
}

export function finishTradingPromptComparisonRun(runId: string, input: {
  status: 'COMPLETED' | 'FAILED'
  reportPath?: string
  error?: string
}) {
  const db = database()
  try {
    db.prepare(`
      UPDATE prompt_comparison_runs
      SET completed_at=?, status=?, report_path=?, error=?
      WHERE id=?
    `).run(new Date().toISOString(), input.status, input.reportPath ?? null, input.error ?? null, runId)
  } finally {
    db.close()
  }
}

export function latestTradingPromptComparison(broker?: 'futu' | 'longbridge') {
  const db = database()
  try {
    const row = db.prepare('SELECT * FROM prompt_comparison_runs ORDER BY started_at DESC LIMIT 1').get() as Record<string, unknown> | undefined
    if (!row) return { ok: true as const, run: null, results: [] }
    const query = broker
      ? db.prepare('SELECT * FROM prompt_comparison_results WHERE run_id=? AND broker=? ORDER BY ticker, mode')
      : db.prepare('SELECT * FROM prompt_comparison_results WHERE run_id=? ORDER BY broker, ticker, mode')
    const runId = String(row.id)
    const rows = (broker ? query.all(runId, broker) : query.all(runId)) as Array<Record<string, unknown>>
    return { ok: true as const, run: mapRun(row), results: rows.map(mapResult) }
  } finally {
    db.close()
  }
}

function bool(value: boolean) {
  return value ? 1 : 0
}

function nullableBool(value: boolean | null) {
  return value === null ? null : bool(value)
}

function parseBoolean(value: unknown): boolean {
  return Number(value) === 1
}

function parseNullableBoolean(value: unknown): boolean | null {
  return value === null ? null : parseBoolean(value)
}

function mapRun(row: Record<string, unknown>): TradingPromptComparisonRun {
  return {
    id: String(row.id), startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : null,
    status: row.status as TradingPromptComparisonRun['status'], universeCount: Number(row.universe_count),
    totalCases: Number(row.total_cases), completedCases: Number(row.completed_cases),
    passedCases: Number(row.passed_cases), failedCases: Number(row.failed_cases),
    reportPath: row.report_path ? String(row.report_path) : null, error: row.error ? String(row.error) : null,
  }
}

function mapResult(row: Record<string, unknown>): TradingPromptComparisonResult {
  return {
    id: Number(row.id), runId: String(row.run_id), broker: row.broker as TradingPromptComparisonResult['broker'],
    mode: row.mode as TradingPromptComparisonResult['mode'], ticker: String(row.ticker),
    modelRequested: parseBoolean(row.model_requested), contextOk: parseBoolean(row.context_ok),
    marketPrice: row.market_price === null ? null : Number(row.market_price),
    marketUpdatedAt: row.market_updated_at ? String(row.market_updated_at) : null,
    action: String(row.action), approved: parseBoolean(row.approved), requestOk: parseBoolean(row.request_ok),
    contractValid: parseNullableBoolean(row.contract_valid), policyValid: parseNullableBoolean(row.policy_valid),
    contextUsableAtResponse: parseNullableBoolean(row.context_usable_at_response),
    durationMs: Number(row.duration_ms), reason: String(row.reason), riskAssessment: String(row.risk_assessment),
    errors: JSON.parse(String(row.errors_json)), rawOutput: JSON.parse(String(row.raw_output_json ?? 'null')),
    contextSummary: JSON.parse(String(row.context_json)), createdAt: String(row.created_at),
  }
}
