/**
 * Genesis spend→units solver — the money-first buy on a pool-less market.
 * Primary issuance is the only fill source there, and it prices units, not
 * spend (base = ceil(u × price / 1e16), fee = ceil(base × feeBps / 1e4)),
 * so the inverse is solved here rather than quoted. The solver works in
 * integer math against the contract's own quoteIssue — never a hand-rolled
 * fee formula — and returns the largest 4-decimal-grain unit count whose
 * quoted total does not exceed the typed spend. Anything it can't close
 * (no oracle publication, dust spend, non-convergence) is null: the honest
 * "can't quote", never an order that overspends.
 */

import { floorToLedgerGrain, GPU_LEDGER_GRAIN } from "@/domain/units";

/** One issuance quote in raw units — GPUIssuance.quoteIssue's own answer. */
export interface IssueQuoteRaw {
  base: bigint;
  fee: bigint;
  total: bigint;
}

/** The issuance quote seam — execution-identical, injectable for tests. */
export type IssueQuoteFn = (amountRaw: bigint) => Promise<IssueQuoteRaw>;

export interface SolvedIssuance {
  /** Units to buy, 18-dec raw, a multiple of the ledger grain. */
  units: bigint;
  /** The quote for exactly these units — the caller builds the leg from
   *  the same read it verified with. */
  quote: IssueQuoteRaw;
}

/** Newton iterations against the quoted total before the boundary walk. */
const MAX_REFINEMENTS = 3;
/** Bounded boundary walks (down to fit the spend, up for maximality). */
const MAX_WALK_STEPS = 8;

/**
 * The largest ledger-grain unit count whose issuance total does not exceed
 * `spendRaw`, quoted on the chain's own math. Null when the oracle price
 * is absent, the spend can't reach one grain, or the solve doesn't close.
 */
export async function issueUnitsForSpend(
  spendRaw: bigint,
  price4dp: bigint,
  feeBps: number,
  issue: IssueQuoteFn,
): Promise<SolvedIssuance | null> {
  if (spendRaw <= 0n || price4dp === 0n) return null;

  // Closed-form seed: total(u) ≈ u × price/1e16 × (1 + feeBps/1e4), so
  // invert it directly; the ceil steps are sub-grain refinements after.
  let u = (spendRaw * 10n ** 16n * 10n ** 4n) / (price4dp * (10_000n + BigInt(feeBps)));
  if (u === 0n) return null;

  // Newton refinement on the contract's own quote — issuance is linear
  // except for ceils at the micro-gUSD grain, so this converges fast.
  // total === 0 means the oracle published nothing — issue() would revert.
  let quote = await issue(u);
  for (let i = 0; i < MAX_REFINEMENTS && quote.total > 0n; i++) {
    const next = (u * spendRaw) / quote.total;
    if (next === u || next === 0n) break;
    u = next;
    quote = await issue(u);
  }
  if (quote.total === 0n) return null;

  // Land on the ledger grain and re-quote — the returned quote must be
  // the one for the returned units, since the caller builds its leg from
  // it. Then walk to the boundary: down until the total fits the spend,
  // up while one more grain still fits (maximality).
  u = floorToLedgerGrain(u);
  if (u === 0n) return null; // spend can't reach one grain of units
  quote = await issue(u);
  let steps = 0;
  while (quote.total > spendRaw && steps < MAX_WALK_STEPS) {
    u -= GPU_LEDGER_GRAIN;
    if (u === 0n) return null;
    quote = await issue(u);
    steps++;
  }
  steps = 0;
  while (steps < 2) {
    const up = u + GPU_LEDGER_GRAIN;
    const upQuote = await issue(up);
    if (upQuote.total > spendRaw) break;
    u = up;
    quote = upQuote;
    steps++;
  }
  if (u === 0n || quote.total > spendRaw || quote.total === 0n) return null;
  return { units: u, quote };
}
