#!/usr/bin/env python3
"""本地 PostgreSQL 开发环境管理（基于 pgserver，无需 Docker）。

用法：
  python deploy/volcano/pg/local_pg.py start   # 启动/复用本地 PG、建库 financial、应用 schema.sql
  python deploy/volcano/pg/local_pg.py stop    # 停止本地 PG
  python deploy/volcano/pg/local_pg.py uri     # 打印 DATABASE_URL
  python deploy/volcano/pg/local_pg.py schema  # 仅重新应用 schema.sql

数据目录：.data/cloud-pg/（已被 .gitignore 忽略）
连接串写入：.data/cloud-pg/database_url
"""
import os
import sys
from pathlib import Path

PGDATA = Path(".data/cloud-pg/pgdata")
URL_FILE = Path(".data/cloud-pg/database_url")
SCHEMA_FILE = Path(__file__).with_name("schema.sql")
DB_NAME = "financial"


def _server(cleanup_mode=None):
    import pgserver

    PGDATA.parent.mkdir(parents=True, exist_ok=True)
    return pgserver.get_server(str(PGDATA), cleanup_mode=cleanup_mode)


def _ensure_database_and_schema(server):
    base_uri = server.get_uri()
    admin_uri = base_uri
    import psycopg

    with psycopg.connect(admin_uri, autocommit=True) as conn:
        exists = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DB_NAME,)).fetchone()
        if not exists:
            conn.execute(f'CREATE DATABASE "{DB_NAME}"')
    db_uri = _swap_database(base_uri, DB_NAME)
    URL_FILE.parent.mkdir(parents=True, exist_ok=True)
    URL_FILE.write_text(db_uri + "\n", encoding="utf-8")
    apply_schema(db_uri)
    return db_uri


def _swap_database(uri: str, dbname: str) -> str:
    # pgserver uri 形如 postgresql://postgres:@/postgres?host=<socketdir>
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(uri)
    return urlunsplit((parts.scheme, parts.netloc, f"/{dbname}", parts.query, parts.fragment))


def apply_schema(uri: str):
    import psycopg

    ddl = SCHEMA_FILE.read_text(encoding="utf-8")
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute(ddl)


def cmd_start():
    server = _server(cleanup_mode=None)
    db_uri = _ensure_database_and_schema(server)
    print(f"DATABASE_URL={db_uri}")
    print(f"已写入 {URL_FILE}")


def cmd_uri():
    if URL_FILE.exists():
        print(URL_FILE.read_text(encoding="utf-8").strip())
        return
    server = _server(cleanup_mode=None)
    print(_swap_database(server.get_uri(), DB_NAME))


def cmd_schema():
    uri = os.environ.get("DATABASE_URL") or (URL_FILE.read_text(encoding="utf-8").strip() if URL_FILE.exists() else None)
    if not uri:
        print("DATABASE_URL 未设置且本地未初始化，请先 start", file=sys.stderr)
        sys.exit(1)
    apply_schema(uri)
    print("schema applied")


def cmd_stop():
    server = _server(cleanup_mode=None)
    server.cleanup()
    print("stopped")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "start"
    {"start": cmd_start, "uri": cmd_uri, "schema": cmd_schema, "stop": cmd_stop}.get(
        command, lambda: (_ for _ in ()).throw(SystemExit(f"unknown command: {command}"))
    )()
