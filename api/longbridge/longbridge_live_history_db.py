import os as _os
import sys as _sys

if _os.environ.get("PG_HISTORY_DRIVER") == "1":
    _sys.path.insert(0, _os.environ.get("VOLCANO_CLOUD_PYTHONPATH", ""))
    from pg_history_driver import run as _pg_run

    _pg_run(__file__)
    _sys.exit(0)

import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


TABLES = {
    "signals": "longbridge_live_signals",
    "pending_orders": "longbridge_live_pending_orders",
    "submitted_orders": "longbridge_live_submitted_orders",
    "rejected_orders": "longbridge_live_rejected_orders",
    "skipped": "longbridge_live_skipped",
    "confirmations": "longbridge_live_confirmations",
    "candidate_pool": "longbridge_live_candidate_pool",
}


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
        elif action == "paginate_pending_order_lifecycle":
            paginate_pending_order_lifecycle(conn, payload)
        elif action == "paginate_signal_lifecycle":
            paginate_signal_lifecycle(conn, payload)
        elif action == "paginate_candidate_pool_history":
            paginate_candidate_pool_history(conn, payload)
        elif action == "get_event_by_id":
            get_event_by_id(conn, payload)
        elif action == "find_event_by_payload_field":
            find_event_by_payload_field(conn, payload)
        elif action == "clear":
            clear(conn)
        else:
            write_json({"ok": False, "error": f"Unsupported action: {action}"})


def initialize(conn):
    for table in TABLES.values():
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {table} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT,
                side TEXT,
                strategy TEXT,
                status TEXT,
                ok INTEGER,
                created_at TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_created_at ON {table}(created_at DESC, id DESC)")
        conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_ticker_created_at ON {table}(ticker, created_at DESC, id DESC)")


def append(conn, payload):
    kind = payload.get("kind")
    record_payload = payload.get("payload")
    created_at = payload.get("createdAt")
    if kind not in TABLES:
        write_json({"ok": False, "error": "Unsupported longbridge live history kind."})
        return
    if not created_at or not isinstance(record_payload, dict):
        write_json({"ok": False, "error": "createdAt and payload are required."})
        return
    insert_event(conn, kind, created_at, record_payload)
    write_json({"ok": True})


def read_latest(conn, payload):
    kind = payload.get("kind")
    limit = clamp_int(payload.get("limit"), 1, 500, 100)
    table = table_for_kind(kind)
    if not table:
        write_json({"ok": False, "error": "Unsupported longbridge live history kind."})
        return
    rows = conn.execute(
        f"""
        SELECT id, payload FROM {table}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    write_json({"ok": True, "items": [event_payload(row) for row in rows]})


def paginate(conn, payload):
    kind = payload.get("kind")
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 20)
    table = table_for_kind(kind)
    if not table:
        write_json({"ok": False, "error": "Unsupported longbridge live history kind."})
        return
    total = conn.execute(f"SELECT COUNT(*) AS total FROM {table}").fetchone()["total"]
    total_pages = max(1, (total + page_size - 1) // page_size)
    safe_page = min(page, total_pages)
    offset = (safe_page - 1) * page_size
    rows = conn.execute(
        f"""
        SELECT id, payload FROM {table}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        (page_size, offset),
    ).fetchall()
    write_json({"ok": True, "items": [event_payload(row) for row in rows], "page": safe_page, "pageSize": page_size, "total": total, "totalPages": total_pages})


def paginate_pending_order_lifecycle(conn, payload):
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 20)
    status_filter = normalize_filter(payload.get("status"), pending_statuses())
    ticker_filter = normalize_ticker_filter(payload.get("ticker"))
    side_filter = normalize_filter(payload.get("side"), {"BUY", "SELL_SHORT", "SELL_TO_CLOSE"})
    items = pending_lifecycle_items(conn)
    if status_filter != "ALL":
        items = [item for item in items if item.get("status") == status_filter]
    if ticker_filter != "ALL":
        items = [item for item in items if pending_order_ticker(item) == ticker_filter]
    if side_filter != "ALL":
        items = [item for item in items if pending_order_side(item) == side_filter]
    write_page(items, page, page_size)


