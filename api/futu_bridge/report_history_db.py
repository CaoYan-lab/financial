import json
import sqlite3
from pathlib import Path

from futu_common import read_payload, write_json


def main():
    payload = read_payload()
    db_path = payload.get("dbPath")
    action = payload.get("action")
    if not db_path:
        write_json({"ok": False, "error": "dbPath is required."})
        return

    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path, timeout=3) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 3000")
        initialize(conn)
        if action == "append_report":
            append_report(conn, payload)
        elif action == "latest_report":
            latest_report(conn)
        elif action == "paginate_reports":
            paginate_reports(conn, payload)
        elif action == "get_report_by_batch_id":
            get_report_by_batch_id(conn, payload)
        elif action == "latest_top_opportunities":
            latest_top_opportunities(conn)
        elif action == "paginate_top_opportunity_groups":
            paginate_top_opportunity_groups(conn, payload)
        elif action == "clear":
            clear(conn)
        else:
            write_json({"ok": False, "error": f"Unsupported action: {action}"})


def initialize(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id TEXT NOT NULL UNIQUE,
            generated_at TEXT NOT NULL,
            report_window_days INTEGER NOT NULL DEFAULT 30,
            raw_data TEXT NOT NULL,
            data_quality TEXT NOT NULL,
            analysis TEXT NOT NULL,
            markdown TEXT NOT NULL,
            analysis_model TEXT,
            prompt_archive TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at DESC, id DESC)")
    ensure_column(conn, "reports", "analysis_model", "TEXT")
    ensure_column(conn, "reports", "report_window_days", "INTEGER NOT NULL DEFAULT 30")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS report_top_opportunities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_id INTEGER NOT NULL,
            batch_id TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            opportunity_rank INTEGER NOT NULL,
            ticker TEXT NOT NULL,
            analysis TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE,
            UNIQUE(report_id, opportunity_rank)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_report_top_opportunities_report_rank ON report_top_opportunities(report_id, opportunity_rank ASC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_report_top_opportunities_ticker_generated_at ON report_top_opportunities(ticker, generated_at DESC, id DESC)"
    )


