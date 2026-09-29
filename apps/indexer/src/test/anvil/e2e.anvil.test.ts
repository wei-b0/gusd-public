/**
 * The gated onchain suites (RUN_ANVIL_TESTS=1): reorg rollback, determinism
 * of full re-backfills, and views rotation. Self-contained — the harness
 * boots its own anvil, deploys + churns from a throwaway copy of the
 * contracts app, and runs its own Envio instances in scratch
 * schemas (see ./harness.ts). Gated because it needs foundry, Postgres, and
 * minutes of wall clock:
 *
 *   RUN_ANVIL_TESTS=1 pnpm --filter @gusd/indexer test:anvil
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  ANVIL_URL,
  DEPLOYER_PK,
  SCRATCH_SCHEMAS,
  anvilRpc,
  connectPg,
  dropScratchSchemas,
  dumpSchema,
  evmRevert,
  evmSnapshot,
  envioProcessedBlock,
  expectDumpsEqual,
  readDeployment,
  runForgeScript,
  spawnAnvil,
  spawnEnvio,
  teardown,
  type EnvioInstance,
  type TableDump,
} from "./harness.js";

/** The chain's write surface for the reorg test: one oracle admin write (the
 *  pull oracle has no publisher to poke — prices ride the trades themselves). */
const ORACLE_ADMIN_ABI = parseAbi(["function setMaxObservationAge(uint64 seconds_)"]);

// House gate idiom: the suite costs minutes of wall clock plus foundry +
// Postgres, so it only runs under RUN_ANVIL_TESTS=1.
const run = process.env.RUN_ANVIL_TESTS === "1";
const d = run ? describe : describe.skip;

const instances: EnvioInstance[] = [];
let pg: Awaited<ReturnType<typeof connectPg>> | null = null;
let primary: EnvioInstance | null = null;

async function schemaQuery<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const res = await pg!.query<T>(sql, params);
  return res.rows;
}

/** Sets the observation age as the owner (the fresh deployment's admin). */
async function setObservationAge(seconds: number): Promise<void> {
  const account = privateKeyToAccount(DEPLOYER_PK as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: foundry,
    transport: http(ANVIL_URL),
  });
  const deployment = readDeployment();
  const hash = await wallet.writeContract({
    account,
    address: deployment.oracle as `0x${string}`,
    abi: ORACLE_ADMIN_ABI,
    functionName: "setMaxObservationAge",
    args: [BigInt(seconds)],
  });
  expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  await anvilRpc("evm_mine", []);
}

async function waitForSchema(
  label: string,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  await spawnAnvil();
  // Deploy.full — the canonical deployed + churned chain in one script:
  // 4 launch SKUs (enabled issuance, canonical pools, attestor-signed
  // bootstrap trades), quoter floats funded, mock USDT, the product churn
  // (issuance + pool
  // buys, a sell, LP), and the closing stake + distribute. The older
  // Deploy + Demo pair drifted apart — minimal Deploy deliberately leaves
  // the quoter floats unfunded ("Floats are funded by Deploy.full"), so
  // Demo's first quote reverts NoFloat on a fresh chain.
  await runForgeScript("script/Deploy.full.s.sol", "runFull()");
  pg = await connectPg();
  await dropScratchSchemas(pg);
}, 600_000);

afterAll(async () => {
  if (pg !== null) await dropScratchSchemas(pg);
  await teardown(pg, instances);
}, 120_000);

