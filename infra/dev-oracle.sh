#!/usr/bin/env bash
# Launch the oracle API for the durable (systemd --user) stack — WITHOUT the
# tsx watch wrapper (`pnpm dev`). watch keeps its parent alive after the
# child crashes, so the unit shows "active" while the API is dead and
# Restart=always never fires. A crash here must exit the process so systemd
# restarts it. See infra/dev-attestor.sh for the full rationale.
set -euo pipefail
cd "$(dirname "$0")/.."

# systemd's default PATH is /usr/bin:/bin — node is there, pnpm is not.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
exec pnpm --filter @gusd/oracle exec tsx src/main.ts
