/**
 * Post-confirmation reconciliation — the runner's default reconcile hook.
 *
 * Two distinct things happen when an action confirms, in order:
 *
 *   1. stores — the account store re-reads every balance and position from
 *      the contracts (always); then the indexed wallet-activity and market
 *      stores re-pull in parallel (when wired), and the settled seam
 *      (onSettled) drops quote caches so the next quote reads post-tx
 *      state.
 *   2. indexed — when an indexer stands behind this deployment, the
 *      confirmed transactions' events are fetched from it. The result is
 *      what draws the confirmed-vs-indexed distinction in the ledgers;
 *      until the indexer catches up, ledgers keep "this session"
 *      provenance. Indexing lag is not a failure and never renders as one.
 */

import type { IndexerPort } from "@/domain/indexer";
import { INDEXED_EVENT_NAMES } from "@/domain/indexer";
import type { TxPort } from "@/domain/ports";
import type { OnChainAccountStore } from "./account-store";

export interface ReconciliationResult {
  /** The account store finished its contract re-read. */
  balances: boolean;
  /**
   * Tx hashes the indexer already reflects — null when there is no indexer
   * or it hasn't caught up yet: ledgers keep "this session" provenance.
   */
  indexed: readonly string[] | null;
}

export interface ReconcilerDeps {
  accountStore: Pick<OnChainAccountStore, "refresh" | "get">;
  /** The earn port's own derived view (share price), when one exists. */
  earn?: { refresh(): Promise<void> };
  /** Null — the default until Ponder ships — keeps this half inert. */
  indexer?: IndexerPort | null;
  /** Tx lookup, to resolve the settled blocks the events must follow. */
  tx?: Pick<TxPort, "get">;
  /** The indexed wallet-activity store — re-pulls the wallet's indexed
   *  rows so ledgers flip to "indexed" without a reload. */
  activity?: { refresh(): Promise<void> };
  /** The indexed market store — re-polls pool/tape state the terminal
   *  shows (enrichment figures move when an action settles). */
  protocol?: { refresh(): Promise<void> };
  /** Called after the stores have been re-pulled, before indexed evidence
   *  is fetched — the seam for dropping quote caches so the next quote
   *  reads post-tx state. */
  onSettled?: () => void;
}

/**
 * The reconciler the ActionRunner calls with each action's tx ids. It never
 * throws: a failed re-read keeps the last snapshot (the store logs it) and
 * the action still completes — the transaction confirmed either way.
 */
export function makeReconciler(
  deps: ReconcilerDeps,
): (txIds: readonly string[]) => Promise<ReconciliationResult> {
  const indexer = deps.indexer ?? null;

  return async (txIds: readonly string[]): Promise<ReconciliationResult> => {
    // 1. Balances — always. The store catches read failures internally and
    //    keeps the last snapshot; the belt-and-suspenders here keeps the
    //    contract "reconcile never throws" even against a throwing store.
    let balances = false;
    try {
      await deps.accountStore.refresh();
      balances = true;
    } catch {
      // Re-read failed; the store already logged it.
    }
    if (deps.earn) {
      try {
        await deps.earn.refresh();
      } catch {
        // Derived view; its own refresh logs failures.
      }
    }

    // 1b. The indexed stores — activity (wallet rows) and protocol (pool /
    //     tape state) re-pull in parallel, then the settled seam fires so
    //     quote caches rebuild from post-tx state. Best-effort like
    //     everything above: a failed re-pull is a stale view for a moment,
    //     never a failed action.
    await Promise.allSettled(
      [deps.activity?.refresh(), deps.protocol?.refresh()].filter(
        (p): p is Promise<void> => p !== undefined,
      ),
    );
    if (deps.onSettled) {
      try {
        deps.onSettled();
      } catch {
        // A cache teardown that throws is a console problem.
      }
    }

    // 2. Indexed evidence — only when an indexer exists and the action's
    //    transactions have settled blocks to look past.
    if (!indexer || !deps.tx || txIds.length === 0) return { balances, indexed: null };

    const snap = deps.accountStore.get();
    if (!snap.address || !indexer.isIndexed(snap.chainId)) {
      return { balances, indexed: null };
    }

    // The earliest settled block among the action's transactions — events
    // from there on are the ones this action produced.
    let fromBlock: number | null = null;
    const hashes: string[] = [];
    for (const id of txIds) {
      const rec = deps.tx.get(id);
      if (rec?.status === "confirmed" && rec.blockNumber != null) {
        fromBlock = fromBlock === null ? rec.blockNumber : Math.min(fromBlock, rec.blockNumber);
        if (rec.hash) hashes.push(rec.hash);
      }
    }
    if (fromBlock === null) return { balances, indexed: null };

    const events = await indexer.getUserEvents(snap.address, {
      fromBlock,
      events: INDEXED_EVENT_NAMES,
    });
    if (!events) return { balances, indexed: null };

    const seen = new Set(events.map((e) => e.txHash.toLowerCase()));
    return { balances, indexed: hashes.filter((h) => seen.has(h.toLowerCase())) };
  };
}
