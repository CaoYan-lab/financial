#!/usr/bin/env python3
"""Create or remove the disposable local financial_test database."""

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg import sql

TEST_DB = "financial_test"
URL_FILE = Path(".data/cloud-pg/database_url")


def swap_database(uri: str, database: str) -> str:
    parts = urlsplit(uri)
    return urlunsplit((parts.scheme, parts.netloc, f"/{database}", parts.query, parts.fragment))


def local_uri() -> str:
    source = os.environ.get("LOCAL_PG_BASE_URL")
    if not source and URL_FILE.exists():
        source = URL_FILE.read_text(encoding="utf-8").strip()
    if not source:
        raise SystemExit("本地 PostgreSQL 未初始化，请先运行 local_pg.py start")
    parts = urlsplit(source)
    host = parts.hostname
    query = parts.query
    if host not in (None, "", "localhost", "127.0.0.1", "::1") and "host=%2F" not in query and "host=/" not in query:
        raise SystemExit("拒绝对非本地 PostgreSQL 创建或删除测试数据库")
    return source


def admin_uri() -> str:
    return swap_database(local_uri(), "postgres")


def test_uri() -> str:
    return swap_database(local_uri(), TEST_DB)


def drop() -> None:
    with psycopg.connect(admin_uri(), autocommit=True) as connection:
        connection.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = %s AND pid <> pg_backend_pid()",
            (TEST_DB,),
        )
        connection.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(TEST_DB)))


def create() -> None:
    drop()
    with psycopg.connect(admin_uri(), autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(TEST_DB)))
    with psycopg.connect(test_uri(), autocommit=True) as connection:
        connection.execute(Path("deploy/volcano/pg/schema.sql").read_text(encoding="utf-8"))
        connection.execute(Path("deploy/volcano/pg/multiuser_schema.sql").read_text(encoding="utf-8"))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "uri"
    if command == "create":
        create()
        print(test_uri())
    elif command == "drop":
        drop()
    elif command == "uri":
        print(test_uri())
    else:
        raise SystemExit(f"未知命令：{command}")
