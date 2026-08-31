import json
import os
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
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        initialize(conn)
        if action == "append":
            append(conn, payload)
        elif action == "read_latest":
            read_latest(conn, payload)
        elif action == "paginate":
            paginate(conn, payload)
        elif action == "get_event_by_id":
            get_event_by_id(conn, payload)
        elif action == "find_event_by_payload_field":
            find_event_by_payload_field(conn, payload)
        elif action == "find_nearest_signal":
            find_nearest_signal(conn, payload)
        elif action == "clear":
            clear(conn)
        elif action == "migrate_jsonl":
            migrate_jsonl(conn, payload)
        elif action == "get_config":
            get_config(conn, payload)
        elif action == "set_config":
            set_config(conn, payload)
        else:
            write_json({"ok": False, "error": f"Unsupported action: {action}"})


def initialize(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS simulation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            ticker TEXT,
            side TEXT,
            strategy TEXT,
            ok INTEGER,
            created_at TEXT NOT NULL,
            payload TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sim_events_kind_created_at ON simulation_events(kind, created_at DESC, id DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sim_events_ticker_created_at ON simulation_events(ticker, created_at DESC, id DESC)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS simulation_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS simulation_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )


def append(conn, payload):
    kind = payload.get("kind")
    record_payload = payload.get("payload")
    created_at = payload.get("createdAt")
    if kind not in {"signals", "orders", "skipped"}:
        write_json({"ok": False, "error": "Unsupported history kind."})
        return
    if not created_at or not isinstance(record_payload, dict):
        write_json({"ok": False, "error": "createdAt and payload are required."})
        return
    insert_event(conn, kind, created_at, record_payload)
    write_json({"ok": True})


def read_latest(conn, payload):
    kind = payload.get("kind")
    limit = clamp_int(payload.get("limit"), 1, 500, 100)
    rows = conn.execute(
        """
        SELECT id, payload FROM simulation_events
        WHERE kind = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        (kind, limit),
    ).fetchall()
    write_json({"ok": True, "items": [event_payload(row) for row in rows]})


def paginate(conn, payload):
    kind = payload.get("kind")
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 20)
    total = conn.execute("SELECT COUNT(*) AS total FROM simulation_events WHERE kind = ?", (kind,)).fetchone()["total"]
    total_pages = max(1, (total + page_size - 1) // page_size)
    safe_page = min(page, total_pages)
    offset = (safe_page - 1) * page_size
    rows = conn.execute(
        """
        SELECT id, payload FROM simulation_events
        WHERE kind = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        (kind, page_size, offset),
    ).fetchall()
    write_json(
        {
            "ok": True,
            "items": [event_payload(row) for row in rows],
            "page": safe_page,
            "pageSize": page_size,
            "total": total,
            "totalPages": total_pages,
        }
    )


def get_event_by_id(conn, payload):
    kind = payload.get("kind")
    event_id = clamp_int(payload.get("id"), 1, 10**18, 0)
    if kind not in {"signals", "orders", "skipped"} or event_id <= 0:
        write_json({"ok": False, "error": "kind and positive id are required."})
        return
    row = conn.execute(
        """
        SELECT id, payload FROM simulation_events
        WHERE kind = ? AND id = ?
        """,
        (kind, event_id),
    ).fetchone()
    write_json({"ok": True, "item": event_payload(row) if row else None})


def find_event_by_payload_field(conn, payload):
    kind = payload.get("kind")
    field = payload.get("field")
    value = payload.get("value")
    if kind not in {"signals", "orders", "skipped"}:
        write_json({"ok": False, "error": "Unsupported history kind."})
        return
    if field not in {"id", "orderId", "signalId"} or value is None:
        write_json({"ok": False, "error": "Unsupported field or empty value."})
        return
    row = conn.execute(
        f"""
        SELECT id, payload FROM simulation_events
        WHERE kind = ? AND json_extract(payload, '$.{field}') = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """,
        (kind, str(value)),
    ).fetchone()
    write_json({"ok": True, "item": event_payload(row) if row else None})


def find_nearest_signal(conn, payload):
    ticker = str(payload.get("ticker", "") or "").upper()
    side = str(payload.get("side", "") or "").upper()
    submitted_at = str(payload.get("submittedAt", "") or "")
    seconds_window = clamp_int(payload.get("secondsWindow"), 1, 300, 5)
    if not ticker or not side or not submitted_at:
        write_json({"ok": False, "error": "ticker, side and submittedAt are required."})
        return
    rows = conn.execute(
        """
        SELECT id, created_at, payload,
               ABS((julianday(created_at) - julianday(?)) * 86400.0) AS distance_seconds,
               CASE WHEN created_at <= ? THEN 0 ELSE 1 END AS after_submitted
        FROM simulation_events
        WHERE kind = 'signals'
          AND ticker = ?
          AND side = ?
          AND ABS((julianday(created_at) - julianday(?)) * 86400.0) <= ?
        ORDER BY after_submitted ASC, distance_seconds ASC, created_at DESC, id DESC
        LIMIT 1
        """,
        (submitted_at, submitted_at, ticker, side, submitted_at, seconds_window),
    ).fetchall()
    row = rows[0] if rows else None
    write_json({"ok": True, "item": event_payload(row) if row else None})


def clear(conn):
    conn.execute("DELETE FROM simulation_events")
    conn.execute("DELETE FROM simulation_meta")
    write_json({"ok": True})


def migrate_jsonl(conn, payload):
    jsonl_path = payload.get("jsonlPath")
    if not jsonl_path or not os.path.exists(jsonl_path):
        write_json({"ok": True, "migrated": 0, "reason": "legacy jsonl not found"})
        return
    meta_key = f"migrated:{os.path.abspath(jsonl_path)}:{os.path.getsize(jsonl_path)}"
    if conn.execute("SELECT 1 FROM simulation_meta WHERE key = ?", (meta_key,)).fetchone():
        write_json({"ok": True, "migrated": 0, "reason": "already migrated"})
        return

    migrated = 0
    with open(jsonl_path, "r", encoding="utf-8") as source:
        for line in source:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = record.get("kind")
            created_at = record.get("createdAt")
            record_payload = record.get("payload")
            if kind in {"signals", "orders", "skipped"} and created_at and isinstance(record_payload, dict):
                insert_event(conn, kind, created_at, record_payload)
                migrated += 1
    conn.execute("INSERT OR REPLACE INTO simulation_meta(key, value) VALUES (?, ?)", (meta_key, "1"))
    write_json({"ok": True, "migrated": migrated})


def get_config(conn, payload):
    key = payload.get("key")
    if not key:
        write_json({"ok": False, "error": "key is required."})
        return
    row = conn.execute("SELECT value, updated_at FROM simulation_config WHERE key = ?", (key,)).fetchone()
    if row is None:
        write_json({"ok": True, "found": False})
        return
    try:
        value = json.loads(row["value"])
    except json.JSONDecodeError:
        write_json({"ok": False, "error": f"Stored config is not valid JSON: {key}"})
        return
    write_json({"ok": True, "found": True, "value": value, "updatedAt": row["updated_at"]})


def set_config(conn, payload):
    key = payload.get("key")
    value = payload.get("value")
    updated_at = payload.get("updatedAt")
    if not key or not isinstance(value, dict) or not updated_at:
        write_json({"ok": False, "error": "key, object value and updatedAt are required."})
        return
    conn.execute(
        """
        INSERT INTO simulation_config(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, json.dumps(value, ensure_ascii=False, separators=(",", ":")), updated_at),
    )
    write_json({"ok": True})


def insert_event(conn, kind, created_at, payload):
    conn.execute(
        """
        INSERT INTO simulation_events(kind, ticker, side, strategy, ok, created_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            kind,
            str(payload.get("ticker", "") or "").upper() or None,
            payload.get("side"),
            payload.get("strategy"),
            1 if payload.get("ok") is True else 0 if payload.get("ok") is False else None,
            created_at,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ),
    )


def event_payload(row):
    if row is None:
        return None
    payload = json.loads(row["payload"])
    if isinstance(payload, dict):
        payload["historyId"] = row["id"]
    return payload


def clamp_int(value, minimum, maximum, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


if __name__ == "__main__":
    main()
