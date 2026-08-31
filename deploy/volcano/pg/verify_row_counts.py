#!/usr/bin/env python3
"""SQLite 与 PostgreSQL 迁移对账。

对每张表比较：
- 行数
- 按 id 排序后 payload 文本的 md5 汇总（检测内容差异）

退出码 0 = 全部一致；1 = 存在差异。
"""
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / ".data"

from migrate_sqlite_to_pg import DB_TABLE_MAP, ID_TABLES, dsn, sqlite_tables  # noqa: E402

PAYLOAD_TABLES = set(ID_TABLES) - {"reports", "report_top_opportunities"}


def sqlite_count(conn, table):
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def pg_count(conn, table):
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _canonical(payload):
    obj = json.loads(payload) if isinstance(payload, str) else payload
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sqlite_payload_checksum(conn, table):
    rows = conn.execute(f"SELECT payload FROM {table} ORDER BY id").fetchall()
    digest = hashlib.md5()
    for (payload,) in rows:
        digest.update(_canonical(payload).encode("utf-8"))
    return digest.hexdigest(), len(rows)


def pg_payload_checksum(conn, table):
    rows = conn.execute(f"SELECT payload::text FROM {table} ORDER BY id").fetchall()
    digest = hashlib.md5()
    for (payload,) in rows:
        digest.update(_canonical(payload).encode("utf-8"))
    return digest.hexdigest(), len(rows)


def main():
    mismatches = []
    lines = []
    with psycopg.connect(dsn()) as pg_conn:
        for filename, table_map in DB_TABLE_MAP.items():
            sqlite_path = DATA_DIR / filename
            if not sqlite_path.exists():
                lines.append(f"  {filename}: 源库不存在，跳过")
                continue
            with sqlite3.connect(str(sqlite_path)) as sconn:
                present = set(sqlite_tables(sconn))
                for source_table, target_table in table_map.items():
                    if source_table not in present:
                        continue
                    s_count = sqlite_count(sconn, source_table)
                    p_count = pg_count(pg_conn, target_table)
                    status = "OK" if s_count == p_count else "差异"
                    line = f"  {filename}:{source_table} → {target_table}: sqlite={s_count} pg={p_count} [{status}]"
                    lines.append(line)
                    if s_count != p_count:
                        mismatches.append(line)
                        continue
                    if target_table in PAYLOAD_TABLES and s_count > 0:
                        s_sum, _ = sqlite_payload_checksum(sconn, source_table)
                        p_sum, _ = pg_payload_checksum(pg_conn, target_table)
                        if s_sum != p_sum:
                            mismatches.append(line + " payload 校验和不一致")

    print("=== 迁移对账 ===")
    for line in lines:
        print(line)
    if mismatches:
        print("\n对账失败：")
        for line in mismatches:
            print("  " + line)
        return 1
    print("\n对账通过：行数一致，事件 payload 校验和一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
