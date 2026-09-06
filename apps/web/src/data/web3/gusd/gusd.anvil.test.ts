import { describe, expect, it } from "vitest";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { getActiveChain } from "../chains";
import { getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { approveSpec } from "../approvals";
import { mintSpec, quoteMint, quoteRedeem, redeemSpec } from "./actions";
import { planMintApproval } from "./actions";

/**
 * The mint desk's flows verified against the deployed contracts. The
 * previews are execution-identical by contract design, so the honest
 * assertion is the round-trip: the balance delta after mintUSDC/redeemUSDC
 * equals the raw preview, and the desk quote expresses it in product units.
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
    const raw = 500_000_000n; // 500 USDC
    const quote = await quoteMint(raw);
    const gusdOutRaw = await contracts.gusd.read.previewMintUSDC([raw]);

    const fundHash = await wallet.writeContract({
      address: contracts.addresses.usdc,
      abi: MOCK_MINT_ABI,
      functionName: "mint",
      args: [owner, raw],
      account: wallet.account ?? null,
      chain: null,
    });
    await waitForTransactionReceipt(getPublicClient(), { hash: fundHash });

    const need = await planMintApproval(owner, raw);
    if (need) {
      const approve = await approveSpec(need, "mint").execute(wallet);
      await waitForTransactionReceipt(getPublicClient(), { hash: approve.hash });
    }

    const before = await contracts.gusd.read.balanceOf([owner]);
    const { hash } = await mintSpec(raw, owner).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const after = await contracts.gusd.read.balanceOf([owner]);
    expect(after - before).toBe(gusdOutRaw);
    // The desk quote said the same thing in product units.
    expect(quote.output).toBe(Number(gusdOutRaw) / 1e6);
    expect(quote.fee).toBe((Number(raw) - Number(gusdOutRaw)) / 1e6);
  }, 30_000);

  it("redeems exactly what the preview quoted — approval-free", async () => {
    const contracts = getContracts();
    const raw = 200_000_000n; // 200 gUSD
    const quote = await quoteRedeem(raw);
    const usdcOutRaw = await contracts.gusd.read.previewRedeemUSDC([raw]);

    const gusdBefore = await contracts.gusd.read.balanceOf([owner]);
    const usdcBefore = await contracts.usdc.read.balanceOf([owner]);

    const { hash } = await redeemSpec(raw, owner).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const gusdAfter = await contracts.gusd.read.balanceOf([owner]);
    const usdcAfter = await contracts.usdc.read.balanceOf([owner]);
    expect(gusdBefore - gusdAfter).toBe(raw);
    expect(usdcAfter - usdcBefore).toBe(usdcOutRaw);
    expect(quote.output).toBe(Number(usdcOutRaw) / 1e6);
    expect(quote.fee).toBe((Number(raw) - Number(usdcOutRaw)) / 1e6);
  }, 30_000);
});
