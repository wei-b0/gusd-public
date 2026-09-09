import { beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, getContract, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { getActiveChain } from "../chains";
import { getContracts, gpuTokenClient } from "../contracts";
import { getPublicClient } from "../public-client";
import { GPU_MARKET_LIQUIDITY_ABI } from "../abis/gpu_market_liquidity";
import { approveSpec, planApproval } from "../approvals";
import { contractReads } from "../reads";
import { mintSpec, planMintApproval } from "../gusd/actions";
import { formatGpuUnits, parseGpuUnits, parseGusd } from "@/domain/units";
import { gpuIdForAsset } from "../gpu-id";
import { quoteBuy, quoteSell } from "./quotes";
import { buySpec } from "./specs";
import { decodeTradeResult } from "./events";

/**
 * The trading desk verified against the deployed protocol (a fresh
 * Deploy.full chain). The honest assertions, against the hook's merged
 * ladder (native → POL ask → issuance backstop): a buy the market's ask
 * inventory covers quotes as a pure pool fill priced under the hook's ask
 * edge; a buy beyond it splits pool + issuance legs with the backstop leg
 * pricing exactly the primary's own quote; the executed buy pays exactly
 * the quote — the router pulls the tolerance-padded cap and refunds the
 * change — and the confirmed receipt decodes back to the fill; and sells
 * quote against the primary-capitalized bid at or below the bid edge.
 *
 * Run with an anvil node up (default port 8545), the protocol deployed via
 * Deploy.full's runFull(), and the stack up:
 *   RUN_ANVIL_TESTS=1 npm test
 */

const run = process.env.RUN_ANVIL_TESTS === "1";
const d = run ? describe : describe.skip;

/** Anvil's well-known funded account #0. Dev-key only — never a real key. */
const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** The deployment's USDC is a mock with a public mint — test-only handle;
 *  the bundle's ERC-20 ABI stays user-surface only by design. */
const MOCK_MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

d("trading desk against the deployed protocol", () => {
  const chain = getActiveChain();
  const wallet: WalletClient = createWalletClient({
    account: privateKeyToAccount(ANVIL_KEY_0),
    chain,
    transport: http("http://127.0.0.1:8545"),
  });
  const owner = wallet.account!.address;

  beforeAll(async () => {
    // Fund the session with 3,000 gUSD the honest way: mock USDC → mint.
    const contracts = getContracts();
    const fund = 3_000_000_000n;
    const fundHash = await wallet.writeContract({
      address: contracts.addresses.underlying,
      abi: MOCK_MINT_ABI,
      functionName: "mint",
      args: [owner, fund],
      account: wallet.account ?? null,
      chain: null,
    });
    await waitForTransactionReceipt(getPublicClient(), { hash: fundHash });
    const need = await planMintApproval(owner, contracts.addresses.underlying, fund);
    if (need) {
      const approve = await approveSpec(need, "mint").execute(wallet);
      await waitForTransactionReceipt(getPublicClient(), { hash: approve.hash });
    }
    const { hash } = await mintSpec({ asset: contracts.addresses.underlying, amountInRaw: fund, minUnderlyingOutRaw: fund, poolKey: null, to: owner }).execute(wallet);
    await waitForTransactionReceipt(getPublicClient(), { hash });
  }, 30_000);

  /** The hook's oracle-priced edges (polState: askBps, bidBps, polFeeBps,
   *  live, askPrice, bidPrice) and the vault's ask inventory. */
  async function hookEdges(gpuId: `0x${string}`) {
    const contracts = getContracts();
    const state = await contracts.hook.read.polState([gpuId]);
    const vault = getContract({
      address: await contracts.issuance.read.marketLiquidity(),
      abi: GPU_MARKET_LIQUIDITY_ABI,
      client: getPublicClient(),
    });
    return {
      askEdge: Number(state[4]) / 10_000,
      bidEdge: Number(state[5]) / 10_000,
      askInventory: await vault.read.askInventoryGpu([gpuId]),
    };
  }

  it("quotes a buy the ask inventory covers as a pure pool fill under the ask edge", async () => {
    const gpuId = gpuIdForAsset("H100");
    const { askEdge, askInventory } = await hookEdges(gpuId);
    // The seeded chain's vault holds ask inventory bought from real primary
    // flows, so a 1-GPU buy fills entirely off the market — no issuance leg.
    expect(askInventory).toBeGreaterThanOrEqual(parseGpuUnits(1));

    const quote = await quoteBuy("H100", 1);
    expect(quote).not.toBeNull();
    if (quote === null) return;
    expect(quote.legs).toHaveLength(1);
    const poolLeg = quote.legs[0];
    if (poolLeg === undefined || poolLeg.kind !== "pool") return;
    expect(poolLeg.gpuUnits).toBe(1);
    expect(poolLeg.gUsd).toBeGreaterThan(0);
    expect(poolLeg.fees.protocol).toBeGreaterThan(0);
    expect(quote.notional).toBeCloseTo(poolLeg.gUsd, 9);
    // The signed cap is the total plus the tolerance headroom.
    expect(quote.maxPaid).toBeGreaterThan(quote.notional);
    // Net of the protocol's fees the fill price sits at or under the
    // hook's ask edge — the edge the oracle priced in-swap.
    expect((quote.notional - poolLeg.fees.protocol) / quote.size).toBeLessThanOrEqual(
      askEdge + 1e-9,
    );
  }, 30_000);

  it("splits a buy beyond ask inventory into pool and issuance legs", async () => {
    const gpuId = gpuIdForAsset("H100");
    const { askInventory } = await hookEdges(gpuId);
    const size = formatGpuUnits(askInventory) + 1;
    const quote = await quoteBuy("H100", size);
    expect(quote).not.toBeNull();
    if (quote === null) return;
    // The ladder drains the market's ask inventory first, then the
    // in-swap backstop mints exactly the shortfall.
    expect(quote.legs).toHaveLength(2);
    const [poolLeg, issueLeg] = quote.legs;
    if (poolLeg === undefined || issueLeg === undefined || issueLeg.kind !== "issuance") return;
    expect(poolLeg).toMatchObject({ kind: "pool", gpuUnits: size - 1 });
    expect(issueLeg.gpuUnits).toBe(1);
    // The backstop leg prices exactly what the primary itself quotes —
    // execution-identical pricing, one unit of it (quoteIssue returns
    // product units).
    const issue = await contractReads().quoteIssue(gpuId, parseGpuUnits(1));
    expect(issueLeg.gUsd).toBeCloseTo(issue.totalPaid, 9);
    expect(issueLeg.fees.issuance).toBeCloseTo(issue.fee, 9);
    // The pool leg carries the remainder of the all-in total.
    expect(poolLeg.gUsd).toBeCloseTo(quote.notional - issueLeg.gUsd, 9);
  }, 30_000);

  it("executes a buy that pays exactly the quote", async () => {
    const contracts = getContracts();
    const gpuId = gpuIdForAsset("H100");
    const quote = await quoteBuy("H100", 1);
    expect(quote).not.toBeNull();

    const maxPaidRaw = parseGusd(quote!.maxPaid);
    const need = await planApproval(
      contracts.addresses.gusd,
      "gUSD",
      contracts.addresses.router,
      "router",
      owner,
      maxPaidRaw,
    );
    if (need) {
      const approve = await approveSpec(need, "trade").execute(wallet);
      await waitForTransactionReceipt(getPublicClient(), { hash: approve.hash });
    }

    const token = await contracts.issuance.read.tokenOf([gpuId]);
    const gusdBefore = await contracts.gusd.read.balanceOf([owner]);
    const gpuBefore = await gpuTokenClient(token).read.balanceOf([owner]);

    const { hash } = await buySpec(
      {
        gpuId,
        gpuOut: parseGpuUnits(1),
        payment: contracts.addresses.gusd,
        maxPaid: maxPaidRaw,
        deadline: 0n,
        sqrtLimitX96: 0n,
      },
      owner,
    ).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const gusdAfter = await contracts.gusd.read.balanceOf([owner]);
    const gpuAfter = await gpuTokenClient(token).read.balanceOf([owner]);

    // The router pulled the cap and refunded the change: the user pays
    // exactly the quoted total, not the tolerance headroom.
    expect(gusdBefore - gusdAfter).toBe(parseGusd(quote!.notional));
    expect(gpuAfter - gpuBefore).toBe(parseGpuUnits(1));

    // The receipt's own Buy event decodes back to the fill.
    const fill = await decodeTradeResult(hash);
    expect(fill).toMatchObject({ kind: "buy", asset: "H100", size: 1 });
    expect(fill !== null && fill.kind === "buy" ? fill.paid : -1).toBeCloseTo(quote!.notional, 9);
  }, 30_000);

  it("quotes sells against the primary-capitalized bid, at or below the bid edge", async () => {
    // Primary principal capitalizes the POL bid, priced bidBps under the
    // oracle; the sell fills there net of the protocol's take, so proceeds
    // sit strictly below the bid edge — never null.
    const q = await quoteSell("H100", 1);
    expect(q).not.toBeNull();
    if (q === null) return;
    expect(q.side).toBe("sell");
    expect(q.notional).toBeGreaterThan(0);
    const { bidEdge } = await hookEdges(gpuIdForAsset("H100"));
    expect(q.price).toBeLessThanOrEqual(bidEdge);
    // The signed floor is the proceeds minus the tolerance slack.
    expect(q.minOut).toBeLessThan(q.notional);
  }, 30_000);
});
