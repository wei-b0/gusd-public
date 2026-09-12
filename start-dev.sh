#!/usr/bin/env bash
# start-dev.sh — the whole local posture in one command: fresh Anvil, a full
# Deploy.full redeploy (addresses rotate every run), stale indexer schemas
# dropped, and the compose backend up with the publisher's oracle address
# injected. The web dev server stays manual (command printed at the end).
#
#   ./start-dev.sh [--build]     --build also rebuilds the docker images
#                                (default: reuse the existing ones)
#
# Logs land in ${TMPDIR:-/tmp}/gusd-dev and survive the run for debugging;
# on a phase failure the chain/containers are left up on purpose.
set -euo pipefail

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

COMPOSE="infra/docker-compose.yml"
ENV_FILE="infra/.env"
CONTRACTS="apps/contracts"
RECORD="$CONTRACTS/deployments/31337.json"
RPC_URL="http://127.0.0.1:8545"
CHAIN_ID="31337"
ANVIL_PORT="8545"
# Anvil account #0 — a public dev key, valid ONLY on the local test posture.
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOY_SIG="runFull()"
LOG_DIR="${TMPDIR:-/tmp}/gusd-dev"
PID_FILE="$LOG_DIR/anvil.pid"
BUILD=0
ANVIL_PID=""

log() { echo "[start-dev] $*"; }
die() {
  echo "[start-dev] ERROR: $1" >&2
  echo "[start-dev] logs: $LOG_DIR (chain/containers left up for debugging)" >&2
  exit "${2:-1}"
}

usage() { echo "usage: ./start-dev.sh [--build]"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[start-dev] unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$LOG_DIR"

# Interrupted mid-run: take our anvil down with us. Phase failures (die) do
# NOT trigger this — they deliberately leave the scene debuggable.
trap '[ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null; exit 130' INT TERM

# infra/.env is what compose interpolates, so honor it for the two values the
# script curls/drops against (never set them here — compose owns them).
env_var() { # env_var NAME DEFAULT
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "\"' \r")
  printf '%s' "${v:-$2}"
}
ORACLE_PORT="$(env_var ORACLE_PORT 8080)"
export ORACLE_PORT
INDEXER_SCHEMA="$(env_var INDEXER_SCHEMA gusd_index_envio_docker_v1)"

wait_until() { # wait_until DESC TIMEOUT_S CMD... — poll every 2s
  local desc="$1" timeout="$2" start
  shift 2
  start=$(date +%s)
  while ! "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -ge $(( start + timeout )) ] && return 1
    sleep 2
  done
  log "$desc ok ($(( $(date +%s) - start ))s)"
}

container_healthy() {
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = "healthy" ]
}

kill_shadows() { # kill_shadows PORT LABEL — kill NON-Docker listeners on PORT.
  # Docker Desktop's own proxy legitimately binds *:PORT for published
  # containers — a naive lsof|kill would take Docker itself down.
  local port="$1" label="$2" pid cmd
  for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    cmd=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$cmd" in
      ""|*docker*|*Docker*) log "port $port held by Docker itself (pid $pid) — leaving it" ;;
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

# --- JSON gates (node >= 24: global fetch + AbortSignal.timeout) -------------
oracle_healthy() {
  node -e '
    fetch(`http://127.0.0.1:${process.env.ORACLE_PORT || "8080"}/v1/health`, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json())
      .then((j) => process.exit(j.status === "healthy" && j.indexer && j.indexer.status === "healthy" ? 0 : 1))
      .catch(() => process.exit(1));
  '
}

pools_ready() { # canonical SKU pools indexed >= 4 (rows include non-SKU pools)
  node -e '
    fetch(`http://127.0.0.1:${process.env.ORACLE_PORT || "8080"}/v1/protocol/pools`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .then((j) => {
        const n = (j.pools || []).filter((p) => p.canonical === true && p.gpuId != null).length;
        console.error("canonical SKU pools indexed: " + n + "/4");
        process.exit(n >= 4 ? 0 : 1);
      })
      .catch(() => process.exit(1));
  '
}

record_ok() { # the freshly written deployment record must be complete
  node -e '
    let r;
    try { r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); }
    catch { process.exit(1); }
    const hex = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
    const ok = r.chainId === 31337 && hex(r.oracle) && hex(r.gpuQuoter) && hex(r.marketLiquidity)
      && Array.isArray(r.stables) && r.stables.length === 2 && r.stables.every(hex)
      && Number.isInteger(r.startBlock) && r.startBlock >= 0;
    process.exit(ok ? 0 : 1);
  ' "$RECORD"
}

