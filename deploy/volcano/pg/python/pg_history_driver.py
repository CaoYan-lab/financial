"""PostgreSQL 历史库驱动垫片。

被 4 个历史脚本（live/simulation/report/longbridge_live history_db.py）
在 PG_HISTORY_DRIVER=1 时经 env 守卫调用。设计原则：

- 不复制任何业务逻辑。脚本中的 main()/action 函数原样运行，
  仅把 sqlite3.connect 替换为 PgConn 垫片，SQL 由垫片翻译成 PostgreSQL 方言。
- DDL（CREATE TABLE/INDEX）由 deploy/volcano/pg/schema.sql 统一所有，垫片内 no-op。
- 事件表 payload 为 JSONB：写入时占位符加 ::jsonb，读取时 payload::text 还原为 JSON 文本。
- A 股复用 live_history_db.py，但按 dbPath 文件名路由到独立表 ashare_events。
"""
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import psycopg


def _dsn():
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        return dsn
    url_file = Path(".data/cloud-pg/database_url")
    if url_file.exists():
        return url_file.read_text(encoding="utf-8").strip()
    raise RuntimeError("DATABASE_URL 未设置，且 .data/cloud-pg/database_url 不存在")


def _table_rewrite_for_dbpath(payload):
    db_path = str(payload.get("dbPath") or "")
    if "a-share" in db_path:
        return [("live_events", "ashare_events")]
    return []


class PgCursor:
    def __init__(self, cur):
        self._cur = cur
        self.lastrowid = None
        self.rowcount = cur.rowcount

    def fetchall(self):
        return _dict_rows(self._cur)

    def fetchone(self):
        rows = _dict_rows(self._cur, max_rows=1)
        return rows[0] if rows else None


class PgConn:
    """模拟 sqlite3.Connection 的最小接口。"""

    def __init__(self, dsn, table_rewrites):
        self._conn = psycopg.connect(dsn, autocommit=False)
        self._table_rewrites = table_rewrites
        self.row_factory = None  # 兼容脚本赋值 conn.row_factory = sqlite3.Row

    def execute(self, sql, params=()):
        translated, params = self._translate(sql, params)
        if translated is None:
            return _EmptyCursor()
        cur = self._conn.cursor()
        cur.execute(translated, params)
        cursor = PgCursor(cur)
        if "RETURNING" in translated:
            row = cur.fetchone()
            if row:
                cursor.lastrowid = row[0]
        return cursor

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False

    # ---- SQL 翻译 ----
    def _translate(self, sql, params):
        stripped = sql.lstrip().upper()
        if stripped.startswith("CREATE TABLE") or stripped.startswith("CREATE INDEX"):
            return None, params
        if stripped.startswith("PRAGMA"):
            return self._translate_pragma(sql), params

        out = sql
        out = self._rewrite_tables(out)
        out = self._translate_julianday(out)
        out = self._translate_json_extract(out)
        out = self._translate_insert_or_replace(out)
        out = self._select_payload_as_text(out)
        out, params = self._insert_jsonb_casts(out, params)
        out = out.replace("?", "%s")
        out = self._append_returning(out)
        return out, params

    @staticmethod
    def _select_payload_as_text(sql):
        # 仅替换 SELECT ... FROM 前缀中独立出现的 payload 列，避免动到 INSERT 列清单
        match = re.match(r"^(\s*SELECT\s+)(.*?)(\s+FROM\s+)", sql, re.IGNORECASE | re.DOTALL)
        if not match:
            return sql
        head, columns, tail = match.groups()
        columns = re.sub(r"\bpayload\b", "payload::text AS payload", columns)
        return head + columns + tail + sql[match.end():]

    def _rewrite_tables(self, sql):
        out = sql
        for source, target in self._table_rewrites:
            out = re.sub(rf"\b{source}\b", target, out)
        return out

    @staticmethod
    def _translate_julianday(sql):
        # ABS((julianday(created_at) - julianday(?)) * 86400.0) → 秒级时间差
        return re.sub(
            r"\(julianday\(created_at\)\s*-\s*julianday\(\?\)\)\s*\*\s*86400\.0",
            "EXTRACT(EPOCH FROM ((created_at)::timestamptz - (?)::timestamptz))",
            sql,
        )

    @staticmethod
    def _translate_json_extract(sql):
        # json_extract(payload, '$.field') → payload->>'field'
        return re.sub(
            r"json_extract\(payload,\s*'\$\.([^']+)'\)",
            r"payload->>'\1'",
            sql,
        )

    @staticmethod
    def _translate_insert_or_replace(sql):
        match = re.match(
            r"INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)",
            sql,
            re.IGNORECASE | re.DOTALL,
        )
        if not match:
            return sql
        table, cols_raw, placeholders = match.groups()
        cols = [c.strip() for c in cols_raw.split(",")]
        updates = ", ".join(f"{c}=excluded.{c}" for c in cols[1:])
        return (
            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT ({cols[0]}) DO UPDATE SET {updates}"
        )

    @staticmethod
    def _insert_jsonb_casts(sql, params):
        match = re.match(
            r"INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)",
            sql,
            re.IGNORECASE | re.DOTALL,
        )
        if not match or not isinstance(params, (list, tuple)):
            return sql, params
        _, cols_raw, placeholders = match.groups()
        cols = [c.strip() for c in cols_raw.split(",")]
        if "payload" not in cols:
            return sql, params
        placeholder_list = [p.strip() for p in placeholders.split(",")]
        payload_index = cols.index("payload")
        if payload_index < len(placeholder_list) and placeholder_list[payload_index] == "?":
            placeholder_list[payload_index] = "?::jsonb"
        rebuilt = sql.replace(placeholders, ", ".join(placeholder_list), 1)
        return rebuilt, params

    # 以 key 为主键、无 id 列的表（SQLite 侧也无 lastrowid 需求）
    _NO_ID_TABLES = {"simulation_meta", "simulation_config"}

    @staticmethod
    def _append_returning(sql):
        stripped = sql.lstrip().upper()
        if not stripped.startswith("INSERT") or "RETURNING" in sql.upper():
            return sql
        table_match = re.match(r"INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)", stripped)
        if table_match and table_match.group(1).lower() in PgConn._NO_ID_TABLES:
            return sql
        return sql.rstrip().rstrip(";") + "\nRETURNING id"

    @staticmethod
    def _translate_pragma(sql):
        match = re.search(r"PRAGMA\s+table_info\(\s*(\w+)\s*\)", sql, re.IGNORECASE)
        if match:
            table = match.group(1)
            return (
                "SELECT column_name AS name FROM information_schema.columns "
                f"WHERE table_name = '{table}'"
            )
        return "SELECT 1 WHERE FALSE"


