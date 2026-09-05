import { describe, expect, it, vi } from "vitest";
import type { WalletClient } from "viem";
import type { TxSpec } from "@/domain/types";
import { TxStore, type ReceiptOutcome } from "./tx-store";

/** Deterministic clock + ids so record ordering is assertable. */
let t = 1_000_000;
let n = 0;
function testDeps(awaitReceipt?: (hash: `0x${string}`, timeoutMs: number) => Promise<ReceiptOutcome>) {
  return {
    now: () => ++t,
    newId: () => `tx-${++n}`,
    awaitReceipt,
  };
}

const HASH = "0x" + "a".repeat(64) as `0x${string}`;

function fakeWallet(): WalletClient {
  return {
    chain: { id: 31_337, name: "anvil" },
    account: { address: "0xAbC0000000000000000000000000000000000001" },
  } as unknown as WalletClient;
}

function spec(execute: TxSpec["execute"]): TxSpec {
  return { origin: "dev", kind: "self-transfer", execute };
}

const successReceipt: ReceiptOutcome = { status: "success", blockNumber: 42 };

describe("TxStore lifecycle", () => {
  it("runs the happy path signing → submitting → pending → confirmed", async () => {
    const store = new TxStore(testDeps(async () => successReceipt));
    const seen: string[] = [];
    store.subscribe(() => {
      const first = store.list()[0];
      if (first && !seen.includes(first.status)) seen.push(first.status);
    });
    const record = await store.run(
      spec(async () => ({ hash: HASH })),
      fakeWallet(),
    );
    expect(record.status).toBe("confirmed");
    expect(record.hash).toBe(HASH);
    expect(record.blockNumber).toBe(42);
    expect(record.chainId).toBe(31_337);
    expect(record.settledAt).not.toBeNull();
    // The store must have passed through every observable state.
    expect(seen).toEqual(["signing", "submitting", "pending", "confirmed"]);
    // Newest first.
    expect(store.list()).toHaveLength(1);
  });

  it("marks a 4001 signature decline as rejected, product-voiced", async () => {
    const store = new TxStore(testDeps());
    const record = await store.run(
      spec(async () => {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      }),
      fakeWallet(),
    );
    expect(record.status).toBe("rejected");
    expect(record.hash).toBeNull();
    expect(record.error).toMatch(/declined/i);
    expect(store.list()[0]?.status).toBe("rejected");
  });

  it("marks a wallet failure as failed without leaking the raw error", async () => {
    const store = new TxStore(testDeps());
    const record = await store.run(
      spec(async () => {
        throw new Error("ERC-7759 unrelated provider stack trace");
      }),
      fakeWallet(),
    );
    expect(record.status).toBe("failed");
    expect(record.error).not.toContain("ERC-7759");
  });

  it("marks an on-chain revert with the block it landed in", async () => {
    const store = new TxStore(
      testDeps(async () => ({ status: "reverted", blockNumber: 43 })),
    );
    const record = await store.run(
      spec(async () => ({ hash: HASH })),
      fakeWallet(),
    );
    expect(record.status).toBe("reverted");
    expect(record.blockNumber).toBe(43);
    expect(record.error).toMatch(/reverted/i);
  });

  it("marks a receipt timeout as failed", async () => {
    const store = new TxStore(
      testDeps(async () => {
        throw new Error("timeout");
      }),
    );
    const record = await store.run(
      spec(async () => ({ hash: HASH })),
      fakeWallet(),
    );
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/in time/i);
  });

  it("keeps records newest first and never past the cap", async () => {
    const store = new TxStore(testDeps(async () => successReceipt));
    for (let i = 0; i < 35; i += 1) {
      await store.run(spec(async () => ({ hash: HASH })), fakeWallet());
    }
    expect(store.list()).toHaveLength(30);
    const created = store.list().map((r) => r.createdAt);
    expect([...created].sort((a, b) => b - a)).toEqual(created);
  });

  it("clear() empties the session record", async () => {
    const store = new TxStore(testDeps(async () => successReceipt));
    await store.run(spec(async () => ({ hash: HASH })), fakeWallet());
    expect(store.list()).toHaveLength(1);
    store.clear();
    expect(store.list()).toHaveLength(0);
    expect(store.get("tx-1")).toBeNull();
  });

  it("notifies subscribers on every state change", async () => {
    const store = new TxStore(testDeps(async () => successReceipt));
    const listener = vi.fn();
    store.subscribe(listener);
    await store.run(spec(async () => ({ hash: HASH })), fakeWallet());
    // put() fires for signing, submitting, pending, confirmed.
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
