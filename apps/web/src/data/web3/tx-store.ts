/**
 * The transaction lifecycle engine — framework-free, driven by whatever the
 * auth adapter hands it. One TxStore owns every record this session ran:
 *
 *   signing → (user declines) rejected
 *           → (wallet error)  failed
 *           → submitting → pending → confirmed | reverted
 *                                  → (receipt timeout) failed
 *
 * `submitting` is the window where the wallet has returned a hash but the
 * read client has not begun watching for it; `pending` is the receipt wait.
 * With provider-backed wallets (sign + send in one eth_sendTransaction) the
 * first two windows collapse into `signing`, which is honest: there was
 * never an observable moment where the signature existed without a hash.
 *
 * Records are session-local evidence of what this app drove — never a
 * portfolio or history source. Snapshot arrays are frozen between changes so
 * useSyncExternalStore's Object.is comparison stays stable.
 */

import { waitForTransactionReceipt } from "viem/actions";
import type { WalletClient } from "viem";
import type { TxRecord, TxSpec } from "@/domain/types";
import { isUserRejection } from "./wallet-client";
import { getPublicClient } from "./public-client";

/** Receipt wait window before a pending tx is declared lost. */
export const RECEIPT_TIMEOUT_MS = 120_000;
/** Session-local by design; the oldest record falls off past this. */
const MAX_RECORDS = 30;

/** What a receipt wait reports: inclusion status and the block it landed in. */
export interface ReceiptOutcome {
  status: "success" | "reverted";
  blockNumber: number;
}

export interface TxStoreDeps {
  /** Now-millis, injectable for tests. */
  now?: () => number;
  /** Session-local id generation, injectable for tests. */
  newId?: () => string;
  /**
   * The receipt wait, injectable so tests run network-free. Default is
   * viem's waitForTransactionReceipt against the public client.
   */
  awaitReceipt?: (
    hash: `0x${string}`,
    timeoutMs: number,
  ) => Promise<ReceiptOutcome>;
}

export class TxStore {
  private records = new Map<string, TxRecord>();
  private listeners = new Set<() => void>();
  private snapshot: readonly TxRecord[] = [];
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly awaitReceiptFn: (
    hash: `0x${string}`,
    timeoutMs: number,
  ) => Promise<ReceiptOutcome>;

  constructor(deps: TxStoreDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.awaitReceiptFn = deps.awaitReceipt ?? defaultAwaitReceipt;
  }

  /** This session's transactions, newest first. */
  list(): readonly TxRecord[] {
    return this.snapshot;
  }

  get(id: string): TxRecord | null {
    return this.records.get(id) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Clear session records (logout). */
  clear(): void {
    this.records.clear();
    this.snapshot = [];
    this.emit();
  }

  /**
   * Drive one transaction through the full lifecycle. Rejects only for
   * pre-flight refusals (no session signer); after the wallet is asked to
   * sign, the promise resolves to the terminal record — UI reads state
   * rather than catching product failures.
   */
  async run(spec: TxSpec, wallet: WalletClient): Promise<TxRecord> {
    const id = this.newId();
    const t0 = this.now();
    const record: TxRecord = {
      id,
      hash: null,
      status: "signing",
      origin: spec.origin,
      kind: spec.kind,
      chainId: wallet.chain?.id ?? 0,
      address: wallet.account?.address ?? null,
      createdAt: t0,
      updatedAt: t0,
      settledAt: null,
      blockNumber: null,
      error: null,
    };
    this.put(record);

    let hash: `0x${string}`;
    try {
      ({ hash } = await spec.execute(wallet));
    } catch (err) {
      if (isUserRejection(err)) {
        return this.settle(id, {
          status: "rejected",
          error: "Signature declined. Connect again to continue.",
        });
      }
      return this.settle(id, {
        status: "failed",
        error: "The wallet refused the request. Try again.",
      });
    }

    this.patch(id, { hash, status: "submitting" });
    return this.awaitReceipt(id, hash);
  }

  /** Wait for inclusion and settle the record. */
  private async awaitReceipt(id: string, hash: `0x${string}`): Promise<TxRecord> {
    this.patch(id, { status: "pending" });
    try {
      const receipt = await this.awaitReceiptFn(hash, RECEIPT_TIMEOUT_MS);
      if (receipt.status === "success") {
        return this.settle(id, {
          status: "confirmed",
          blockNumber: receipt.blockNumber,
          settledAt: this.now(),
        });
      }
      return this.settle(id, {
        status: "reverted",
        blockNumber: receipt.blockNumber,
        settledAt: this.now(),
        error: "The transaction reverted on-chain. Nothing moved.",
      });
    } catch {
      return this.settle(id, {
        status: "failed",
        error: "No confirmation arrived in time — check the explorer before retrying.",
      });
    }
  }

  private patch(id: string, fields: Partial<TxRecord>): void {
    const current = this.records.get(id);
    if (!current) return;
    this.put({ ...current, ...fields, updatedAt: this.now() });
  }

  private settle(
    id: string,
    fields: Partial<TxRecord> & Pick<TxRecord, "status">,
  ): TxRecord {
    const current = this.records.get(id);
    if (!current) throw new Error(`Unknown transaction record ${id}`);
    const next: TxRecord = {
      ...current,
      ...fields,
      updatedAt: this.now(),
    };
    this.put(next);
    return next;
  }

  /** Store, re-sort newest first, freeze the snapshot, notify. */
  private put(record: TxRecord): void {
    this.records.set(record.id, record);
    const sorted = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
    // The oldest records fall off past the cap; they are session-local by design.
    for (const dead of sorted.slice(MAX_RECORDS)) this.records.delete(dead.id);
    this.snapshot = sorted.slice(0, MAX_RECORDS);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Production receipt wait: viem's action over the memoized public client. */
function defaultAwaitReceipt(
  hash: `0x${string}`,
  timeoutMs: number,
): Promise<ReceiptOutcome> {
  return waitForTransactionReceipt(getPublicClient(), {
    hash,
    confirmations: 1,
    timeout: timeoutMs,
  }).then((receipt) => ({
    status: receipt.status,
    blockNumber: Number(receipt.blockNumber ?? 0),
  }));
}