# --- 1. prereqs ---------------------------------------------------------------
docker info >/dev/null 2>&1 || die "Docker daemon not running — start Docker Desktop" 1
command -v pnpm >/dev/null 2>&1 || die "pnpm not found — corepack enable" 1
command -v forge >/dev/null 2>&1 || die "forge not on PATH — install Foundry" 1
command -v anvil >/dev/null 2>&1 || die "anvil not on PATH — install Foundry" 1

missing=""
for img in gusd-indexer:local gusd-oracle:local gusd-publisher:local; do
  docker image inspect "$img" >/dev/null 2>&1 || missing="$missing $img"
done
if [ -n "$missing" ] && [ "$BUILD" = 0 ]; then
  # Fail BEFORE the 2-minute deploy instead of at compose-up time.
  die "docker image(s) missing:$missing — run ./start-dev.sh --build (first run only)" 2
fi

# --- 2. clear port shadows + any old stack --------------------------------------
kill_shadows 8080 "host dev:oracle"
kill_shadows 8545 "stale anvil"
log "docker compose down (postgres volume preserved)..."
docker compose -f "$COMPOSE" down --remove-orphans >>"$LOG_DIR/stack.log" 2>&1 || true
residual=$(docker ps -aq --filter "name=gusd-" 2>/dev/null || true)
if [ -n "$residual" ]; then
  log "removing residual gusd-* containers (foreign compose project labels)"
  echo "$residual" | xargs docker rm -f >/dev/null 2>&1 || true
fi

# --- 3. fresh anvil ---------------------------------------------------------------
# 127.0.0.1 bind is right on macOS (Docker's host.docker.internal reaches host
# loopback); Linux hosts need --host 0.0.0.0 for host-gateway reachability.
log "starting fresh anvil on :$ANVIL_PORT ..."
nohup anvil --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" >"$LOG_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" >"$PID_FILE"

rpc_ok() {
  curl -fsS --max-time 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    "$RPC_URL" 2>/dev/null | grep -q '"result"'
}
if ! wait_until "anvil RPC" 30 rpc_ok; then
  if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
    tail -n 20 "$LOG_DIR/anvil.log" >&2 || true
    die "anvil exited during startup — see $LOG_DIR/anvil.log" 3
  fi
  die "anvil RPC not answering within 30s — see $LOG_DIR/anvil.log" 3
fi

# --- 4. deploy the full catalogue ---------------------------------------------------
# The chain was just reset, so any recorded broadcast is stale (forge re-sends
# the recorded calldata verbatim) — wipe it before deploying.
log "wiping stale Deploy.full broadcast + cache..."
rm -rf "$CONTRACTS/broadcast/Deploy.full.s.sol" "$CONTRACTS/cache/Deploy.full.s.sol"
log "deploying full catalogue (~140 txs, a couple of minutes)..."
if ! ( cd "$CONTRACTS" && PRIVATE_KEY="$ANVIL_KEY" forge script script/Deploy.full.s.sol \
      --rpc-url "$RPC_URL" --broadcast --sig "$DEPLOY_SIG" ) >"$LOG_DIR/deploy.log" 2>&1; then
  echo "[start-dev] deploy failed — last 40 lines of $LOG_DIR/deploy.log:" >&2
  tail -n 40 "$LOG_DIR/deploy.log" >&2 || true
  exit 4
fi

# --- 5. record sanity -----------------------------------------------------------------
# stack:up injects the record's .oracle into the publisher silently-empty when
# absent — the publisher then crash-loops by design. Fail here instead.
if ! record_ok; then
  die "deployment record missing/incomplete (no .oracle?) — publisher would crash-loop; see $LOG_DIR/deploy.log" 4
fi
ORACLE_ADDR=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.oracle)' "$RECORD")
USDT_ADDR=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.stables[1])' "$RECORD")
log "deployed — oracle $ORACLE_ADDR"

# --- 6. postgres first, then reset the selected indexer schemas --------------------------
log "starting postgres..."
docker compose -f "$COMPOSE" up -d postgres >>"$LOG_DIR/stack.log" 2>&1 \
  || { tail -n 40 "$LOG_DIR/stack.log" >&2 || true; die "postgres failed to start" 5; }
wait_until "postgres healthy" 60 container_healthy gusd-postgres \
  || { docker logs --tail 40 gusd-postgres >&2 || true; die "postgres never went healthy" 5; }

