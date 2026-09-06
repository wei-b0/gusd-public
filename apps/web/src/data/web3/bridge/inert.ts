/**
 * The inert bridge port — every environment without cross-chain funding
 * wired (mock universe, oracle base, or a chain whose registry capabilities
 * exclude it). The funding panel checks capabilities before rendering, so
 * this port should never be reached; if it is, it fails closed honestly.
 */

import type { Address } from "viem";
import type { BridgeOrigin, BridgeProgress, BridgeQuote } from "@/domain/bridge";
import type { BridgePort } from "@/domain/ports";

export class InertBridgePort implements BridgePort {
  origins(): BridgeOrigin[] {
    return [];
  }

  async getQuote(_originChainId: number, _token: Address, _amount: number): Promise<BridgeQuote | null> {
    return null;
  }

  async *execute(_quote: BridgeQuote): AsyncIterable<BridgeProgress> {
    yield {
      phase: "failed",
      message: "",
      txHash: null,
      error: "Cross-chain funding isn't offered here — fund the wallet on this chain directly.",
    };
  }
}
