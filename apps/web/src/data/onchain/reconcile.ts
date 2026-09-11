/**
 * Post-confirmation reconciliation — the runner's default reconcile hook.
 *
 * Three distinct things happen when an action confirms, in order:
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
 *   3. follow — when the first pass saw fewer hashes than the action
 *      confirmed, the result carries a bounded backoff (1s/3s/8s/15s) the
 *      runner starts: it re-checks the indexer and re-pulls the activity
 *      store as evidence grows, so CONFIRMED flips to INDEXED within
 *      seconds of the indexer catching up — no reload. The timers live
 *      here, scoped to this one action, and die with the budget.
 */

import type { IndexerPort } from "@/domain/indexer";
import { INDEXED_EVENT_NAMES } from "@/domain/indexer";
import type { TxPort } from "@/domain/ports";
import type { OnChainAccountStore } from "./account-store";

/** The follow-up backoff, ms between re-checks: ~27s of budget before the
 *  reconciler gives up and ledgers keep "this session" provenance. */
const FOLLOW_UP_DELAYS_MS = [1_000, 3_000, 8_000, 15_000] as const;

export interface ReconciliationResult {
  /** The account store finished its contract re-read. */
  balances: boolean;
  /**
   * Tx hashes the indexer already reflects — null when there is no indexer
   * or it hasn't caught up yet: ledgers keep "this session" provenance.
   */
  indexed: readonly string[] | null;
  /**
   * The follow-up check, present only when the first pass was incomplete —
   * null evidence, or fewer hashes than the action confirmed: a bounded
   * backoff re-reads the indexer (1s/3s/8s/15s) and calls `onUpdate` with
   * the grown evidence until every hash is indexed or the budget runs out —
   * indexing lag resolves in the ledgers without a reload. Fire-and-forget
   * from the runner's side; it never throws.
   */
  follow?: (onUpdate: (indexed: readonly string[] | null) => void) => void;
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

    const address = snap.address;

    // The evidence read, shared by the first pass and the follow-up: which
    // of the action's hashes the indexer reflects so far (null on failure).
    const fetchIndexed = async (
      from: number,
    ): Promise<readonly string[] | null> => {
      try {
        const events = await indexer.getUserEvents(address, {
          fromBlock: from,
          events: INDEXED_EVENT_NAMES,
        });
        if (!events) return null;
        const seen = new Set(events.map((e) => e.txHash.toLowerCase()));
        return hashes.filter((h) => seen.has(h.toLowerCase()));
      } catch {
        return null;
      }
    };

    const indexed = await fetchIndexed(fromBlock);
    if (indexed !== null && indexed.length >= hashes.length) {
      return { balances, indexed };
    }

    // Incomplete first pass — null evidence (the indexer answered nothing
    // usable) or fewer hashes than the action confirmed. Same treatment:
    // lag, not failure. The result carries a bounded backoff the runner
    // starts: it re-checks until every hash is seen or the budget runs out
    // (~27s), re-pulling the activity store as the evidence grows so
    // ledgers flip to "indexed" without a reload. Best-effort and never
    // throwing; the first-pass evidence already stands in the result.
    const follow = (onUpdate: (indexed: readonly string[] | null) => void): void => {
      void (async () => {
        let latest: readonly string[] = indexed ?? [];
        for (const delayMs of FOLLOW_UP_DELAYS_MS) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const next = await fetchIndexed(fromBlock);
          if (next !== null && next.length > latest.length) {
            latest = next;
            if (deps.activity) {
              try {
                await deps.activity.refresh();
              } catch {
                // The store's own refresh logs failures.
              }
            }
            onUpdate(latest);
            if (latest.length >= hashes.length) return;
          }
        }
      })();
    };

    return { balances, indexed, follow };
  };
}