def paginate_signal_lifecycle(conn, payload):
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 20)
    direction_filter = normalize_filter(payload.get("direction"), {"HOLD", "BUY", "SELL_SHORT", "SELL_TO_CLOSE"})
    lifecycle_filter = normalize_filter(payload.get("lifecycleStatus"), signal_lifecycle_statuses())
    ticker_filter = normalize_ticker_filter(payload.get("ticker"))

    order_status_by_signal = {}
    for order in pending_lifecycle_items(conn):
        signal_id = signal_id_from_order(order)
        if not signal_id:
            continue
        previous = order_status_by_signal.get(signal_id)
        if previous is None or lifecycle_version(order) >= lifecycle_version(previous):
            order_status_by_signal[signal_id] = order

    skipped_exact = {}
    skipped_rows = read_kind_rows(conn, "skipped")
    skipped_items = [event_payload(row) for row in skipped_rows]
    for skipped in skipped_items:
        signal_id = skipped.get("signalId")
        if not signal_id:
            continue
        previous = skipped_exact.get(signal_id)
        if previous is None or lifecycle_version_skipped(skipped) >= lifecycle_version_skipped(previous):
            skipped_exact[signal_id] = skipped

    signals = []
    for row in read_kind_rows(conn, "signals"):
        signal = event_payload(row)
        if not isinstance(signal, dict):
            continue
        if ticker_filter != "ALL" and str(signal.get("ticker", "")).upper() != ticker_filter:
            continue
        if direction_filter != "ALL" and signal.get("side") != direction_filter:
            continue
        enriched = enrich_signal_lifecycle(signal, order_status_by_signal, skipped_exact, skipped_items)
        if lifecycle_filter != "ALL" and enriched.get("lifecycleStatus") != lifecycle_filter:
            continue
        signals.append(enriched)

    signals.sort(key=lambda item: lifecycle_version_signal(item), reverse=True)
    write_page(signals, page, page_size)


def paginate_candidate_pool_history(conn, payload):
    page = clamp_int(payload.get("page"), 1, 1_000_000, 1)
    page_size = clamp_int(payload.get("pageSize"), 1, 100, 20)
    status_group = normalize_filter(payload.get("statusGroup"), {"ACTIVE", "INACTIVE"})

    latest_by_candidate = {}
    for row in read_kind_rows(conn, "candidate_pool"):
        candidate = event_payload(row)
        if not isinstance(candidate, dict):
            continue
        candidate_id = candidate.get("candidateId")
        if not candidate_id:
            continue
        previous = latest_by_candidate.get(candidate_id)
        if previous is None or candidate_history_version(candidate) >= candidate_history_version(previous):
            latest_by_candidate[candidate_id] = candidate

    items = list(latest_by_candidate.values())
    if status_group == "ACTIVE":
        items = [item for item in items if candidate_history_group(item) == "ACTIVE"]
    else:
        items = [item for item in items if candidate_history_group(item) == "INACTIVE"]
    items.sort(key=candidate_history_version, reverse=True)
    write_page(items, page, page_size)