schema_list=$(docker exec gusd-postgres psql -U gusd -d gusd -Atc \
  "SELECT string_agg(quote_ident(nspname), ', ') FROM pg_namespace
   WHERE nspname = '${INDEXER_SCHEMA}' OR nspname = 'ponder_sync' OR nspname LIKE 'gusd_index_docker%';")
if [ -n "$schema_list" ]; then
  log "dropping indexer schemas: $schema_list"
  # client_min_messages=warning keeps the ~100-line CASCADE notice spam off
  # the terminal; errors still print, ON_ERROR_STOP makes psql exit nonzero.
  docker exec gusd-postgres psql -U gusd -d gusd -v ON_ERROR_STOP=1 \
    -c "SET client_min_messages = warning; DROP SCHEMA $schema_list CASCADE;" \
    || die "schema drop failed — is a host-run indexer (pnpm dev:indexer) still attached?" 5
else
  log "no indexer schemas to drop"
fi
other_schemas=$(docker exec gusd-postgres psql -U gusd -d gusd -Atc \
  "SELECT string_agg(nspname, ', ') FROM pg_namespace
   WHERE nspname LIKE 'gusd_index_%' AND nspname <> '${INDEXER_SCHEMA}' AND nspname NOT LIKE 'gusd_index_docker%' AND nspname <> 'ponder_sync';")
if [ -n "$other_schemas" ]; then
  log "note: leaving host-dev schemas untouched: $other_schemas"
fi

# --- 7. optional image build, then the stack ----------------------------------------------
if [ "$BUILD" = 1 ]; then
  log "building images indexer/oracle/publisher (db-migrate rides the oracle image)..."
  if ! docker compose -f "$COMPOSE" build indexer oracle publisher >"$LOG_DIR/build.log" 2>&1; then
    echo "[start-dev] image build failed — last 40 lines of $LOG_DIR/build.log:" >&2
    tail -n 40 "$LOG_DIR/build.log" >&2 || true
    exit 6
  fi
fi
log "stack up via pnpm run stack:up (injects PUBLISHER_ORACLE_ADDRESS from the record)..."
if ! pnpm run stack:up >"$LOG_DIR/stack.log" 2>&1; then
  echo "[start-dev] stack:up failed — last 40 lines of $LOG_DIR/stack.log:" >&2
  tail -n 40 "$LOG_DIR/stack.log" >&2 || true
  exit 6
fi

# --- 8. web ABI + address sync ----------------------------------------------------------------
log "syncing web ABIs + deployment addresses..."
if ! pnpm --filter @gusd/web abi:sync; then
  log "WARN: abi:sync failed — the web app will run on stale addresses until re-synced"
fi

# --- 9. health + data barrier --------------------------------------------------------------------
log "waiting for oracle + indexer health (180s cap; Envio backfills from the deployment block)..."
if ! wait_until "oracle health" 180 oracle_healthy; then
  echo "[start-dev] oracle health timeout — last 40 lines per service:" >&2
  docker compose -f "$COMPOSE" logs --tail 40 indexer oracle db-migrate >&2 || true
  exit 7
fi
log "waiting for the 4 canonical pools to index (120s cap)..."
if ! wait_until "pool backfill" 120 pools_ready; then
  pools_ready || true # print the last observed count
  echo "[start-dev] pools never reached 4 — service logs:" >&2
  docker compose -f "$COMPOSE" logs --tail 40 indexer oracle publisher >&2 || true
  exit 7
fi

# --- 10. publisher sanity -----------------------------------------------------------------------------
pub_state=$(docker inspect -f '{{.State.Status}}' gusd-publisher 2>/dev/null || echo missing)
if [ "$pub_state" != "running" ]; then
  docker logs --tail 20 gusd-publisher >&2 || true
  die "publisher not running (state: $pub_state) — crash-looping on a bad oracle address?" 7
fi
log "publisher tail:"
docker logs --tail 3 gusd-publisher 2>&1 | sed 's/^/  | /' || true

# --- 11. summary -----------------------------------------------------------------------------------------
echo
log "dev stack is up:"
docker ps --filter "name=gusd-" --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || true
echo "  oracle API  : http://127.0.0.1:$ORACLE_PORT  (/v1/health, /v1/protocol/*)"
if [ "$ORACLE_PORT" != "8080" ]; then echo "  (non-default ORACLE_PORT=$ORACLE_PORT from $ENV_FILE)"; fi
echo "  chain       : anvil $RPC_URL (chain-id $CHAIN_ID, pid $(cat "$PID_FILE"))"
echo "  record      : $RECORD"
echo "  mock USDT   : $USDT_ADDR (record stables[1]; pinned in web stables.ts)"
echo "  logs        : $LOG_DIR"
echo
echo "  web (manual): pnpm --filter @gusd/web dev   # → http://localhost:3000"
echo "                restart it if it was already running — addresses.generated.ts was regenerated"
echo
if ! grep -q "^NEXT_PUBLIC_ORACLE_URL=http://127.0.0.1:$ORACLE_PORT" apps/web/.env.local 2>/dev/null; then
  log "WARN: apps/web/.env.local NEXT_PUBLIC_ORACLE_URL does not match http://127.0.0.1:$ORACLE_PORT (inlined at build — restart web after fixing)"
fi