d("indexer onchain suites (gated)", () => {
  it(
    "indexes the deployed + churned chain to realtime",
    async () => {
      const instA = await spawnEnvio({
        schema: "gusd_index_envio_e2e_a",
        port: 42481,
      });
      instances.push(instA);
      primary = instA;

      // Deploy.full's closing stake + distribute are the chain's
      // last-landed protocol events; their presence in the derived state
      // means the historical backfill reached the churn's final blocks. The
      // figures are the script's deterministic closing state (the same
      // number two independent Deploy.full replays landed — the manual
      // dev-chain deploy and this suite's own) — 10,397.39 gUSD vault share
      // under the four-SKU universe. Recomputed each time the demo's shape
      // changed: the seven-SKU cut moved 12,014.37 → 10,397.45, and the
      // two-phase rework (runReprice extraction) moved it to 10,397.39.
      // The perp LP seed + alice's perp-demo stake added two more user
      // deposits (seed, churn stake, LP seed, alice = 4).
      // Raw pg reads bypass drizzle's int8 mode:number mapping — counts
      // arrive as strings (same grain as the count(*)::text probes below).
      const closing = await schemaQuery<{ revenue_gusd: string; deposit_count: string }>(
        `select revenue_gusd, deposit_count from "gusd_index_envio_e2e_a"."SgusdVault"`,
        [],
      );
      expect(closing).toHaveLength(1);
      expect(closing[0]!.deposit_count).toBe("4"); // seed + churn stake + LP seed + alice
      expect(closing[0]!.revenue_gusd).toBe("10397386590");

      const swaps = await schemaQuery<{ count: string }>(
        `select count(*)::text as count from "gusd_index_envio_e2e_a"."PmSwap"`,
        [],
      );
      expect(Number(swaps[0]!.count)).toBeGreaterThan(0);

      // The vault singleton must equal the sums of its event tables — the
      // chain's FIRST sgUSD event is the seed's own Deposit (owner = the
      // sgUSD contract, emitted before Seeded), so an all-zero first-sight
      // insert drops its delta: shares_minted one seed short, deposit_count
      // one low, seeded missing entirely.
      const sgusd = String(readDeployment().sgusd).toLowerCase();
      const vault = await schemaQuery<{
        seeded_gusd: string;
        deposits_gusd: string;
        withdraws_gusd: string;
        shares_minted: string;
        shares_burned: string;
        deposit_count: string;
        withdraw_count: string;
        revenue_gusd: string;
      }>(`select * from "gusd_index_envio_e2e_a"."SgusdVault"`, []);
      expect(vault).toHaveLength(1);
      const sums = await schemaQuery<{
        seeded: string;
        deposit_assets_user: string;
        deposit_shares: string;
        deposit_count: string;
        withdraw_assets: string;
        withdraw_shares: string;
        withdraw_count: string;
        revenue: string;
      }>(
        `select
           (select coalesce(sum(assets), 0)::text from "gusd_index_envio_e2e_a"."SgusdSeeded") as seeded,
           (select coalesce(sum(assets), 0)::text from "gusd_index_envio_e2e_a"."SgusdDeposited" where lower(owner) <> $1) as deposit_assets_user,
           (select coalesce(sum(shares), 0)::text from "gusd_index_envio_e2e_a"."SgusdDeposited") as deposit_shares,
           (select count(*)::text from "gusd_index_envio_e2e_a"."SgusdDeposited") as deposit_count,
           (select coalesce(sum(assets), 0)::text from "gusd_index_envio_e2e_a"."SgusdWithdrawn") as withdraw_assets,
           (select coalesce(sum(shares), 0)::text from "gusd_index_envio_e2e_a"."SgusdWithdrawn") as withdraw_shares,
           (select count(*)::text from "gusd_index_envio_e2e_a"."SgusdWithdrawn") as withdraw_count,
           (select coalesce(sum(to_vault), 0)::text from "gusd_index_envio_e2e_a"."RevenueDistributed") as revenue`,
        [sgusd],
      );
      expect(BigInt(vault[0]!.seeded_gusd)).toBe(BigInt(sums[0]!.seeded));
      expect(BigInt(vault[0]!.deposits_gusd)).toBe(BigInt(sums[0]!.deposit_assets_user));
      expect(BigInt(vault[0]!.shares_minted)).toBe(BigInt(sums[0]!.deposit_shares));
      expect(vault[0]!.deposit_count).toBe(sums[0]!.deposit_count);
      expect(BigInt(vault[0]!.withdraws_gusd)).toBe(BigInt(sums[0]!.withdraw_assets));
      expect(BigInt(vault[0]!.shares_burned)).toBe(BigInt(sums[0]!.withdraw_shares));
      expect(vault[0]!.withdraw_count).toBe(sums[0]!.withdraw_count);
      expect(BigInt(vault[0]!.revenue_gusd)).toBe(BigInt(sums[0]!.revenue));
    },
    300_000,
  );

  it(
    "projects the perp book from Deploy.full's pending demo orders",
    async () => {
      // runFull arms the perp demo (alice's H100 long + its TP) but the
      // execution lives in runReprice — a second invocation this suite does
      // not run — so the projected book is markets + pending orders and
      // nothing else. This still exercises the MarketParams tuple decode and
      // the order events end-to-end; the executed-side handlers get their
      // coverage from the web anvil suite's perp lifecycle.
      const markets = await schemaQuery<{ gpu_id: string; max_leverage_bps: string }>(
        `select gpu_id, max_leverage_bps from "gusd_index_envio_e2e_a"."PerpMarket" order by gpu_id`,
        [],
      );
      expect(markets).toHaveLength(4); // the four launch SKUs
      for (const market of markets) {
        expect(market.max_leverage_bps).toBe("200000"); // 20x — Deploy's default
      }

      const orders = await schemaQuery<{
        kind: string;
        status: string;
        size_delta_usd: string;
        execution_fee: string;
      }>(
        `select kind, status, size_delta_usd, execution_fee
           from "gusd_index_envio_e2e_a"."PerpOrder" order by order_id`,
        [],
      );
      expect(orders).toHaveLength(2); // the market increase + its TP
      expect(Number(orders[0]!.kind)).toBe(0); // MarketIncrease
      expect(Number(orders[1]!.kind)).toBe(3); // TakeProfit
      expect(orders.every((o) => o.status === "1")).toBe(true); // all Pending

      const positions = await schemaQuery<{ count: string }>(
        `select count(*)::text as count from "gusd_index_envio_e2e_a"."PerpPosition"`,
        [],
      );
      expect(positions[0]!.count).toBe("0");

      const stats = await schemaQuery<{ order_count: string }>(
        `select order_count from "gusd_index_envio_e2e_a"."PerpEngineStats"`,
        [],
      );
      expect(stats[0]!.order_count).toBe("2");
    },
    120_000,
  );

  it(
    "re-backfills byte-identically into a fresh schema (determinism)",
    async () => {
      const dumpA: TableDump = await dumpSchema(pg!, "gusd_index_envio_e2e_a");
      const instB = await spawnEnvio({
        schema: "gusd_index_envio_e2e_b",
        port: 42482,
      });
      instances.push(instB);
      const dumpB = await dumpSchema(pg!, "gusd_index_envio_e2e_b");
      expectDumpsEqual(dumpA, dumpB, "fresh re-backfill");
      await instB.kill();
    },
    300_000,
  );

  it(
    "restarts on an existing schema and changes nothing (checkpoint resume)",
    async () => {
      const dumpA: TableDump = await dumpSchema(pg!, "gusd_index_envio_e2e_a");
      await primary!.kill();
      const restarted = await spawnEnvio({
        schema: "gusd_index_envio_e2e_a",
        port: 42481,
      });
      instances.push(restarted);
      const dumpA2 = await dumpSchema(pg!, "gusd_index_envio_e2e_a");
      expectDumpsEqual(dumpA, dumpA2, "restart resume");
      await restarted.kill();
    },
    300_000,
  );

  it(
    "rolls back event + derived state across a chain reorg",
    async () => {
      const instE = await spawnEnvio({
        schema: "gusd_index_envio_e2e_e",
        port: 42485,
      });
      instances.push(instE);

      const swapCount = async (): Promise<number> =>
        Number(
          (
            await schemaQuery<{ count: string }>(
              `select count(*)::text as count from "gusd_index_envio_e2e_e"."PmSwap"`,
              [],
            )
          )[0]!.count,
        );
      const swapsBefore = await swapCount();

      // Snapshot → admin sets 86,410 → indexed → revert → admin sets 86,420.
      // The write values ride just above the deployment's epoch grid: the
      // harness deploys with the 86,400s day grid (the only grid that
      // survives forge's sim→broadcast clock gap on an idle anvil), and the
      // setter's floor is the epoch length — setMaxObservationAge reverts
      // ObservationAgeBelowEpoch below it. The values are arbitrary beyond
      // that; they only need to differ so the rollback is observable.
      const snapshot = await evmSnapshot();
      await setObservationAge(86_410);
      await waitForSchema("age 86410 indexed", async () => {
        const rows = await schemaQuery<{ max_observation_age_sec: string }>(
          `select max_observation_age_sec from "gusd_index_envio_e2e_e"."ProtocolStats"`,
          [],
        );
        return rows[0]?.max_observation_age_sec === "86410";
      });
      const replacedForkTip = await envioProcessedBlock(instE);

      await evmRevert(snapshot);
      await setObservationAge(86_420);
      while (Number(BigInt(await anvilRpc<string>("eth_blockNumber", []))) <= replacedForkTip) {
        await anvilRpc("evm_mine", []);
      }
      await waitForSchema("age 86420 indexed", async () => {
        const rows = await schemaQuery<{ max_observation_age_sec: string }>(
          `select max_observation_age_sec from "gusd_index_envio_e2e_e"."ProtocolStats"`,
          [],
        );
        return rows[0]?.max_observation_age_sec === "86420";
      });

      // The reverted admin write is gone from derived state (the singleton
      // mirrors the post-rollback write only); everything else (the churn's
      // swaps) survived the rollback.
      const stats = await schemaQuery<{ max_observation_age_sec: string }>(
        `select max_observation_age_sec from "gusd_index_envio_e2e_e"."ProtocolStats"`,
        [],
      );
      expect(stats[0]!.max_observation_age_sec).toBe("86420");

      expect(await swapCount()).toBe(swapsBefore);
      await instE.kill();
    },
    300_000,
  );
});

d("scratch schema hygiene", () => {
  it("only uses suite-owned schema names", () => {
    for (const name of SCRATCH_SCHEMAS) {
      expect(name).toMatch(/^gusd_index_envio_e2e_[a-z_]+$/);
      expect(name.length).toBeLessThanOrEqual(30);
    }
  });
});
