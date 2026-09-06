import { beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { getActiveChain } from "../chains";
import { getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { approveSpec } from "../approvals";
import { contractReads } from "../reads";
import { mintSpec, planMintApproval } from "../gusd/actions";
import { depositSpec, planEarnApproval, withdrawSpec } from "./actions";

/**
 * The earn desk's flows verified against the deployed protocol. The vault
 * is a fee-free ERC-4626 over gUSD, so the honest assertion is the
 * round-trip: the sgUSD minted by deposit equals previewDeposit, and the
 * assets-denominated withdraw pays out exactly what previewWithdraw
 * promised while burning fewer shares once the share price has grown.
 *
 * The share price moves the way production revenue moves it — gUSD lands
 * in the RevenueLedger, distribute() splits it to the vault.
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

/** Test-only handles for the two moves that grow the share price: funding
 *  the ledger and splitting it. Neither is user-surface. */
const TEST_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const DISTRIBUTE_ABI = [
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

d("sGUSD stake/unstake against the deployed protocol", () => {
  const chain = getActiveChain();
  const wallet: WalletClient = createWalletClient({
    account: privateKeyToAccount(ANVIL_KEY_0),
    chain,
    transport: http("http://127.0.0.1:8545"),
  });
  const owner = wallet.account!.address;

  beforeAll(async () => {
    // Fund the session with 2,000 gUSD the honest way: mock USDC → mint.
    const contracts = getContracts();
    const fund = 2_000_000_000n;
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

  it("stakes exactly what the preview quoted", async () => {
    const contracts = getContracts();
    const raw = 1_000_000_000n; // 1,000 gUSD
    const sharesRaw = await contracts.sgusd.read.previewDeposit([raw]);

    const need = await planEarnApproval(owner, raw);
    if (need) {
      const approve = await approveSpec(need, "earn").execute(wallet);
      await waitForTransactionReceipt(getPublicClient(), { hash: approve.hash });
    }

    const before = await contracts.sgusd.read.balanceOf([owner]);
    const { hash } = await depositSpec(raw, owner).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const after = await contracts.sgusd.read.balanceOf([owner]);
    expect(after - before).toBe(sharesRaw);

    // The read layer the desk renders from agrees with the vault.
    const state = await contractReads().sgusdState(owner);
    expect(state.seeded).toBe(true);
    const rateRaw = await contracts.sgusd.read.convertToAssets([1_000_000n]);
    expect(state.rate).toBe(Number(rateRaw) / 1e6);
  }, 30_000);

  it("grows the share price through the ledger, then unstakes assets-denominated", async () => {
    const contracts = getContracts();

    // Production revenue path, compressed: gUSD lands in the ledger,
    // distribute() splits it to the vault — the share price rises.
    const fundHash = await wallet.writeContract({
      address: contracts.addresses.gusd,
      abi: TEST_TRANSFER_ABI,
      functionName: "transfer",
      args: [contracts.addresses.ledger, 250_000_000n],
      account: wallet.account ?? null,
      chain: null,
    });
    await waitForTransactionReceipt(getPublicClient(), { hash: fundHash });
    const distHash = await wallet.writeContract({
      address: contracts.addresses.ledger,
      abi: DISTRIBUTE_ABI,
      functionName: "distribute",
      account: wallet.account ?? null,
      chain: null,
    });
    await waitForTransactionReceipt(getPublicClient(), { hash: distHash });

    const rateRaw = await contracts.sgusd.read.convertToAssets([1_000_000n]);
    expect(rateRaw > 1_000_000n).toBe(true);

    // Unstake 500 gUSD: fewer shares burned than at the seed price, and
    // the gUSD paid out is exactly the assets figure — approval-free.
    const assets = 500_000_000n;
    const sharesNeeded = await contracts.sgusd.read.previewWithdraw([assets]);
    expect(sharesNeeded).toBeLessThan(assets);

    const gusdBefore = await contracts.gusd.read.balanceOf([owner]);
    const sgBefore = await contracts.sgusd.read.balanceOf([owner]);

    const { hash } = await withdrawSpec(assets, owner).execute(wallet);
    const receipt = await waitForTransactionReceipt(getPublicClient(), { hash });
    expect(receipt.status).toBe("success");

    const gusdAfter = await contracts.gusd.read.balanceOf([owner]);
    const sgAfter = await contracts.sgusd.read.balanceOf([owner]);
    expect(gusdAfter - gusdBefore).toBe(assets);
    expect(sgBefore - sgAfter).toBe(sharesNeeded);
  }, 30_000);
});
