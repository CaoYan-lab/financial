#!/usr/bin/env python3
"""SQLite 历史库 → PostgreSQL 幂等迁移。

- 全程只读 SQLite，不写不删源文件。
- 保留原始 id（INSERT ... ON CONFLICT (id) DO NOTHING），可反复重跑。
- 迁移完成后重置 PG 序列，保证后续新增行 id 不冲突。
- 源库映射：
    simulation-history.sqlite3      → simulation_events / simulation_meta / simulation_config
    live-trading-history.sqlite3    → live_events + longbridge_live_*
    a-share-live-history.sqlite3    → live_events → ashare_events
    top30-report-history.sqlite3    → reports / report_top_opportunities

用法：
  DATABASE_URL=... .venv-cloud/bin/python deploy/volcano/pg/migrate_sqlite_to_pg.py
"""
import json
import os
import sqlite3
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / ".data"

# 源 sqlite 文件 → 表名映射规则（源表名 → PG 目标表名）
DB_TABLE_MAP = {
    "simulation-history.sqlite3": {
        "simulation_events": "simulation_events",
        "simulation_meta": "simulation_meta",
        "simulation_config": "simulation_config",
    },
    "live-trading-history.sqlite3": {
        "live_events": "live_events",
        "longbridge_live_signals": "longbridge_live_signals",
        "longbridge_live_pending_orders": "longbridge_live_pending_orders",
        "longbridge_live_submitted_orders": "longbridge_live_submitted_orders",
        "longbridge_live_rejected_orders": "longbridge_live_rejected_orders",
        "longbridge_live_skipped": "longbridge_live_skipped",
        "longbridge_live_confirmations": "longbridge_live_confirmations",
        "longbridge_live_candidate_pool": "longbridge_live_candidate_pool",
    },
    "a-share-live-history.sqlite3": {
        "live_events": "ashare_events",
    },
    "top30-report-history.sqlite3": {
        "reports": "reports",
        "report_top_opportunities": "report_top_opportunities",
    },
}

# 含 id 主键的表（迁移后需要重置序列）
ID_TABLES = [
    "live_events",
    "ashare_events",
    "simulation_events",
    "longbridge_live_signals",
    "longbridge_live_pending_orders",
    "longbridge_live_submitted_orders",
    "longbridge_live_rejected_orders",
    "longbridge_live_skipped",
    "longbridge_live_confirmations",
    "longbridge_live_candidate_pool",
    "reports",
    "report_top_opportunities",
]

# payload 类 JSON 列（sqlite 为 TEXT，PG 为 JSONB）
JSONB_COLUMNS = {"payload"}

# 有外键依赖，先父后子
TABLE_ORDER_HINT = {"reports": 0, "report_top_opportunities": 1}


def dsn():
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    url_file = DATA_DIR / "cloud-pg" / "database_url"
    if url_file.exists():
        return url_file.read_text(encoding="utf-8").strip()
    raise RuntimeError("DATABASE_URL 未设置且 .data/cloud-pg/database_url 不存在")


def sqlite_tables(conn):
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return [row[0] for row in rows]


def sqlite_columns(conn, table):
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def copy_table(pg_conn, sqlite_conn, source_table, target_table):
    columns = sqlite_columns(sqlite_conn, source_table)
    if not columns:
        return 0, 0
    rows = sqlite_conn.execute(f"SELECT {', '.join(columns)} FROM {source_table}").fetchall()
    if not rows:
        return 0, 0

    insert_cols = ", ".join(columns)
    value_placeholders = ", ".join(
        ("%s::jsonb" if col in JSONB_COLUMNS else "%s") for col in columns
    )
    conflict = " ON CONFLICT (id) DO NOTHING" if "id" in columns else ""
    sql = f"INSERT INTO {target_table} ({insert_cols}) VALUES ({value_placeholders}){conflict}"

    inserted = 0
    with pg_conn.cursor() as cur:
        for row in rows:
            params = tuple(row)
            cur.execute(sql, params)
            inserted += cur.rowcount if cur.rowcount is not None else 1
    return len(rows), inserted


def reset_sequences(pg_conn):
    with pg_conn.cursor() as cur:
        for table in ID_TABLES:
            cur.execute(
                f"""
                SELECT setval(
                    pg_get_serial_sequence('{table}', 'id'),
                    GREATEST(COALESCE((SELECT MAX(id) FROM {table}), 1), 1),
                    true
                )
                """
            )


def main():
    pg_dsn = dsn()
    summary = []
    with psycopg.connect(pg_dsn, autocommit=False) as pg_conn:
        if os.environ.get("RESET_PG") == "1":
            # 仅开发/首次迁移使用：清空全部目标表
            with pg_conn.cursor() as cur:
                for table in reversed(ID_TABLES):
                    cur.execute(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE")
                cur.execute("TRUNCATE TABLE simulation_meta, simulation_config RESTART IDENTITY")
            summary.append(("RESET_PG", "已清空目标表"))
        for filename, table_map in DB_TABLE_MAP.items():
            sqlite_path = DATA_DIR / filename
            if not sqlite_path.exists():
                summary.append((filename, "(源库不存在，跳过)"))
                continue
            with sqlite3.connect(str(sqlite_path)) as sconn:
                sconn.row_factory = sqlite3.Row
                present = set(sqlite_tables(sconn))
                targets = [(s, t) for s, t in table_map.items() if s in present]
                targets.sort(key=lambda pair: TABLE_ORDER_HINT.get(pair[1], 5))
                for source_table, target_table in targets:
                    total, inserted = copy_table(pg_conn, sconn, source_table, target_table)
                    summary.append((f"{filename}:{source_table} → {target_table}", f"{inserted}/{total} 行迁入"))
        reset_sequences(pg_conn)
        pg_conn.commit()

    print("=== 迁移结果 ===")
    for name, result in summary:
        print(f"  {name}: {result}")
    print("迁移完成（幂等：重复行已跳过，序列已重置）")


if __name__ == "__main__":
    sys.exit(main())
