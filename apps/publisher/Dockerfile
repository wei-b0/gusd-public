# gUSD publisher (oracle→GPUPriceOracle publish loop). Build context is the
# REPO ROOT — pnpm's frozen lockfile validates every workspace importer, so
# all manifests must exist:
#
#   docker build -f apps/publisher/Dockerfile <repo-root>
#
# Runtime posture: prebuilt dist (`node dist/main.js`). PUBLISHER_TARGET is
# mock unless the environment says otherwise — no key, RPC, or oracle address
# is baked into the image; chain mode is configured entirely through env
# (see infra/docker-compose.yml).

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Manifests first — the layer cache holds node_modules across source edits.
# Every workspace member's package.json is present for lockfile validation,
# but only @gusd/publisher's dependency graph is installed.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/indexer/package.json apps/indexer/
COPY apps/oracle/package.json apps/oracle/
COPY apps/publisher/package.json apps/publisher/
COPY apps/web/package.json apps/web/
COPY apps/contracts/package.json apps/contracts/
COPY packages/collector-kit/package.json packages/collector-kit/
COPY packages/collectors/package.json packages/collectors/
COPY packages/db/package.json packages/db/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/gpu-catalog/package.json packages/gpu-catalog/
COPY packages/normalize/package.json packages/normalize/
COPY packages/pricing-engine/package.json packages/pricing-engine/
COPY packages/types/package.json packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/

RUN pnpm install --frozen-lockfile --filter @gusd/publisher...

# Source for @gusd/publisher and its workspace dependency graph (db,
# gpu-catalog, pricing-engine, types). pnpm's filtered run compiles the graph
# in dependency order.
COPY apps/publisher/ apps/publisher/
COPY packages/types/ packages/types/
COPY packages/gpu-catalog/ packages/gpu-catalog/
COPY packages/pricing-engine/ packages/pricing-engine/
COPY packages/db/ packages/db/
COPY packages/typescript-config/ packages/typescript-config/

RUN pnpm --filter @gusd/publisher... run build

FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --from=build /repo /repo
# The poller has no HTTP surface and writes nothing to disk (DB + stdout
# only) — no chown needed to run as the unprivileged node user.
USER node
WORKDIR /repo/apps/publisher
CMD ["node", "dist/main.js"]
