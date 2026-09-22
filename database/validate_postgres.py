#!/usr/bin/env python3
"""Statically parse PostgreSQL migration files with pglast.

Usage:
  python validate_postgres.py path/to/migrations
  python validate_postgres.py migration1.sql migration2.sql
"""

from __future__ import annotations

import argparse
from pathlib import Path

try:
    from pglast import parse_sql
except ImportError as exc:
    raise SystemExit(
        "pglast is required. Install it with: sudo pip3 install pglast"
    ) from exc


def collect_sql_files(paths: list[Path]) -> list[Path]:
    files: set[Path] = set()
    for path in paths:
        resolved = path.expanduser().resolve()
        if resolved.is_dir():
            files.update(resolved.glob("[0-9][0-9][0-9]_*.sql"))
        elif resolved.is_file() and resolved.suffix.lower() == ".sql":
            files.add(resolved)
        else:
            raise SystemExit(f"Not a SQL file or migration directory: {path}")
    return sorted(files)


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse PostgreSQL migrations")
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()

    migration_files = collect_sql_files(args.paths)
    if not migration_files:
        raise SystemExit("No numbered SQL migration files found")

    total_statements = 0
    for migration_file in migration_files:
        statements = parse_sql(migration_file.read_text(encoding="utf-8"))
        total_statements += len(statements)
        print(f"OK {migration_file}: {len(statements)} statements")

    print(f"Validated {len(migration_files)} files and {total_statements} statements")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
