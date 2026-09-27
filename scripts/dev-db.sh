#!/usr/bin/env bash
# Starts a local Postgres for development and tests on port 54329.
# Uses Docker when available; otherwise a local PostgreSQL installation (16 or newer).
set -euo pipefail

PORT=54329
NAME=dentalos-dev-db

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    docker run -d --name "$NAME" -p "$PORT:5432" -e POSTGRES_PASSWORD=postgres postgres:17 >/dev/null
  else
    docker start "$NAME" >/dev/null
  fi
  until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  docker exec "$NAME" psql -U postgres -tc "select 1 from pg_database where datname='dentalos'" | grep -q 1 \
    || docker exec "$NAME" psql -U postgres -c "create database dentalos" >/dev/null
else
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$PG_BIN" ] || PG_BIN="$(dirname "$(command -v pg_ctl)")"
  DATA_DIR="$(pwd)/.dev-db"
  RUN_AS=()
  if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); chown -R postgres "$DATA_DIR" 2>/dev/null || true; fi
  if [ ! -d "$DATA_DIR/base" ]; then
    mkdir -p "$DATA_DIR"; [ "$(id -u)" = "0" ] && chown postgres "$DATA_DIR"
    echo postgres > /tmp/dentalos-pw
    "${RUN_AS[@]}" "$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --pwfile=/tmp/dentalos-pw -A scram-sha-256 >/dev/null
    rm -f /tmp/dentalos-pw
  fi
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -k /tmp" -l "$DATA_DIR/server.log" status >/dev/null 2>&1 \
    || "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -k /tmp" -l "$DATA_DIR/server.log" -w start >/dev/null
  PGPASSWORD=postgres psql -h localhost -p "$PORT" -U postgres -tc "select 1 from pg_database where datname='dentalos'" | grep -q 1 \
    || PGPASSWORD=postgres psql -h localhost -p "$PORT" -U postgres -c "create database dentalos" >/dev/null
fi

echo "Postgres ready:"
echo "  DATABASE_URL=postgres://postgres:postgres@localhost:$PORT/dentalos"
echo "  TEST_DATABASE_URL=postgres://postgres:postgres@localhost:$PORT/postgres"