def pending_lifecycle_items(conn):
    base_by_id = {}
    latest_by_id = {}

    for kind in ("pending_orders", "rejected_orders"):
        for row in read_kind_rows(conn, kind):
            order = event_payload(row)
            if not isinstance(order, dict) or not order.get("id"):
                continue
            order_id = order.get("id")
            previous_base = base_by_id.get(order_id)
            if kind == "pending_orders" and (previous_base is None or lifecycle_version(order) >= lifecycle_version(previous_base)):
                base_by_id[order_id] = order
            previous = latest_by_id.get(order_id)
            if previous is None or lifecycle_version(order) >= lifecycle_version(previous):
                latest_by_id[order_id] = order

    for row in read_kind_rows(conn, "submitted_orders"):
        submitted = event_payload(row)
        if not isinstance(submitted, dict):
            continue
        order_id = submitted.get("pendingOrderId")
        if not order_id:
            continue
        base = base_by_id.get(order_id) or latest_by_id.get(order_id)
        if not isinstance(base, dict):
            continue
        derived = dict(base)
        derived["historyId"] = submitted.get("historyId")
        derived["status"] = "SUBMITTED" if submitted.get("ok") is True else "SUBMIT_FAILED"
        derived["updatedAt"] = submitted.get("submittedAt") or base.get("updatedAt") or base.get("createdAt")
        derived["submittedOrder"] = submitted
        previous = latest_by_id.get(order_id)
        if previous is None or lifecycle_version(derived) >= lifecycle_version(previous):
            latest_by_id[order_id] = derived

    items = list(latest_by_id.values())
    items.sort(key=lifecycle_version, reverse=True)
    return items


def read_kind_rows(conn, kind):
    table = table_for_kind(kind)
    if not table:
        return []
    return conn.execute(
        f"""
        SELECT id, payload FROM {table}
        ORDER BY id DESC
        """
    ).fetchall()


