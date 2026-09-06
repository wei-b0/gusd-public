/**
 * Cross-chain funding vocabulary — bringing a stable from a supported origin
 * chain into the active chain so it can mint gUSD. The protocol itself never
 * bridges and never custodies bridged value: this is a UI-layer aggregator
 * flow (Across) that lands funds in the wallet, after which the ordinary
 * mint desk takes over. Supply stays chain-local; gUSD is never portable
 * across chains.
 */

import type { Address, Hash } from "viem";

/** One origin-chain funding token — hand-vetted canonical issuers (Circle /
 *  Tether), never symbol-derived. All are 6-decimal stables. */
export interface BridgeToken {
  address: Address;
  /** Display symbol — a label, never an identity check. */
  symbol: string;
  name: string;
}

/** An origin chain the bridge serves, with its fundable tokens. */
export interface BridgeOrigin {
  chainId: number;
  label: string;
  tokens: BridgeToken[];
}

/**
 * A priced route from an origin token to the active chain's reserve asset.
 * All figures are product units (6-decimal stables, parsed by the same
 * rules as the mint desk).
 */
export interface BridgeQuote {
  /** Quote identity — the adapter validates it before executing. */
  id: string;
  originChainId: number;
  inputToken: Address;
  inputAmount: number;
  /** What the wallet receives on the active chain, on the happy path. */
  expectedOutput: number;
  /** The execution floor — what the bridge guarantees at minimum. */
  minOutput: number;
  /** All-in cost in input units (input − expected output). */
  originFee: number;
  /** Relayer fill time estimate from the bridge API. */
  etaSeconds: number;
}

/** The bridge's own state machine, yielded while it runs. The mint-desk
 *  action runner never sees these — bridging is not a protocol action. */
export type BridgePhase =
  | "quoting" // re-pricing before execution
  | "approving" // origin spend approval signing/confirming
  | "bridging" // origin deposit submitted, waiting for the fill
  | "filled" // funds landed in the wallet on the active chain
  | "mint-ready" // hand-off: the mint desk can now mint from the reserve asset
  | "failed"; // terminal — `error` carries the product voice

export interface BridgeProgress {
  phase: BridgePhase;
  message: string;
  /** Chain hash of the most recent leg (origin approval or deposit). */
  txHash: Hash | null;
  /** Product-voice failure reason; null until `failed`. */
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* The funding panel's run loop                                        */
/* ------------------------------------------------------------------ */

/** How the bridge leg ends. The mint hand-off is the caller's: it prefills
 *  the mint desk with the quote's guaranteed floor. */
export type BridgeOutcome =
  | { kind: "mint" } // mint-ready — funds landed, quote.minOutput is the floor
  | { kind: "failed"; error: string };

/**
 * Drives one bridge quote to its terminal state. Progress yields stream
 * through `onProgress` (the panel renders them); the returned outcome is
 * the only thing that changes what the panel does next. Never throws for
 * a bridge that reported its own failure — only for a port that throws.
 */
export async function runBridgeToMint(
  bridge: { execute(quote: BridgeQuote): AsyncIterable<BridgeProgress> },
  quote: BridgeQuote,
  onProgress: (p: BridgeProgress) => void,
): Promise<BridgeOutcome> {
  for await (const progress of bridge.execute(quote)) {
    if (progress.phase === "mint-ready") return { kind: "mint" };
    if (progress.phase === "failed") {
      return { kind: "failed", error: progress.error ?? "The bridge failed." };
    }
    onProgress(progress);
  }
  return { kind: "failed", error: "The bridge ended without confirming the fill." };
}
