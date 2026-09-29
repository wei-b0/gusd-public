#!/usr/bin/env bash
# start-host-dev.sh — start-dev.sh's posture WITHOUT docker: everything runs
# as host processes. Same phases: fresh anvil on 0.0.0.0:8545, full
# Deploy.full redeploy, grid switch back, reprice proof, head-clock keeper,
# schema drop, then oracle / indexer / attestor / keeper as host processes,
# web abi:sync, and the health/4-canonical-pools barrier.
#
#   ./start-host-dev.sh
#
# The oracle always runs LIVE (collectors scrape the real provider APIs) —
# ORACLE_REPLAY_FIXTURES=1 is NOT a serving posture: replay is a one-shot
# offline pass that never binds the API port (apps/oracle/src/main.ts), and
# its candidates are stamped at a pinned past clock, so the attestor's
# freshness gate would never sign them anyway.
#
# Prereqs (one-time, NOT done here): postgresql installed with a cluster on
# :54329 (port in /etc/postgresql/*/main/postgresql.conf), role/db
# gusd/gusd/gusd, `pnpm db:migrate` run, Foundry in ~/.foundry/bin.
# Logs land in ${TMPDIR:-/tmp}/gusd-host; pids alongside them.
set -euo pipefail

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

CONTRACTS="apps/contracts"
RECORD="$CONTRACTS/deployments/31337.json"
RPC_URL="http://127.0.0.1:8545"
CHAIN_ID="31337"
ANVIL_PORT="8545"
# Anvil account #0 — a public dev key, valid ONLY on the local test posture.
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# Anvil account #1 — the keeper's hot key (public dev key; NEVER a protocol
# owner/attestor key).
KEEPER_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
DEPLOY_SIG="runFull()"
LOG_DIR="${TMPDIR:-/tmp}/gusd-host"
DATABASE_URL="postgres://gusd:gusd@localhost:54329/gusd"
INDEXER_SCHEMA="gusd_index_envio_host_v1"
ANVIL_PID=""

export PATH="$HOME/.foundry/bin:$PATH"

log() { echo "[start-host] $*"; }
die() {
  echo "[start-host] ERROR: $1" >&2
  echo "[start-host] logs: $LOG_DIR (chain/services left up for debugging)" >&2
  exit "${2:-1}"
}

usage() { echo "usage: ./start-host-dev.sh [--replay]"; }
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) echo "[start-host] unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$LOG_DIR"

trap '[ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null; exit 130' INT TERM

# --- prereqs -------------------------------------------------------------------------
command -v pnpm >/dev/null 2>&1 || die "pnpm not found — corepack enable" 1
command -v anvil >/dev/null 2>&1 || die "anvil not found in ~/.foundry/bin" 1
psql "$DATABASE_URL" -tAc "SELECT 1" >/dev/null 2>&1 \
  || die "no postgres on localhost:54329 (role gusd/db gusd) — see the script header" 1