class _EmptyCursor:
    lastrowid = None
    rowcount = 0

    def fetchall(self):
        return []

    def fetchone(self):
        return None


class _Sqlite3ModuleShim:
    Row = object

    def __init__(self, conn):
        self._conn = conn

    def connect(self, *args, **kwargs):
        return self._conn


def _dict_rows(cur, max_rows=None):
    if cur.description is None:
        return []
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchmany(max_rows) if max_rows is not None else cur.fetchall()
    return [dict(zip(columns, row)) for row in rows]


def _load_script_module(script_file):
    script_path = Path(script_file).resolve()
    module_name = "pg_history_script_" + re.sub(r"\W", "_", script_path.stem)
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    module = importlib.util.module_from_spec(spec)
    # 加载脚本期间临时关闭守卫，避免脚本顶部 env 守卫再次触发 run() 形成无限递归
    saved_flag = os.environ.pop("PG_HISTORY_DRIVER", None)
    try:
        spec.loader.exec_module(module)
    finally:
        if saved_flag is not None:
            os.environ["PG_HISTORY_DRIVER"] = saved_flag
    return module


def run(script_file):
    """由历史脚本顶部的 env 守卫调用：pg_history_driver.run(__file__)。"""
    module = _load_script_module(script_file)

    payload = {}
    try:
        raw = sys.stdin.read().strip()
        if raw:
            payload = json.loads(raw)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"PG driver payload parse failed: {exc}"}, ensure_ascii=False))
        return

    conn = PgConn(_dsn(), _table_rewrite_for_dbpath(payload))
    module.sqlite3 = _Sqlite3ModuleShim(conn)
    # stdin 已由驱动读取一次，注入回脚本，避免二次读取得到空输入
    if hasattr(module, "read_payload"):
        module.read_payload = lambda: payload

    try:
        module.main()
        conn.commit()
    except Exception as exc:
        conn.rollback()
        print(json.dumps({"ok": False, "error": f"PG driver: {exc}"}, ensure_ascii=False))
    finally:
        try:
            conn.close()
        except Exception:
            pass
