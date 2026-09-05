import { describe, expect, it } from "vitest";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import type { TxSpec, TxStatus } from "@/domain/types";
import { getActiveChain } from "./chains";
import { getPublicClient } from "./public-client";
import { selfTransferSpec } from "./self-transfer";
import { TxStore } from "./tx-store";

/**
 * The lifecycle verified against a live node. The plan's tx-realism decision:
 * full lifecycle infrastructure proven on Anvil via ETH self-transfer — no
 * browser, no wallet extension, no Privy session needed; the store takes any
 * viem WalletClient, so a funded dev key stands in for the signer. The
 * wallet-prompt paths (4001 via MetaMask, Privy embedded prompts) stay
 * covered by the network-free unit suite in tx-store.test.ts.
 *
 * Run with an anvil node up (default port 8545):
 *   anvil &
 *   RUN_ANVIL_TESTS=1 npm test
 */

const run = process.env.RUN_ANVIL_TESTS === "1";
const d = run ? describe : describe.skip;

/** Anvil's well-known funded account #0. Dev-key only — never a real key. */
const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/**
 * Deployment initcode whose runtime is a bare REVERT(0,0): PUSH5 runtime,
 * PUSH0 MSTORE offset, RETURN(27, 5). A call into the deployed contract
 * reverts on-chain — the honest revert vector without protocol contracts.
 */
const REVERT_RUNTIME_INITCODE =
  "0x6460006000fd5f526005601bf3" as const;

let n = 0;
function anvilStore(): TxStore {
  return new TxStore({ newId: () => `anvil-${++n}` });
}

/** Status transitions observed for one record id while work is in flight. */
function trackStatuses(store: TxStore, id: string): () => TxStatus[] {
  const seen: TxStatus[] = [];
  const push = (s: TxStatus) => {
    if (seen[seen.length - 1] !== s) seen.push(s);
  };
  store.subscribe(() => {
    const record = store.get(id);
    if (record) push(record.status);
  });
  return () => seen;
}

d("TxStore against a live anvil node", () => {
  const chain = getActiveChain();

  const wallet: WalletClient = createWalletClient({
    account: privateKeyToAccount(ANVIL_KEY_0),
    chain,
    transport: http("http://127.0.0.1:8545"),
  });

  it("runs a self-transfer through signing → submitting → pending → confirmed", async () => {
    const store = anvilStore();
    const statuses = trackStatuses(store, "anvil-1");

    const record = await store.run(selfTransferSpec(), wallet);
    expect(record.status).toBe("confirmed");
    expect(record.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(record.blockNumber).toBeGreaterThan(0);
    expect(record.settledAt).not.toBeNull();
    expect(record.chainId).toBe(chain.id);
    expect(record.address?.toLowerCase()).toBe(wallet.account!.address.toLowerCase());
    expect(record.error).toBeNull();

    const seen = statuses();
    expect(seen[0]).toBe("signing");
    expect(seen).toContain("submitting");
    expect(seen).toContain("pending");
    expect(seen[seen.length - 1]).toBe("confirmed");
    // Newest first, session-local ordering.
    expect(store.list()[0]?.id).toBe(record.id);
  }, 30_000);

  it("settles an on-chain revert as reverted with the block number", async () => {
    const store = anvilStore();

    // Deploy the always-revert contract, then call it with a fixed gas so
    // viem skips estimation (estimation would refuse before any hash).
    const deployHash = await wallet.deployContract({
      abi: [],
      bytecode: REVERT_RUNTIME_INITCODE,
      account: wallet.account!.address,
      chain: null,
    });
    const deployment = await waitForTransactionReceipt(getPublicClient(), {
      hash: deployHash,
    });
    const reverting = deployment.contractAddress;
    expect(reverting).toBeDefined();

    const spec: TxSpec = {
      origin: "dev",
      kind: "revert-probe",
      async execute(w) {
        const hash = await w.sendTransaction({
          account: w.account!.address,
          to: reverting!,
          data: "0x",
          gas: 100_000n,
          chain: null,
        });
        return { hash };
      },
    };
    const record = await store.run(spec, wallet);

    expect(record.status).toBe("reverted");
    expect(record.blockNumber).toBeGreaterThan(0);
    expect(record.error).toBe("The transaction reverted on-chain. Nothing moved.");
  }, 30_000);

  it("marks a signature decline as rejected without a hash", async () => {
    const store = anvilStore();
    const spec: TxSpec = {
      origin: "dev",
      kind: "self-transfer",
      async execute() {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
    };
    const record = await store.run(spec, wallet);

    expect(record.status).toBe("rejected");
    expect(record.hash).toBeNull();
    expect(record.error).toBe("Signature declined. Connect again to continue.");
  });
});
