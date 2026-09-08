import { beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { getActiveChain } from "../chains";
import { getContracts, gpuTokenClient } from "../contracts";
import { getPublicClient } from "../public-client";
import { approveSpec, planApproval } from "../approvals";
import { contractReads } from "../reads";
import { mintSpec, planMintApproval } from "../gusd/actions";
import { parseGpuUnits, parseGusd } from "@/domain/units";
import { gpuIdForAsset } from "../gpu-id";
import { quoteBuy, quoteSell } from "./quotes";
import { buySpec } from "./specs";
import { decodeTradeResult } from "./events";

/**
 * The trading desk verified against the deployed protocol at genesis. The
 * honest assertions: a genesis buy quotes 100% issuance (the canonical pool
 * holds no depth beyond the fresh bid band), the executed buy pays exactly
 * the issuance total — the router pulls the tolerance-padded cap and refunds
 * the change — and the confirmed receipt decodes back to the fill. That same
 * buy capitalizes the POL bid band, so sells quote against real depth at or
 * below the issuance price.
 *
 * Run with an anvil node up (default port 8545) and the protocol deployed:
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

  it("quotes a genesis buy as 100% issuance", async () => {
    const quote = await quoteBuy("H100", 1);
    expect(quote).not.toBeNull();
    // The canonical pool holds no liquidity at genesis — the whole fill
    // prices through issuance, and the pool leg costs nothing.
    const issue = await contractReads().quoteIssue(gpuIdForAsset("H100"), parseGpuUnits(1));
    expect(quote!.legs).toEqual([
      { kind: "issuance", gpuUnits: 1, gUsd: issue.totalPaid, fees: { issuance: issue.fee } },
    ]);
    expect(quote!.notional).toBeCloseTo(issue.totalPaid, 9);
    // The signed cap is the total plus the tolerance headroom.
    expect(quote!.maxPaid).toBeGreaterThan(issue.totalPaid);
  }, 30_000);

  it("executes a genesis buy that pays exactly the issuance quote", async () => {
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
        poolGpuOut: 0n,
        issueGpuOut: parseGpuUnits(1),
        payment: contracts.addresses.gusd,
        maxPaid: maxPaidRaw,
        sqrtLimitX96: 0n,
      },
      owner,
    ).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const gusdAfter = await contracts.gusd.read.balanceOf([owner]);
    const gpuAfter = await gpuTokenClient(token).read.balanceOf([owner]);

    // The router pulled the cap and refunded the change: the user pays
    // exactly the issuance total, not the tolerance headroom.
    const [, , totalPaid] = await contracts.issuance.read.quoteIssue([gpuId, parseGpuUnits(1)]);
    expect(gusdBefore - gusdAfter).toBe(totalPaid);
    expect(gpuAfter - gpuBefore).toBe(parseGpuUnits(1));

    // The receipt's own Buy event decodes back to the fill.
    const fill = await decodeTradeResult(hash);
    expect(fill).toMatchObject({ kind: "buy", asset: "H100", size: 1 });
    expect(fill !== null && fill.kind === "buy" ? fill.paid : -1).toBeCloseTo(
      Number(totalPaid) / 1e6,
      9,
    );
  }, 30_000);

  it("quotes sells against the primary-capitalized bid band, at or below the issuance price", async () => {
    // The genesis buy's principal now capitalizes a POL bid band priced
    // bandSpreadTicks under the ask — the sell fills there, so proceeds are
    // strictly below the issuance price (2.50), never null.
    const q = await quoteSell("H100", 1);
    expect(q).not.toBeNull();
    if (q === null) return;
    expect(q.side).toBe("sell");
    expect(q.notional).toBeGreaterThan(0);
    expect(q.price).toBeLessThanOrEqual(2.5);
  }, 30_000);
});
