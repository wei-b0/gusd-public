#!/usr/bin/env bash
# Head-clock keeper for the local anvil — keeps the idle chain's block
# timestamp at wall clock so price reports never read stale on-chain.
#
# Two failure modes this owns:
#  1. Idle chain: nothing mines on its own, so the head timestamp freezes
#     and fresh attestations age out of validity. Mine every tick.
#  2. State-file resume after a reboot: anvil reloads --state with the
#     timestamp it was saved at, so the chain clock can lag wall time by
#     hours even while mining resumes. Mining cannot fix an offset — the
#     loop detects the drift and jumps the clock once; from then on mines
#     track wall again.
set -u
export PATH="$HOME/.foundry/bin:$PATH"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
DRIFT_TOLERANCE="${DRIFT_TOLERANCE:-20}"

while :; do
  now="$(date +%s)"
  head="$(cast block latest --rpc-url "$RPC_URL" -f timestamp 2>/dev/null | cut -d' ' -f1)"
  if [[ -n "${head:-}" && $((now - head)) -gt $DRIFT_TOLERANCE ]]; then
    # Behind-wall is the only dangerous direction: reports are validated
    # against the chain's clock, so a lagging chain ages every report out.
    cast rpc evm_setNextBlockTimestamp "$((now + 1))" --rpc-url "$RPC_URL" >/dev/null 2>&1 || true
  fi
  cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null 2>&1 || true
  sleep 2
done
