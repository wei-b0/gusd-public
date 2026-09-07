/**
 * The gated onchain suites (RUN_ANVIL_TESTS=1): reorg rollback, determinism
 * of full re-backfills, and views rotation. Self-contained — the harness
 * boots its own anvil, deploys + churns from a throwaway copy of the
 * contracts app, and runs its own `ponder start` instances in scratch
 * schemas (see ./harness.ts). Gated because it needs foundry, Postgres, and
 * minutes of wall clock:
 *
 *   RUN_ANVIL_TESTS=1 pnpm --filter @gusd/indexer test:anvil
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  ANVIL_URL,
  DEPLOYER_PK,
  SCRATCH_SCHEMAS,
  connectPg,
  dropScratchSchemas,
  dumpSchema,
  evmRevert,
  evmSnapshot,
  expectDumpsEqual,
  readDeployment,
  runForgeScript,
  spawnAnvil,
  spawnPonder,
  teardown,
  viewDefinition,
  type PonderInstance,
  type TableDump,
} from "./harness.js";

const H100_GPU_ID = `0x${Buffer.from("H100_SXM_80GB", "utf8").toString("hex").padEnd(64, "0")}`;
/** The chain's write surface for the reorg test: one oracle publication. */
const PUBLISH_ABI = parseAbi(["function publish(bytes32 gpuId, uint256 price, uint256 updatedAt)"]);

// House gate idiom: the suite costs minutes of wall clock plus foundry +
// Postgres, so it only runs under RUN_ANVIL_TESTS=1.
const run = process.env.RUN_ANVIL_TESTS === "1";
const d = run ? describe : describe.skip;

const instances: PonderInstance[] = [];
let pg: Awaited<ReturnType<typeof connectPg>> | null = null;

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
}

