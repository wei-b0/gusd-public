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

const H100_GPU_ID = `0x${Buffer.from("H100_SXM_80GB", "utf8").toString("hex").padEnd(64, "0")}`;
/** The chain's write surface for the reorg test: one oracle publication. */
const PUBLISH_ABI = parseAbi(["function publish(bytes32 gpuId, uint256 price, uint256 updatedAt)"]);

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

/** Publishes a price as the deployer (the fresh deployment's publisher). */
async function publishPrice(price: number): Promise<void> {
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
    abi: PUBLISH_ABI,
    functionName: "publish",
    args: [H100_GPU_ID as `0x${string}`, BigInt(price), BigInt(Math.floor(Date.now() / 1000))],
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
  // 4 launch SKUs (oracle seed prices, enabled issuance, canonical pools),
  // quoter floats funded, mock USDT, the product churn (issuance + pool
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
      // numbers two independent Deploy.full replays landed) — 10,397.45 gUSD
      // vault share under the four-SKU universe, recomputed when Deploy.full
      // slimmed from seven SKUs (the pre-cut figure was 12,014.37 and is
      // what the stale pin on main still names).
      // Raw pg reads bypass drizzle's int8 mode:number mapping — counts
      // arrive as strings (same grain as the count(*)::text probes below).
      const closing = await schemaQuery<{ revenue_gusd: string; deposit_count: string }>(
        `select revenue_gusd, deposit_count from "gusd_index_envio_e2e_a"."SgusdVault"`,
        [],
      );
      expect(closing).toHaveLength(1);
      expect(closing[0]!.deposit_count).toBe("2"); // the seed's Deposit + the churn's stake
      expect(closing[0]!.revenue_gusd).toBe("10397454680");

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

      // Snapshot → publish 31000 → indexed → revert → publish 32000.
      const snapshot = await evmSnapshot();
      await publishPrice(31_000);
      await waitForSchema("price 31000 indexed", async () => {
        const rows = await schemaQuery<{ price: string }>(
          `select price from "gusd_index_envio_e2e_e"."OracleState" where gpu_id = $1`,
          [H100_GPU_ID],
        );
        return rows[0]?.price === "31000";
      });
      const replacedForkTip = await envioProcessedBlock(instE);

      await evmRevert(snapshot);
      await publishPrice(32_000);
      while (Number(BigInt(await anvilRpc<string>("eth_blockNumber", []))) <= replacedForkTip) {
        await anvilRpc("evm_mine", []);
      }
      await waitForSchema("price 32000 indexed", async () => {
        const rows = await schemaQuery<{ price: string }>(
          `select price from "gusd_index_envio_e2e_e"."OracleState" where gpu_id = $1`,
          [H100_GPU_ID],
        );
        return rows[0]?.price === "32000";
      });

      // The reverted publication is gone from history AND derived state;
      // everything else (the churn's swaps) survived the rollback.
      const published = await schemaQuery<{ price: string }>(
        `select price from "gusd_index_envio_e2e_e"."OraclePricePublished" where gpu_id = $1 order by block_number`,
        [H100_GPU_ID],
      );
      expect(published.map((r) => r.price)).not.toContain("31000");
      expect(published.map((r) => r.price)).toContain("32000");

      const state = await schemaQuery<{ price: string; previous_price: string | null }>(
        `select price, previous_price from "gusd_index_envio_e2e_e"."OracleState" where gpu_id = $1`,
        [H100_GPU_ID],
      );
      expect(state[0]!.price).toBe("32000");
      // Deploy.full's churn reprices H100 27555 → 30000 ("oracle reprice"
      // segment) — the last publication in history once the 31000 publish
      // reverted, so it is what previous_price points at.
      expect(state[0]!.previous_price).toBe("30000");

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
