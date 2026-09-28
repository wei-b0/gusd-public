#!/usr/bin/env bash
# Launch the attestor for the durable (systemd --user) stack.
#
# Two rules this script exists to enforce, both learned the hard way:
# 1. The GpuOracle address is resolved from the deployment record at every
#    start — redeploys rotate it, and a stale env is a silent crash loop.
# 2. The attestor runs WITHOUT the tsx watch wrapper (`pnpm dev`). watch
#    keeps its parent alive after the child crashes, so the unit shows
#    "active" while the attestor is dead and Restart=always never fires —
#    exactly the silent starvation trading must never see. A crash here
#    must exit the process so systemd restarts it.
set -euo pipefail
cd "$(dirname "$0")/.."

# systemd's default PATH is /usr/bin:/bin — node is there, pnpm is not.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

RECORD="apps/contracts/deployments/31337.json"
export ATTESTOR_ORACLE_ADDRESS="$(node -p "require('./$RECORD').oracle")"

: "${DATABASE_URL:=postgres://gusd:gusd@127.0.0.1:54329/gusd}"
export DATABASE_URL

exec pnpm --filter @gusd/attestor exec tsx src/main.ts