async function waitForSchema(
  label: string,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  await spawnAnvil();
  // Deployment + the FULL Demo churn on this virgin chain: genesis funding +
  // buy (Issued), external LP, pool buy, mixed-leg buy, sell, reprice to
  // 30000, repriced gUSD issuance buy, harvest + distribute. (IndexerDemo is
  // the dev-chain variant that skips Demo's genesis step — it fails on a
  // fresh chain with TRANSFER_FROM_FAILED.)
  await runForgeScript("Deploy");
  await runForgeScript("Demo");
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
      const instA = await spawnPonder({
        schema: "gusd_index_e2e_a",
        viewsSchema: "gusd_index_e2e_rot",
        port: 42481,
      });
      instances.push(instA);

      // The churn's oracle publication (IndexerDemo step 6) is the
      // last-landed protocol event; its presence in the derived state means
      // the historical backfill reached it.
      const rows = await schemaQuery<{ price: string }>(
        `select price from "gusd_index_e2e_a".oracle_state where gpu_id = $1`,
        [H100_GPU_ID],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.price).toBe("30000");

      const swaps = await schemaQuery<{ count: string }>(
        `select count(*)::text as count from "gusd_index_e2e_a".pm_swap`,
        [],
      );
      expect(Number(swaps[0]!.count)).toBeGreaterThan(0);
    },
    300_000,
  );

  it(
    "re-backfills byte-identically into a fresh schema (determinism)",
    async () => {
      const dumpA: TableDump = await dumpSchema(pg!, "gusd_index_e2e_a");
      const instB = await spawnPonder({
        schema: "gusd_index_e2e_b",
        viewsSchema: "gusd_index_e2e_rot",
        port: 42482,
      });
      instances.push(instB);
      const dumpB = await dumpSchema(pg!, "gusd_index_e2e_b");
      expectDumpsEqual(dumpA, dumpB, "fresh re-backfill");
      await instB.kill();
    },
    300_000,
  );

  it(
    "restarts on an existing schema and changes nothing (checkpoint resume)",
    async () => {
      const dumpA: TableDump = await dumpSchema(pg!, "gusd_index_e2e_a");
      const restarted = await spawnPonder({
        schema: "gusd_index_e2e_a",
        viewsSchema: "gusd_index_e2e_rot",
        port: 42481,
      });
      instances.push(restarted);
      const dumpA2 = await dumpSchema(pg!, "gusd_index_e2e_a");
      expectDumpsEqual(dumpA, dumpA2, "restart resume");
      await restarted.kill();
    },
    300_000,
  );

  it(
    "re-points the stable views schema to a newer deployment on ready",
    async () => {
      const instC = await spawnPonder({
        schema: "gusd_index_e2e_c",
        viewsSchema: "gusd_index_e2e_rot",
        port: 42483,
      });
      instances.push(instC);
      const defC = await viewDefinition(pg!, "gusd_index_e2e_rot", "pm_swap");
      expect(defC).toContain("gusd_index_e2e_c");

      const instD = await spawnPonder({
        schema: "gusd_index_e2e_d",
        viewsSchema: "gusd_index_e2e_rot",
        port: 42484,
      });
      instances.push(instD);
      const defD = await viewDefinition(pg!, "gusd_index_e2e_rot", "pm_swap");
      expect(defD).toContain("gusd_index_e2e_d");
      expect(defD).not.toContain("gusd_index_e2e_c");

      // The Fastify query path is plain SQL over the views schema — it must
      // keep answering with identical data across the rotation.
      const viaViews = await schemaQuery<{ count: string }>(
        `select count(*)::text as count from "gusd_index_e2e_rot".pm_swap`,
        [],
      );
      const viaTables = await schemaQuery<{ count: string }>(
        `select count(*)::text as count from "gusd_index_e2e_d".pm_swap`,
        [],
      );
      expect(viaViews[0]!.count).toBe(viaTables[0]!.count);

      await instC.kill();
      await instD.kill();
    },
    300_000,
  );

  it(
    "rolls back event + derived state across a chain reorg",
    async () => {
      const instE = await spawnPonder({
        schema: "gusd_index_e2e_e",
        viewsSchema: "gusd_index_e2e_rot",
        port: 42485,
      });
      instances.push(instE);

      const swapCount = async (): Promise<number> =>
        Number(
          (
            await schemaQuery<{ count: string }>(
              `select count(*)::text as count from "gusd_index_e2e_e".pm_swap`,
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
          `select price from "gusd_index_e2e_e".oracle_state where gpu_id = $1`,
          [H100_GPU_ID],
        );
        return rows[0]?.price === "31000";
      });

      await evmRevert(snapshot);
      await publishPrice(32_000);
      await waitForSchema("price 32000 indexed", async () => {
        const rows = await schemaQuery<{ price: string }>(
          `select price from "gusd_index_e2e_e".oracle_state where gpu_id = $1`,
          [H100_GPU_ID],
        );
        return rows[0]?.price === "32000";
      });

      // The reverted publication is gone from history AND derived state;
      // everything else (the churn's swaps) survived the rollback.
      const published = await schemaQuery<{ price: string }>(
        `select price from "gusd_index_e2e_e".oracle_price_published where gpu_id = $1 order by block_number`,
        [H100_GPU_ID],
      );
      expect(published.map((r) => r.price)).not.toContain("31000");
      expect(published.map((r) => r.price)).toContain("32000");

      const state = await schemaQuery<{ price: string; previous_price: string | null }>(
        `select price, previous_price from "gusd_index_e2e_e".oracle_state where gpu_id = $1`,
        [H100_GPU_ID],
      );
      expect(state[0]!.price).toBe("32000");
      expect(state[0]!.previous_price).toBe("30000"); // demo's pre-reorg value

      expect(await swapCount()).toBe(swapsBefore);
      await instE.kill();
    },
    300_000,
  );
});

d("scratch schema hygiene", () => {
  it("only uses suite-owned schema names", () => {
    for (const name of SCRATCH_SCHEMAS) {
      expect(name).toMatch(/^gusd_index_e2e_[a-z_]+$/);
      expect(name.length).toBeLessThanOrEqual(30);
    }
  });
});
