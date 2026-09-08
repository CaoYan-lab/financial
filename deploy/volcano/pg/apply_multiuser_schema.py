#!/usr/bin/env python3
"""Apply the isolated multiuser schema to the configured PostgreSQL database."""

import os
from pathlib import Path

import psycopg


def main() -> None:
    url_file = Path(".data/cloud-pg/database_url")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url and url_file.exists():
        database_url = url_file.read_text(encoding="utf-8").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL 未设置，且本地 PostgreSQL 尚未初始化")

    schema_path = Path(__file__).with_name("multiuser_schema.sql")
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(schema_path.read_text(encoding="utf-8"))
        table_count = connection.execute(
            """
            SELECT count(*)
            FROM information_schema.tables
            WHERE table_schema = 'multiuser'
            """
        ).fetchone()[0]
    print(f"multiuser schema applied: {table_count} tables")


if __name__ == "__main__":
    main()
