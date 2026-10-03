#!/usr/bin/env bash
# stop-host-dev.sh — stop the host-run stack start-host-dev.sh launched
# (anvil, oracle, indexer, attestor, keeper, web, clock keeper). Postgres is
# a system service and stays up.
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

LOG_DIR="${TMPDIR:-/tmp}/gusd-host"

case "${1:-}" in
  -h|--help) echo "usage: ./stop-host-dev.sh    # stop anvil + services (postgres untouched)"; exit 0 ;;
esac

for f in "$LOG_DIR"/*.pid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  name=$(basename "$f" .pid)
  if kill -0 "$pid" 2>/dev/null; then
    echo "stopping $name (pid $pid)"
    kill "$pid" 2>/dev/null || true
  else
    echo "$name already stopped (pid $pid gone)"
  fi
done
sleep 1
# The tsx/next children may outlive their nohup parent — sweep the ports.
for port in 8545 8080 9898 3000; do
  for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    echo "sweeping listener on :$port — pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null || true))"
    kill "$pid" 2>/dev/null || true
  done
done
sleep 1
for port in 8545 8080 9898 3000; do
  for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    kill -9 "$pid" 2>/dev/null || true
  done
done
rm -f "$LOG_DIR"/*.pid
# A listener child killed above leaves its `tsx watch`/`next` parent alive to
# respawn — sweep those too (a respawned oracle races the next start's port).
# The tsx watcher cmdline is "node …/tsx/dist/cli.mjs watch src/main.ts".
pkill -f "cli.mjs watch" 2>/dev/null || true
pkill -f "envio.*start" 2>/dev/null || true
pkill -f "next-server|next dev" 2>/dev/null || true
echo "host dev stack down (postgres untouched)"