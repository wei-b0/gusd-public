# @gusd/indexer

Envio HyperIndex 3.10.0 indexer for the gUSD protocol. It writes onchain event
history and derived read state into an isolated Postgres schema. The oracle
serves those tables through the existing `/v1/protocol/*` API.

The process reads `apps/contracts/deployments/<chainId>.json` at startup and
generates `config.yaml`, ABI JSON, and runtime address constants. Restart the
indexer after a deployment record changes; an image rebuild is unnecessary.

## Runtime

- Chain 4663 uses HyperSync and requires `ENVIO_API_TOKEN`. An optional RPC URL
  supplies fallback and status timestamps.
- Chains 31337 and 46630 use RPC synchronization.
- One chain runs per process.
- Hasura is disabled. Envio HTTP remains private; liveness is `/healthz` and
  progress is exposed through `/metrics`.
- The indexer owns only `gusd_index_envio_<environment>_v<n>`. It never writes
  `public.*` market data.

## Development

```sh
pnpm stack:up
pnpm dev:indexer
curl http://127.0.0.1:9898/healthz
curl http://127.0.0.1:9898/metrics
```

Use `.env.example` for the Postgres, chain, RPC, schema, and HyperSync settings.
Generated deployment-specific files are ignored by Git.

## Commands

```sh
pnpm --filter @gusd/indexer config:generate
pnpm --filter @gusd/indexer codegen
pnpm --filter @gusd/indexer check-types
pnpm --filter @gusd/indexer test
RUN_ANVIL_TESTS=1 pnpm --filter @gusd/indexer test:anvil
```

The gated suite uses a private Anvil and scratch Envio schemas. It checks
accounting, deterministic independent backfills, unchanged-schema restart,
and live rollback of event history and projections.

## License

Envio HyperIndex is proprietary (envio.dev terms): self-hosted internal use
is permitted, the generated code must not be offered as a competing hosted
service. Powered by HyperIndex.
