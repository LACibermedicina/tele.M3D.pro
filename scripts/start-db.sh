#!/bin/bash
PG_DATA_DIR="/home/runner/.local/share/replit/pg"
PG_SOCKET_DIR="/tmp"

if pg_ctl -D "$PG_DATA_DIR" status >/dev/null 2>&1; then
  exit 0
fi

if [ ! -f "$PG_DATA_DIR/PG_VERSION" ]; then
  echo "[start-db] Initializing local PostgreSQL..."
  mkdir -p "$PG_DATA_DIR"
  initdb -D "$PG_DATA_DIR" -U runner --no-locale --encoding=UTF8 >/dev/null 2>&1
fi

echo "[start-db] Starting local PostgreSQL..."
pg_ctl -D "$PG_DATA_DIR" -l "$PG_DATA_DIR/logfile" -o "-p 5432 -k $PG_SOCKET_DIR" start >/dev/null 2>&1
sleep 1

DB_EXISTS=$(psql "host=$PG_SOCKET_DIR port=5432 user=runner dbname=postgres" -t -c "SELECT count(*) FROM pg_database WHERE datname='neondb'" 2>/dev/null | tr -d ' ')
if [ "$DB_EXISTS" = "0" ]; then
  echo "[start-db] Creating neondb database..."
  psql "host=$PG_SOCKET_DIR port=5432 user=runner dbname=postgres" -c "CREATE DATABASE neondb;" >/dev/null 2>&1
fi

echo "[start-db] PostgreSQL ready."
