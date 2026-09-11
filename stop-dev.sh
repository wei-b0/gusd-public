#!/usr/bin/env bash
# stop-dev.sh — stop the local dev stack: compose down (postgres volume KEPT)
# and anvil. Idempotent; safe to run when nothing is up.
#
#   ./stop-dev.sh [--volumes]    --volumes ALSO deletes gusd-postgres-data
#                                (all indexed + market data — destructive, asks)
set -euo pipefail

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

COMPOSE="infra/docker-compose.yml"
LOG_DIR="${TMPDIR:-/tmp}/gusd-dev"
PID_FILE="$LOG_DIR/anvil.pid"
VOLUMES=0

log() { echo "[stop-dev] $*"; }
die() { echo "[stop-dev] ERROR: $1" >&2; exit "${2:-1}"; }

usage() { echo "usage: ./stop-dev.sh [--volumes]"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --volumes) VOLUMES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[stop-dev] unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

docker info >/dev/null 2>&1 || die "Docker daemon not running — nothing docker-side to stop" 1

if [ "$VOLUMES" = 1 ]; then
  reply=""
  printf "[stop-dev] delete the gusd-postgres-data volume (all indexed + market data)? [y/N] "
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) log "aborted — volume preserved"; exit 0 ;;
  esac
  log "docker compose down --volumes (wiping postgres data)..."
  docker compose -f "$COMPOSE" down --volumes --remove-orphans || true
else
  log "docker compose down (postgres volume preserved)..."
  docker compose -f "$COMPOSE" down --remove-orphans || true
fi

# Compose matches by project label (infra); containers brought up under a
# foreign project name survive `down` — sweep the pinned gusd-* names.
residual=$(docker ps -aq --filter "name=gusd-" 2>/dev/null || true)
if [ -n "$residual" ]; then
  log "removing residual gusd-* containers"
  echo "$residual" | xargs docker rm -f >/dev/null 2>&1 || true
fi

# Anvil: pid-file first (guarded against pid reuse), then a port sweep.
if [ -f "$PID_FILE" ]; then
  anvil_pid=$(cat "$PID_FILE" 2>/dev/null || true)
  anvil_cmd=$(ps -o comm= -p "$anvil_pid" 2>/dev/null || true)
  case "$anvil_cmd" in
    *anvil*)
      log "stopping anvil (pid $anvil_pid)"
      kill "$anvil_pid" 2>/dev/null || true
      ;;
    "") ;;
    *) log "pid-file pid $anvil_pid runs '$anvil_cmd' now — leaving it (pid reuse)" ;;
  esac
  rm -f "$PID_FILE"
fi
kill_shadows() { # kill_shadows PORT LABEL — kill NON-Docker listeners on PORT
  local port="$1" label="$2" pid cmd
  for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    cmd=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$cmd" in
      ""|*docker*|*Docker*) ;;
      *) log "killing $label on :$port — pid $pid ($cmd)"; kill "$pid" 2>/dev/null || true ;;
    esac
  done
  sleep 1
  for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    cmd=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$cmd" in
      ""|*docker*|*Docker*) ;;
      *) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
}
kill_shadows 8545 "anvil"

# Leftover host-run dev:oracle on 8080: docker's proxy is gone after down, so
# anything still listening is foreign. Warn only — it's the user's call.
for pid in $(lsof -t -iTCP:8080 -sTCP:LISTEN 2>/dev/null || true); do
  cmd=$(ps -o comm= -p "$pid" 2>/dev/null || true)
  case "$cmd" in
    ""|*docker*|*Docker*) ;;
    *) log "WARN: pid $pid ($cmd) still listens on :8080 — a host-run dev:oracle shadows the docker oracle on next start; kill it or ignore" ;;
  esac
done

echo
if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q 'gusd-postgres-data'; then
  log "kept postgres volume (indexed + market data) — host port 54329"
else
  log "postgres volume deleted"
fi
log "web dev server (if running) is manual and untouched — stop it yourself"
log "logs kept in $LOG_DIR"