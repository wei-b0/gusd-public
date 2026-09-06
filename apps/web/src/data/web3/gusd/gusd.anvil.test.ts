import { describe, expect, it } from "vitest";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { getActiveChain } from "../chains";
import { getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { approveSpec, planApproval } from "../approvals";
import { stableMetaOf } from "../stables";
import { STABLE_ROUTER_ABI } from "../abis/stable_router";
import { mintSpec, quoteMint, quoteRedeem, redeemSpec } from "./actions";
import { planMintApproval } from "./actions";

/**
 * The mint desk's flows verified against the deployed contracts. The
 * previews are execution-identical by contract design, so the honest
 * assertion is the round-trip: the balance delta after mint/redeem equals
 * the raw preview, and the desk quote expresses it in product units. The
 * StableRouter's identity path (reserve asset in, no swap leg) is asserted
 * against the deployed router — the swap path needs real funding pools and
 * is covered by the Foundry suite, not here.
 *
 * Run with an anvil node up (default port 8545) and the protocol deployed:
 *   RUN_ANVIL_TESTS=1 npm test
 */

const run = process.env.RUN_ANVIL_TESTS === "1";
const d = run ? describe : describe.skip;

/** Anvil's well-known funded account #0. Dev-key only — never a real key. */
const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** The deployment's reserve asset is a mock with a public mint — test-only
 *  handle; the bundle's ERC-20 ABI stays user-surface only by design. */
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

/** Identity-path calldata placeholder: the router's identity short-circuit
 *  runs before pool validation, so the key is never dereferenced. */
const ZEROED_KEY = {
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: "0x0000000000000000000000000000000000000001",
  fee: 100,
  tickSpacing: 1,
  hooks: "0x0000000000000000000000000000000000000000",
} as const;

d("gUSD mint/redeem against the deployed protocol", () => {
  const chain = getActiveChain();
  const wallet: WalletClient = createWalletClient({
    account: privateKeyToAccount(ANVIL_KEY_0),
    chain,
    transport: http("http://127.0.0.1:8545"),
  });
  const owner = wallet.account!.address;

  it("mints exactly what the preview quoted", async () => {
    const contracts = getContracts();
    const raw = 500_000_000n; // 500 reserve units
    const quote = await quoteMint(raw);
    const gusdOutRaw = await contracts.gusd.read.previewMint([raw]);

    const fundHash = await wallet.writeContract({
      address: contracts.addresses.underlying,
      abi: MOCK_MINT_ABI,
      functionName: "mint",
      args: [owner, raw],
      account: wallet.account ?? null,
      chain: null,
    });
    await waitForTransactionReceipt(getPublicClient(), { hash: fundHash });

    const need = await planMintApproval(owner, contracts.addresses.underlying, raw);
    if (need) {
      const approve = await approveSpec(need, "mint").execute(wallet);
      await waitForTransactionReceipt(getPublicClient(), { hash: approve.hash });
    }

    const before = await contracts.gusd.read.balanceOf([owner]);
    const { hash } = await mintSpec({
      asset: contracts.addresses.underlying,
      amountInRaw: raw,
      minUnderlyingOutRaw: raw,
      poolKey: null,
      to: owner,
    }).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const after = await contracts.gusd.read.balanceOf([owner]);
    expect(after - before).toBe(gusdOutRaw);
    // The raw quote said the same thing.
    expect(quote.outputRaw).toBe(gusdOutRaw);
    expect(quote.feeRaw).toBe(raw - gusdOutRaw);
  }, 30_000);

  it("mints through the StableRouter's identity path — same economics as GUSD.mint", async () => {
    const contracts = getContracts();
    const raw = 250_000_000n;
    const gusdOutRaw = await contracts.gusd.read.previewMint([raw]);

    const fundHash = await wallet.writeContract({
      address: contracts.addresses.underlying,
      abi: MOCK_MINT_ABI,
      functionName: "mint",
      args: [owner, raw],
      account: wallet.account ?? null,
      chain: null,
    });
    await waitForTransactionReceipt(getPublicClient(), { hash: fundHash });

    // Approval lands on the router, not GUSD — the router pulls, then mints
    // (GUSD.mint inside the router pulls from the router itself). The desk's
    // planMintApproval routes the reserve asset to GUSD directly, so this
    // exercises the router's uniform entry point by hand.
    const need = await planApproval(
      contracts.addresses.underlying,
      stableMetaOf(contracts.addresses.underlying)?.symbol ?? "reserve",
      contracts.addresses.stableRouter,
      "stableRouter",
      owner,
      raw,
    );
    expect(need?.spender).toBe(contracts.addresses.stableRouter);
    if (need) {
      const approve = await approveSpec(need, "mint").execute(wallet);
      await waitForTransactionReceipt(getPublicClient(), { hash: approve.hash });
    }

    const before = await contracts.gusd.read.balanceOf([owner]);
    const reserveBefore = await contracts.stable.read.balanceOf([contracts.addresses.gusd]);
    // Identity: no swap, no unlock — pool validation only guards the swap
    // leg, so the zeroed key is never dereferenced.
    const hash = await wallet.writeContract({
      address: contracts.addresses.stableRouter,
      abi: STABLE_ROUTER_ABI,
      functionName: "mint",
      args: [contracts.addresses.underlying, raw, raw, ZEROED_KEY, owner],
      account: wallet.account ?? null,
      chain: null,
    });
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const after = await contracts.gusd.read.balanceOf([owner]);
    expect(after - before).toBe(gusdOutRaw);
    // Reserve == supply invariant holds through the router path.
    expect(await contracts.stable.read.balanceOf([contracts.addresses.gusd])).toBe(
      reserveBefore + raw,
    );
  }, 30_000);

  it("redeems exactly what the preview quoted — approval-free", async () => {
    const contracts = getContracts();
    const raw = 200_000_000n; // 200 gUSD
    const quote = await quoteRedeem(raw);
    const stableOutRaw = await contracts.gusd.read.previewRedeem([raw]);

    const gusdBefore = await contracts.gusd.read.balanceOf([owner]);
    const stableBefore = await contracts.stable.read.balanceOf([owner]);

    const { hash } = await redeemSpec({
      asset: contracts.addresses.underlying,
      gusdInRaw: raw,
      minStableOutRaw: 0n,
      poolKey: null,
      to: owner,
    }).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const gusdAfter = await contracts.gusd.read.balanceOf([owner]);
    const stableAfter = await contracts.stable.read.balanceOf([owner]);
    expect(gusdBefore - gusdAfter).toBe(raw);
    expect(stableAfter - stableBefore).toBe(stableOutRaw);
    expect(quote.outputRaw).toBe(stableOutRaw);
    expect(quote.feeRaw).toBe(raw - stableOutRaw);
  }, 30_000);
});