# --- 1. clear port shadows -------------------------------------------------------------
# No docker here, so every listener on a managed port is ours to kill.
kill_port() { # kill_port PORT LABEL
  local port="$1" label="$2" pid
  for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    log "killing $label on :$port — pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null || true))"
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    kill -9 "$pid" 2>/dev/null || true
  done
}
for f in "$LOG_DIR"/*.pid; do
  [ -f "$f" ] && { kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }
done
kill_port 8545 "stale anvil"
kill_port 8080 "oracle"
kill_port 9898 "indexer healthz"
kill_port 3000 "web dev"
# The services run under `tsx watch`: killing the listener child leaves the
# watch parent alive, and a surviving parent respawns a child that races the
# fresh launch for its own port. Sweep the watch parents too — the cmdline is
# "node …/tsx/dist/cli.mjs watch src/main.ts" (tsx never appears literally).
pkill -f "cli.mjs watch" 2>/dev/null || true
pkill -f "envio.*start" 2>/dev/null || true
pkill -f "next-server|next dev" 2>/dev/null || true
sleep 1

# --- 2. fresh anvil ---------------------------------------------------------------------
log "starting fresh anvil on :$ANVIL_PORT ..."
nohup anvil --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --host 0.0.0.0 \
  --gas-limit 1000000000 >"$LOG_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" >"$LOG_DIR/anvil.pid"

rpc_ok() {
  curl -fsS --max-time 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    "$RPC_URL" 2>/dev/null | grep -q '"result"'
}
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
if ! wait_until "anvil RPC" 30 rpc_ok; then
  tail -n 20 "$LOG_DIR/anvil.log" >&2 || true
  die "anvil not answering — see $LOG_DIR/anvil.log" 3
fi

# --- 3. deploy the full catalogue (day-grid recipe — see AGENTS.md) ----------------------
log "wiping stale Deploy.full broadcast + cache..."
rm -rf "$CONTRACTS/broadcast/Deploy.full.s.sol" "$CONTRACTS/cache/Deploy.full.s.sol"
log "deploying full catalogue (~140 txs, a couple of minutes)..."
if ! ( cd "$CONTRACTS" && ORACLE_EPOCH_LENGTH=86400 ORACLE_MAX_OBSERVATION_AGE=86400 \
      PRIVATE_KEY="$ANVIL_KEY" forge script script/Deploy.full.s.sol \
      --rpc-url "$RPC_URL" --broadcast --sig "$DEPLOY_SIG" --gas-limit 600000000 ) >"$LOG_DIR/deploy.log" 2>&1; then
  echo "[start-host] deploy failed — last 40 lines of $LOG_DIR/deploy.log:" >&2
  tail -n 40 "$LOG_DIR/deploy.log" >&2 || true
  exit 4
fi
ORACLE_ADDR=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.oracle)' "$RECORD")
log "deployed — oracle $ORACLE_ADDR"

# --- 4. back onto the production grid ----------------------------------------------------
# Order matters — each setter's floor check reads the other knob — and the
# record's epoch keys follow, since the attestor client's report-validity math
# reads them.
log "switching the oracle grid to 60s epochs / 300s observation age..."
cast send "$ORACLE_ADDR" "setEpochLength(uint64)" 60 \
  --private-key "$ANVIL_KEY" --rpc-url "$RPC_URL" >/dev/null
cast send "$ORACLE_ADDR" "setMaxObservationAge(uint64)" 300 \
  --private-key "$ANVIL_KEY" --rpc-url "$RPC_URL" >/dev/null
jq '.oracleEpochLength = 60 | .oracleMaxObservationAge = 300' "$RECORD" > "$RECORD.tmp" \
  && mv "$RECORD.tmp" "$RECORD"

# --- 5. the reprice proof -----------------------------------------------------------------
log "running the reprice proof (epoch-gated)..."
reprice_ok=""
for attempt in 1 2 3 4 5 6 7 8; do
  curl -fsS --max-time 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"anvil_mine","params":["3","1"]}' \
    "$RPC_URL" >/dev/null 2>&1 || true
  if ( cd "$CONTRACTS" && PRIVATE_KEY="$ANVIL_KEY" forge script script/Deploy.full.s.sol \
        --fork-url "$RPC_URL" --broadcast --sig "runReprice()" --gas-limit 600000000 ) >"$LOG_DIR/reprice.log" 2>&1; then
    reprice_ok=1
    break
  fi
  if grep -qE "reprice epoch not reached|too near the epoch boundary|OrderDelayPending" "$LOG_DIR/reprice.log"; then
    log "reprice epoch not rolled yet (attempt $attempt) — retrying"
  else
    echo "[start-host] reprice proof failed — last 40 lines of $LOG_DIR/reprice.log:" >&2
    tail -n 40 "$LOG_DIR/reprice.log" >&2 || true
    exit 4
  fi
done
[ -n "$reprice_ok" ] || die "reprice epoch never rolled past the seed binding" 4

# --- 6. head-clock keeper -------------------------------------------------------------------
# An idle auto-mine anvil never advances its head timestamp — but the attestor
# signs at wall clock, and every quote's eth_call re-verifies the report
# against the HEAD block's epoch. Without this loop the head falls behind the
# wall and quotes revert UnknownGpuEpoch after the first idle minute.
# Test-infra harness, not protocol.
log "starting the head-clock keeper (evm_mine every 2s)..."
nohup bash -c 'while :; do curl -fsS --max-time 2 -X POST -H "content-type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"evm_mine\",\"params\":[]}" \
  '"$RPC_URL"' >/dev/null 2>&1 || true; sleep 2; done' \
  >"$LOG_DIR/clockkeeper.log" 2>&1 &
echo $! >"$LOG_DIR/clockkeeper.pid"

# --- 7. drop the indexer's schemas (fresh schema per deployment) -----------------------------
schema_list=$(psql "$DATABASE_URL" -Atc \
  "SELECT string_agg(quote_ident(nspname), ', ') FROM pg_namespace
   WHERE nspname = '${INDEXER_SCHEMA}' OR nspname = 'ponder_sync' OR nspname LIKE 'gusd_index_envio_host%';")
if [ -n "$schema_list" ]; then
  log "dropping indexer schemas: $schema_list"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "SET client_min_messages = warning; DROP SCHEMA $schema_list CASCADE;" \
    || die "schema drop failed" 5
else
  log "no indexer schemas to drop"
fi

# --- 8. the four host services ---------------------------------------------------------------
# Every service reads process.env only (no dotenv) — each block is exported
# for its nohup launch. The oracle binds 0.0.0.0 (direct-API debugging); the
# indexer's HTTP surface stays loopback-private (:9898 — the oracle proxies
# it as /v1/protocol/*).
log "starting oracle..."
( export HOST=0.0.0.0 PORT=8080 DATABASE_URL="$DATABASE_URL" LOG_LEVEL=info
  export ORACLE_EPOCH_LENGTH=60
  export INDEXER_SCHEMA="$INDEXER_SCHEMA" INDEXER_INTERNAL_URL="http://127.0.0.1:9898"
  export INDEXER_STATUS_RPC_URL="$RPC_URL" INDEXER_CHAIN_ID="$CHAIN_ID"
  exec pnpm --filter @gusd/oracle dev ) >"$LOG_DIR/oracle.log" 2>&1 &
echo $! >"$LOG_DIR/oracle.pid"

log "starting indexer (envio start, RPC-only chain 31337)..."
( export DATABASE_URL="$DATABASE_URL"
  # HyperIndex reads its DB coordinates from the ENVIO_PG_* block (what the
  # compose service exports), not DATABASE_URL.
  export ENVIO_PG_HOST=127.0.0.1 ENVIO_PG_PORT=54329 ENVIO_PG_USER=gusd
  export ENVIO_PG_PASSWORD=gusd ENVIO_PG_DATABASE=gusd ENVIO_PG_SSL_MODE="false"
  export ENVIO_PG_SCHEMA="$INDEXER_SCHEMA" INDEXER_SCHEMA="$INDEXER_SCHEMA"
  export INDEXER_CHAIN_ID="$CHAIN_ID" INDEXER_RPC_URL="$RPC_URL"
  export ENVIO_HASURA=false ENVIO_INDEXER_PORT=9898 INDEXER_LOG_LEVEL=info
  exec pnpm --filter @gusd/indexer start ) >"$LOG_DIR/indexer.log" 2>&1 &
echo $! >"$LOG_DIR/indexer.pid"

log "starting attestor..."
# The attestor's poll loop crashes for good if its FIRST poll lands while the
# oracle is still binding (tsx watch does not restart a crashed child) — wait
# for the oracle's health endpoint before launching it.
oracle_up() { curl -fsS --max-time 2 http://127.0.0.1:8080/v1/health >/dev/null 2>&1; }
wait_until "oracle API up (attestor gate)" 120 oracle_up \
  || die "oracle never came up — attestor not launched" 7
( export DATABASE_URL="$DATABASE_URL"
  export ATTESTOR_PRIVATE_KEY="$ANVIL_KEY" ATTESTOR_ORACLE_ADDRESS="$ORACLE_ADDR"
  export ATTESTOR_CHAIN_ID="$CHAIN_ID" ATTESTOR_ORACLE_URL="http://127.0.0.1:8080"
  export ATTESTOR_EPOCH_LENGTH=60 ATTESTOR_MAX_OBSERVATION_AGE=300
  exec pnpm --filter @gusd/attestor dev ) >"$LOG_DIR/attestor.log" 2>&1 &
echo $! >"$LOG_DIR/attestor.pid"

log "starting keeper..."
( export DATABASE_URL="$DATABASE_URL"
  export KEEPER_PRIVATE_KEY="$KEEPER_KEY" KEEPER_RPC_URL="$RPC_URL" KEEPER_CHAIN_ID="$CHAIN_ID"
  export INDEXER_SCHEMA="$INDEXER_SCHEMA"
  export ORACLE_HTTP_URL="http://127.0.0.1:8080" ORACLE_WS_URL="ws://127.0.0.1:8080"
  exec pnpm --filter @gusd/keeper dev ) >"$LOG_DIR/keeper.log" 2>&1 &
echo $! >"$LOG_DIR/keeper.pid"

# --- 9. web ABI + address sync ----------------------------------------------------------------
log "syncing web ABIs + deployment addresses..."
if ! pnpm --filter @gusd/web abi:sync; then
  log "WARN: abi:sync failed — the web app will run on stale addresses until re-synced"
fi

# --- 10. health + data barrier ------------------------------------------------------------------
oracle_healthy() {
  node -e '
    fetch(`http://127.0.0.1:8080/v1/health`, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json())
      .then((j) => process.exit(j.status === "healthy" && j.indexer && j.indexer.status === "healthy" ? 0 : 1))
      .catch(() => process.exit(1));
  '
}
pools_ready() { # canonical SKU pools indexed >= 4
  node -e '
    fetch(`http://127.0.0.1:8080/v1/protocol/pools`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .then((j) => {
        const n = (j.pools || []).filter((p) => p.canonical === true && p.gpuId != null).length;
        console.error("canonical SKU pools indexed: " + n + "/4");
        process.exit(n >= 4 ? 0 : 1);
      })
      .catch(() => process.exit(1));
  '
}
log "waiting for oracle + indexer health (180s cap; Envio backfills from the deployment block)..."
if ! wait_until "oracle health" 180 oracle_healthy; then
  tail -n 20 "$LOG_DIR/oracle.log" "$LOG_DIR/indexer.log" >&2 || true
  die "oracle/indexer health timeout" 7
fi
log "waiting for the 4 canonical pools to index (120s cap)..."
if ! wait_until "pool backfill" 120 pools_ready; then
  pools_ready || true
  die "pools never reached 4 — see $LOG_DIR/indexer.log" 7
fi

# --- 11. the web dev server (HTTPS same-origin posture) -------------------------------------------
CERT="infra/dev-cert.pem"
CERT_KEY="infra/dev-cert-key.pem"
if [ ! -f "$CERT" ] || [ ! -f "$CERT_KEY" ]; then
  log "generating the self-signed dev cert (one-time)..."
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -subj "/CN=130.210.50.190" \
    -addext "subjectAltName=IP:130.210.50.190,DNS:localhost" \
    -keyout "$CERT_KEY" -out "$CERT" >/dev/null 2>&1 \
    || die "openssl cert generation failed" 8
fi
if ! grep -q "NEXT_PUBLIC_PRIVY_APP_ID=" apps/web/.env.local 2>/dev/null; then
  log "WARN: apps/web/.env.local has no Privy id — the web will run in walletless demo mode (no trading)"
fi
log "starting the web dev server (https, same-origin proxy)..."
( exec pnpm --filter @gusd/web dev:https ) >"$LOG_DIR/web.log" 2>&1 &
echo $! >"$LOG_DIR/web.pid"
web_ok() {
  curl -skfsS --max-time 3 https://127.0.0.1:3000/ >/dev/null 2>&1
}
if ! wait_until "web dev server" 120 web_ok; then
  tail -n 20 "$LOG_DIR/web.log" >&2 || true
  die "web never answered on :3000" 8
fi

# --- 12. attestor sanity ---------------------------------------------------------------------------
attestation_ok() { # a signed report exists for the current epoch
  curl -fsS --max-time 3 "http://127.0.0.1:8080/v1/prices/H100_SXM_80GB/attestation" 2>/dev/null | grep -q '"signature"'
}
log "waiting for a live attestation (the attestor signs once a candidate publishes; 180s cap)..."
if ! wait_until "attestation" 180 attestation_ok; then
  echo "[start-host] WARN: no attestation yet — panels may have no numeric candidate (all withheld)." >&2
  echo "[start-host]       Check $LOG_DIR/attestor.log and the oracle's candidate statuses." >&2
fi

# --- 13. summary --------------------------------------------------------------------------------------
echo
log "host dev stack is up:"
echo "  web         : https://130.210.50.190:3000  (self-signed cert; open :3000 in the cloud firewall)"
echo "  oracle API  : http://127.0.0.1:8080  (proxied same-origin as https://…:3000/v1/*)"
echo "  chain       : anvil $RPC_URL (chain-id $CHAIN_ID, pid $(cat "$LOG_DIR/anvil.pid"))"
echo "  clockkeeper : pid $(cat "$LOG_DIR/clockkeeper.pid" 2>/dev/null || echo '-') keeps the head timestamp at wall clock"
echo "  keeper      : perp executor (orders + liquidations; hot key = anvil acct #1)"
echo "  record      : $RECORD"
echo "  logs        : $LOG_DIR"
echo "  stop        : ./stop-host-dev.sh"
echo
echo "  next        : accept the cert warning in the remote browser, Privy-login, add network 31337"