#!/usr/bin/env bash
#
# Run a private PostgreSQL instance owned by the current user.
# No sudo needed: it initialises its own data directory inside the project,
# listens on 127.0.0.1:5433 (so it never collides with the system server on
# 5432) and creates the role + database the backend expects.
#
#   bash server/scripts/setup-local-pg.sh          # create/start + provision
#   bash server/scripts/setup-local-pg.sh status   # is it running?
#   bash server/scripts/setup-local-pg.sh stop     # shut it down
#
set -euo pipefail

PGBIN="/usr/lib/postgresql/14/bin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGDATA="$ROOT/server/pgdata"
PGSOCK="$ROOT/server/pgsock"
PGLOG="$ROOT/server/pg.log"
PGPORT="${PGPORT:-5433}"
DB_NAME="${DB_NAME:-tradingdemo}"
DB_USER="${DB_USER:-tradingdemo}"
DB_PASS="${DB_PASS:-tradingdemo_pass}"
ACTION="${1:-up}"

if [ "$ACTION" = "status" ]; then
  "$PGBIN/pg_ctl" -D "$PGDATA" status || true
  exit 0
fi

if [ "$ACTION" = "stop" ]; then
  "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast || true
  exit 0
fi

# ---- 1. initialise the cluster once -----------------------------------------
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "→ initialising a private cluster in server/pgdata"
  mkdir -p "$PGDATA" "$PGSOCK"
  chmod 700 "$PGDATA"
  "$PGBIN/initdb" -D "$PGDATA" -U hamsa \
    --auth-local=trust --auth-host=scram-sha-256 \
    --encoding=UTF8 --locale=C >/dev/null
else
  echo "→ cluster already initialised"
fi

mkdir -p "$PGSOCK"

# ---- 2. start it if it is not already running --------------------------------
if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "→ already running"
else
  echo "→ starting on 127.0.0.1:${PGPORT}"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGLOG" \
    -o "-p ${PGPORT} -k ${PGSOCK} -c listen_addresses=127.0.0.1" start >/dev/null
fi

echo -n "→ waiting for readiness"
for _ in $(seq 1 40); do
  if "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then
    echo " ok"
    break
  fi
  echo -n "."
  sleep 0.5
done

# ---- 3. provision the role + database ---------------------------------------
"$PGBIN/psql" -h "$PGSOCK" -p "$PGPORT" -U hamsa -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

if "$PGBIN/psql" -h "$PGSOCK" -p "$PGPORT" -U hamsa -d postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "→ database '${DB_NAME}' already exists"
else
  echo "→ creating database '${DB_NAME}'"
  "$PGBIN/createdb" -h "$PGSOCK" -p "$PGPORT" -U hamsa -O "$DB_USER" "$DB_NAME"
fi

# ---- 4. verify as the application user --------------------------------------
PGPASSWORD="$DB_PASS" "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT current_database() AS db, current_user AS role;"

echo
echo "✓ PostgreSQL ready on 127.0.0.1:${PGPORT}"
echo "  DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${PGPORT}/${DB_NAME}"
