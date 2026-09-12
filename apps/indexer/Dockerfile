FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable

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

COPY apps/indexer/ apps/indexer/
COPY apps/contracts/deployments/ apps/contracts/deployments/
COPY packages/typescript-config/ packages/typescript-config/

FROM node:24-bookworm-slim
WORKDIR /repo
RUN corepack enable
COPY --from=build /repo /repo
ENV INDEXER_DEPLOYMENTS_DIR=/repo/apps/contracts/deployments \
    ENVIO_HASURA=false \
    ENVIO_INDEXER_PORT=9898 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN chown -R node:node /repo
USER node
WORKDIR /repo/apps/indexer
CMD ["pnpm", "start"]
