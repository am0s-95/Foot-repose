"""Apply migrations in order.

Run as a superuser (or a role that can create the roles and extensions in
0001). The application itself never holds these privileges.

    python -m db.migrate [--reset]
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

import psycopg

MIGRATIONS_DIR = pathlib.Path(__file__).parent / "migrations"
DB_NAME = "foot_repose"
ADMIN_DSN = "host=127.0.0.1 port=5432 dbname=postgres user=postgres"


def migration_files() -> list[pathlib.Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    for f in files:
        if not re.match(r"\A\d{4}_", f.name):
            raise SystemExit(f"migration {f.name} is missing its NNNN_ prefix")
    return files


def reset_database(admin_dsn: str = ADMIN_DSN, db_name: str = DB_NAME) -> None:
    with psycopg.connect(admin_dsn, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{db_name}"')


def ensure_database(admin_dsn: str = ADMIN_DSN, db_name: str = DB_NAME) -> None:
    with psycopg.connect(admin_dsn, autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (db_name,)
        ).fetchone()
        if not exists:
            conn.execute(f'CREATE DATABASE "{db_name}"')


def apply(dsn: str) -> list[str]:
    applied = []
    for path in migration_files():
        # Each migration is one transaction: a migration either lands whole or
        # not at all.
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(path.read_text())
            conn.commit()
        applied.append(path.name)
    return applied


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true", help="drop and recreate the database")
    parser.add_argument("--db", default=DB_NAME)
    parser.add_argument("--admin-dsn", default=ADMIN_DSN)
    args = parser.parse_args(argv)

    if args.reset:
        reset_database(args.admin_dsn, args.db)
    else:
        ensure_database(args.admin_dsn, args.db)

    dsn = f"host=127.0.0.1 port=5432 dbname={args.db} user=postgres"
    for name in apply(dsn):
        print(f"applied {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