def write_page(items, page, page_size):
    total = len(items)
    total_pages = max(1, (total + page_size - 1) // page_size)
    safe_page = min(page, total_pages)
    offset = (safe_page - 1) * page_size
    write_json({"ok": True, "items": items[offset : offset + page_size], "page": safe_page, "pageSize": page_size, "total": total, "totalPages": total_pages})


def normalize_filter(value, allowed):
    normalized = str(value or "ALL").upper()
    return normalized if normalized in allowed else "ALL"


def normalize_ticker_filter(value):
    normalized = str(value or "ALL").upper().strip()
    if not normalized or normalized == "ALL":
        return "ALL"
    if "." in normalized:
        normalized = normalized.split(".", 1)[0]
    return normalized


def pending_order_ticker(order):
    intent = order.get("intent") if isinstance(order.get("intent"), dict) else {}
    return str(order.get("ticker") or intent.get("ticker") or "").upper()


def pending_order_side(order):
    intent = order.get("intent") if isinstance(order.get("intent"), dict) else {}
    return str(order.get("side") or intent.get("side") or "").upper()


def pending_statuses():
    return {"PENDING_CONFIRMATION", "CONFIRMED_SUBMITTING", "SUBMITTED", "REJECTED_BY_USER", "EXPIRED", "BLOCKED_BY_RISK", "SUBMIT_FAILED"}


def signal_lifecycle_statuses():
    return pending_statuses() | {"HOLD", "SKIPPED", "CANDIDATE_POOL"}


def candidate_history_group(candidate):
    status = str(candidate.get("status") or "").upper()
    if status in {"ACTIVE", "WATCH", "PROMOTED"}:
        return "ACTIVE"
    return "INACTIVE"


def signal_id_from_order(order):
    intent = order.get("intent") if isinstance(order.get("intent"), dict) else {}
    signal = order.get("signal") if isinstance(order.get("signal"), dict) else {}
    submitted = order.get("submittedOrder") if isinstance(order.get("submittedOrder"), dict) else {}
    return intent.get("signalId") or signal.get("id") or submitted.get("signalId")


def enrich_signal_lifecycle(signal, order_status_by_signal, skipped_exact, skipped_items):
    enriched = dict(signal)
    signal_id = signal.get("id")
    if signal.get("side") == "HOLD":
        enriched["lifecycleStatus"] = "HOLD"
        return enriched

    order = order_status_by_signal.get(signal_id)
    if order:
        enriched["lifecycleStatus"] = order.get("status")
        submitted = order.get("submittedOrder") if isinstance(order.get("submittedOrder"), dict) else {}
        if submitted.get("error"):
            enriched["lifecycleReason"] = submitted.get("error")
        return enriched

    persisted_status = signal.get("lifecycleStatus")
    if persisted_status and persisted_status != "CANDIDATE_POOL":
        return enriched

    skipped = skipped_exact.get(signal_id) or find_fallback_skipped(signal, skipped_items)
    if skipped:
        enriched["lifecycleStatus"] = "SKIPPED"
        enriched["lifecycleReason"] = skipped.get("reason")
        return enriched

    enriched["lifecycleStatus"] = "CANDIDATE_POOL"
    enriched["lifecycleReason"] = "已生成长桥信号，尚未形成待确认订单。"
    return enriched


def find_fallback_skipped(signal, skipped_items):
    signal_time = parse_time(signal.get("generatedAt"))
    if signal_time is None:
        return None
    ticker = str(signal.get("ticker", "")).upper()
    for skipped in skipped_items:
        if str(skipped.get("ticker", "")).upper() != ticker:
            continue
        if skipped.get("side") and skipped.get("side") != signal.get("side"):
            continue
        skipped_time = parse_time(skipped.get("updatedAt"))
        if skipped_time is None:
            continue
        delta = skipped_time - signal_time
        if 0 <= delta <= 10:
            return skipped
    return None


def lifecycle_version(order):
    history_id = order.get("historyId")
    if isinstance(history_id, int):
        return history_id
    try:
        return int(history_id)
    except (TypeError, ValueError):
        return parse_time(order.get("updatedAt")) or parse_time(order.get("createdAt")) or 0


def lifecycle_version_signal(signal):
    return parse_time(signal.get("generatedAt")) or lifecycle_version(signal)


def lifecycle_version_skipped(skipped):
    return lifecycle_version({"historyId": skipped.get("historyId"), "updatedAt": skipped.get("updatedAt"), "createdAt": skipped.get("updatedAt")})


def candidate_history_version(candidate):
    return (
        lifecycle_version({"historyId": candidate.get("historyId"), "updatedAt": candidate.get("lastSeenAt"), "createdAt": candidate.get("firstSeenAt")})
        or parse_time(candidate.get("expiresAt"))
        or 0
    )


def parse_time(value):
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def get_event_by_id(conn, payload):
    kind = payload.get("kind")
    event_id = clamp_int(payload.get("id"), 1, 10**18, 0)
    table = table_for_kind(kind)
    if not table or event_id <= 0:
        write_json({"ok": False, "error": "kind and positive id are required."})
        return
    row = conn.execute(f"SELECT id, payload FROM {table} WHERE id = ?", (event_id,)).fetchone()
    write_json({"ok": True, "item": event_payload(row) if row else None})


def find_event_by_payload_field(conn, payload):
    kind = payload.get("kind")
    field = payload.get("field")
    value = payload.get("value")
    table = table_for_kind(kind)
    if not table:
        write_json({"ok": False, "error": "Unsupported longbridge live history kind."})
        return
    if field not in {"id", "orderId", "signalId"} or value is None:
        write_json({"ok": False, "error": "Unsupported field or empty value."})
        return
    row = conn.execute(
        f"""
        SELECT id, payload FROM {table}
        WHERE json_extract(payload, '$.{field}') = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """,
        (str(value),),
    ).fetchone()
    write_json({"ok": True, "item": event_payload(row) if row else None})


def clear(conn):
    for table in TABLES.values():
        conn.execute(f"DELETE FROM {table}")
    write_json({"ok": True})


def insert_event(conn, kind, created_at, payload):
    table = table_for_kind(kind)
    intent = payload.get("intent") if isinstance(payload.get("intent"), dict) else {}
    conn.execute(
        f"""
        INSERT INTO {table}(ticker, side, strategy, status, ok, created_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(payload.get("ticker") or intent.get("ticker") or "").upper() or None,
            payload.get("side") or intent.get("side"),
            payload.get("strategy") or intent.get("strategy"),
            payload.get("status"),
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


def table_for_kind(kind):
    return TABLES.get(kind)


def read_payload():
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


def write_json(payload):
    print(json.dumps(payload, ensure_ascii=False))


def clamp_int(value, minimum, maximum, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


if __name__ == "__main__":
    main()
