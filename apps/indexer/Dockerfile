# gUSD protocol indexer (Ponder, pinned 0.17.9). Build context is the REPO
# ROOT — pnpm's frozen lockfile validates every workspace importer, so all
# manifests must exist:
#
#   docker build -f apps/indexer/Dockerfile <repo-root>
#
# Runtime posture: `ponder start` (prod indexing — resumes from checkpoint on
# an existing deployment schema, builds the views schema once backfill
# completes). The indexer owns ONLY its gusd_index_* schemas; public.* is
# never touched.

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable

# Manifests first — the layer cache holds node_modules across source edits.
# Every workspace member's package.json is present for lockfile validation,
# but only @gusd/indexer's dependency graph is installed (the indexer has no
# @gusd/* runtime imports; workspace devDeps resolve as links).
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

RUN pnpm install --frozen-lockfile --filter @gusd/indexer

# Source + the deployments JSON the address loader reads (INDEXER_DEPLOYMENTS_DIR
# points there in the runtime image). Ponder's vite-node resolves the app
# tsconfig's `extends` target at RUNTIME, so packages/typescript-config needs
# its real files, not just the manifest.
COPY apps/indexer/ apps/indexer/
COPY apps/contracts/deployments/ apps/contracts/deployments/
COPY packages/typescript-config/ packages/typescript-config/

FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
COPY --from=build /repo /repo
ENV INDEXER_DEPLOYMENTS_DIR=/repo/apps/contracts/deployments \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Ponder persists its build cache (.ponder) inside the app dir — the app runs
# as the unprivileged node user, so the workspace is writable.
RUN chown -R node:node /repo
USER node
WORKDIR /repo/apps/indexer
CMD ["pnpm", "start"]
