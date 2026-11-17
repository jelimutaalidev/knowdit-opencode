#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF_REPO="${KNOWDIT_REF_REPO:-$HOME/Dev/knowdit}"

if [[ ! -f "$REF_REPO/Cargo.toml" ]]; then
  echo "error: reference repo not found at $REF_REPO (set KNOWDIT_REF_REPO)" >&2
  exit 1
fi

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$REF_REPO/Cargo.toml" | head -n 1)"
if [[ "$VERSION" != "1.0.1" ]]; then
  echo "error: reference version is '$VERSION', expected 1.0.1" >&2
  exit 1
fi

cargo build --release -p knowdit --manifest-path "$REF_REPO/Cargo.toml"

DB_DIR="$ROOT/data/tmp"
mkdir -p "$DB_DIR" "$ROOT/.opencode/plugins/knowdit/src/db" "$ROOT/test/fixtures"

DB="$DB_DIR/reference.sqlite"
rm -f "$DB" "$DB-wal" "$DB-shm"

"$REF_REPO/target/release/knowdit" learn \
  --database-url "sqlite://$DB?mode=rwc" \
  init-db

sqlite3 "$DB" .schema \
  | grep -v '^CREATE TABLE sqlite_sequence' \
  > "$ROOT/.opencode/plugins/knowdit/src/db/schema.sql"

python3 - "$DB" "$ROOT/test/fixtures/schema-1.0.1.json" <<'PY'
import json
import subprocess
import sys

db, out = sys.argv[1], sys.argv[2]

tables = json.loads(
    subprocess.check_output(
        [
            "sqlite3",
            "-json",
            db,
            "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
        ]
    )
    or "[]"
)

rows = {}
for table in tables:
    name = table["name"]
    columns = json.loads(
        subprocess.check_output(["sqlite3", "-json", db, f"PRAGMA table_info({name})"]) or "[]"
    )
    rows[name] = [
        {
            "name": column["name"],
            "type": column["type"],
            "notnull": column["notnull"],
            "pk": column["pk"],
            "dflt_value": column["dflt_value"],
        }
        for column in columns
    ]

with open(out, "w", encoding="utf-8") as handle:
    json.dump({"version": "1.0.1", "tables": rows}, handle, indent=2)
    handle.write("\n")
PY

TABLES="$(sqlite3 "$DB" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'")"
CATEGORIES="$(sqlite3 "$DB" "select count(*) from category")"
SUBCATEGORIES="$(sqlite3 "$DB" "select count(*) from finding_category")"

if [[ "$TABLES" != "18" ]]; then
  echo "error: expected 18 tables, got $TABLES" >&2
  exit 1
fi
if [[ "$CATEGORIES" != "14" ]]; then
  echo "error: expected 14 categories, got $CATEGORIES" >&2
  exit 1
fi
if [[ "$SUBCATEGORIES" != "45" ]]; then
  echo "error: expected 45 finding categories, got $SUBCATEGORIES" >&2
  exit 1
fi

echo "wrote .opencode/plugins/knowdit/src/db/schema.sql ($TABLES tables, $CATEGORIES categories, $SUBCATEGORIES subcategories)"
