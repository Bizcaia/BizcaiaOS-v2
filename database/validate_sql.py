from pathlib import Path
from pglast import parse_sql

migration_dir = Path(__file__).resolve().parent
migration_files = sorted(migration_dir.glob("[0-9][0-9][0-9]_*.sql"))

if not migration_files:
    raise SystemExit("No migration files found")

for migration_file in migration_files:
    sql = migration_file.read_text(encoding="utf-8")
    statements = parse_sql(sql)
    print(f"OK {migration_file.name}: {len(statements)} PostgreSQL statements parsed")
