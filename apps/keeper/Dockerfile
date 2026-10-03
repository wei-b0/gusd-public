# gUSD keeper (candidate stream → offline evaluation → sim-gated execution).
# Build context is the REPO ROOT — pnpm's frozen lockfile validates every
# workspace importer, so all manifests must exist:
#
#   docker build -f apps/keeper/Dockerfile <repo-root>
#
# Runtime posture: prebuilt dist (`node dist/main.js`). The keeper is the
# only backend service that broadcasts: a funded hot EOA (env-configured,
# never a protocol owner key) executes orders and liquidations the engine
# made permissionless. Postgres (indexer entities), the oracle API
# (attestations, only when work exists) and the RPC are configured through
# env (see infra/docker-compose.yml).

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Manifests first — the layer cache holds node_modules across source edits.
# Every workspace member's package.json is present for lockfile validation,
# but only @gusd/keeper's dependency graph is installed.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/indexer/package.json apps/indexer/
COPY apps/oracle/package.json apps/oracle/
COPY apps/attestor/package.json apps/attestor/
COPY apps/keeper/package.json apps/keeper/
COPY apps/web/package.json apps/web/
COPY apps/contracts/package.json apps/contracts/
COPY packages/attestor-client/package.json packages/attestor-client/
COPY packages/collector-kit/package.json packages/collector-kit/
COPY packages/collectors/package.json packages/collectors/
COPY packages/db/package.json packages/db/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/gpu-catalog/package.json packages/gpu-catalog/
COPY packages/normalize/package.json packages/normalize/
COPY packages/pricing-engine/package.json packages/pricing-engine/
COPY packages/types/package.json packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/

RUN pnpm install --frozen-lockfile --filter @gusd/keeper...

# Source for @gusd/keeper and its workspace dependency graph (attestor-client
# for the gpuId codec, types). pnpm's filtered run compiles the graph in
# dependency order.
COPY apps/keeper/ apps/keeper/
COPY packages/attestor-client/ packages/attestor-client/
COPY packages/types/ packages/types/
COPY packages/typescript-config/ packages/typescript-config/

RUN pnpm --filter @gusd/keeper... run build

FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --from=build /repo /repo
# The keeper writes nothing to disk (DB reads + stdout only) — no chown
# needed to run as the unprivileged node user.
USER node
WORKDIR /repo/apps/keeper
CMD ["node", "dist/main.js"]