def append_report(conn, payload):
    report = payload.get("report")
    prompt_archive = payload.get("promptArchive")
    if not isinstance(report, dict) or not isinstance(prompt_archive, dict):
        write_json({"ok": False, "error": "report and promptArchive are required."})
        return

    batch_id = str(report.get("batchId") or "")
    generated_at = str(report.get("generatedAt") or "")
    if not batch_id or not generated_at:
        write_json({"ok": False, "error": "report.batchId and report.generatedAt are required."})
        return

    raw_data = report.get("rawData") if isinstance(report.get("rawData"), list) else []
    data_quality = report.get("dataQuality") if isinstance(report.get("dataQuality"), dict) else {}
    analysis = report.get("analysis") if isinstance(report.get("analysis"), dict) else {}
    markdown = str(report.get("markdown") or "")
    analysis_model = report.get("analysisModel") if isinstance(report.get("analysisModel"), dict) else None
    report_window_days = normalize_report_window_days(report.get("reportWindowDays"))
    created_at = str(payload.get("createdAt") or generated_at)

    with conn:
        existing = conn.execute("SELECT id FROM reports WHERE batch_id = ?", (batch_id,)).fetchone()
        if existing:
            report_id = existing["id"]
            conn.execute(
                """
                UPDATE reports
                SET generated_at = ?, report_window_days = ?, raw_data = ?, data_quality = ?, analysis = ?, markdown = ?, analysis_model = ?, prompt_archive = ?, created_at = ?
                WHERE id = ?
                """,
                (
                    generated_at,
                    report_window_days,
                    dumps(raw_data),
                    dumps(data_quality),
                    dumps(analysis),
                    markdown,
                    dumps(analysis_model) if analysis_model else None,
                    dumps(prompt_archive),
                    created_at,
                    report_id,
                ),
            )
            conn.execute("DELETE FROM report_top_opportunities WHERE report_id = ?", (report_id,))
        else:
            cursor = conn.execute(
                """
                INSERT INTO reports (batch_id, generated_at, report_window_days, raw_data, data_quality, analysis, markdown, analysis_model, prompt_archive, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    batch_id,
                    generated_at,
                    report_window_days,
                    dumps(raw_data),
                    dumps(data_quality),
                    dumps(analysis),
                    markdown,
                    dumps(analysis_model) if analysis_model else None,
                    dumps(prompt_archive),
                    created_at,
                ),
            )
            report_id = cursor.lastrowid

        top_opportunities = analysis.get("topOpportunities") if isinstance(analysis, dict) else []
        if not isinstance(top_opportunities, list):
            top_opportunities = []
        for index, item in enumerate(top_opportunities[:5], start=1):
            ticker = str(item.get("ticker") or "").upper() if isinstance(item, dict) else ""
            conn.execute(
                """
                INSERT INTO report_top_opportunities
                  (report_id, batch_id, generated_at, opportunity_rank, ticker, analysis, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (report_id, batch_id, generated_at, index, ticker, dumps(item), created_at),
            )

    write_json({"ok": True, "id": report_id})


def latest_report(conn):
    row = conn.execute(
        """
        SELECT * FROM reports
        ORDER BY generated_at DESC, id DESC
        LIMIT 1
        """
    ).fetchone()
    write_json({"ok": True, "item": report_payload(row) if row else None})


def paginate_reports(conn, payload):
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 10)
    total = conn.execute("SELECT COUNT(*) AS total FROM reports").fetchone()["total"]
    total_pages = max(1, (total + page_size - 1) // page_size)
    safe_page = min(page, total_pages)
    offset = (safe_page - 1) * page_size
    rows = conn.execute(
        """
        SELECT * FROM reports
        ORDER BY generated_at DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        (page_size, offset),
    ).fetchall()
    write_json(
        {
            "ok": True,
            "items": [report_summary(row) for row in rows],
            "page": safe_page,
            "pageSize": page_size,
            "total": total,
            "totalPages": total_pages,
        }
    )


def get_report_by_batch_id(conn, payload):
    batch_id = str(payload.get("batchId") or "")
    if not batch_id:
        write_json({"ok": False, "error": "batchId is required."})
        return
    row = conn.execute("SELECT * FROM reports WHERE batch_id = ?", (batch_id,)).fetchone()
    write_json({"ok": True, "item": report_payload(row) if row else None})


def latest_top_opportunities(conn):
    report = conn.execute(
        """
        SELECT id FROM reports
        ORDER BY generated_at DESC, id DESC
        LIMIT 1
        """
    ).fetchone()
    if not report:
        write_json({"ok": True, "items": []})
        return
    rows = top_opportunity_rows(conn, report["id"])
    write_json({"ok": True, "items": [top_opportunity_payload(row) for row in rows]})


def paginate_top_opportunity_groups(conn, payload):
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 10)
    total = conn.execute("SELECT COUNT(*) AS total FROM reports").fetchone()["total"]
    total_pages = max(1, (total + page_size - 1) // page_size)
    safe_page = min(page, total_pages)
    offset = (safe_page - 1) * page_size
    reports = conn.execute(
        """
        SELECT * FROM reports
        ORDER BY generated_at DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        (page_size, offset),
    ).fetchall()
    items = [
        {
            "report": report_summary(report),
            "opportunities": [top_opportunity_payload(row) for row in top_opportunity_rows(conn, report["id"])],
        }
        for report in reports
    ]
    write_json(
        {
            "ok": True,
            "items": items,
            "page": safe_page,
            "pageSize": page_size,
            "total": total,
            "totalPages": total_pages,
        }
    )


def clear(conn):
    conn.execute("DELETE FROM report_top_opportunities")
    conn.execute("DELETE FROM reports")
    write_json({"ok": True})


def top_opportunity_rows(conn, report_id):
    return conn.execute(
        """
        SELECT * FROM report_top_opportunities
        WHERE report_id = ?
        ORDER BY opportunity_rank ASC, id ASC
        """,
        (report_id,),
    ).fetchall()


def report_payload(row):
    if not row:
        return None
    return {
        "batchId": row["batch_id"],
        "generatedAt": row["generated_at"],
        "reportWindowDays": normalize_report_window_days(row["report_window_days"] if has_key(row, "report_window_days") else 30),
        "rawData": loads(row["raw_data"], []),
        "dataQuality": loads(row["data_quality"], {}),
        "analysis": loads(row["analysis"], {}),
        "markdown": row["markdown"],
        "analysisModel": loads(row["analysis_model"], None) if has_key(row, "analysis_model") and row["analysis_model"] else None,
    }


def report_summary(row):
    raw_data = loads(row["raw_data"], [])
    data_quality = loads(row["data_quality"], {})
    analysis = loads(row["analysis"], {})
    top = analysis.get("topOpportunities") if isinstance(analysis, dict) else []
    bottom = analysis.get("bottomLosers") if isinstance(analysis, dict) else []
    return {
        "id": row["id"],
        "batchId": row["batch_id"],
        "generatedAt": row["generated_at"],
        "reportWindowDays": normalize_report_window_days(row["report_window_days"] if has_key(row, "report_window_days") else 30),
        "analysisModel": loads(row["analysis_model"], None) if has_key(row, "analysis_model") and row["analysis_model"] else None,
        "rawRowCount": len(raw_data) if isinstance(raw_data, list) else 0,
        "topOpportunityTickers": tickers(top),
        "bottomLoserTickers": tickers(bottom),
        "isUsableForAnalysis": bool(data_quality.get("isUsableForAnalysis")) if isinstance(data_quality, dict) else False,
    }


def top_opportunity_payload(row):
    return {
        "id": row["id"],
        "reportId": row["report_id"],
        "batchId": row["batch_id"],
        "generatedAt": row["generated_at"],
        "opportunityRank": row["opportunity_rank"],
        "analysis": loads(row["analysis"], {}),
    }


def tickers(items):
    if not isinstance(items, list):
        return []
    return [str(item.get("ticker") or "").upper() for item in items if isinstance(item, dict) and item.get("ticker")]


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def ensure_column(conn, table, column, definition):
    columns = [row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def has_key(row, key):
    return key in row.keys()


def loads(value, fallback):
    try:
        return json.loads(value)
    except Exception:
        return fallback


def normalize_report_window_days(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 30
    return 60 if number == 60 else 30


def clamp_int(value, min_value, max_value, fallback):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(min_value, min(max_value, number))


if __name__ == "__main__":
    main()
