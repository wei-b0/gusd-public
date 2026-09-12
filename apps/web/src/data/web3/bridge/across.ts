/**
 * The Across bridge adapter — the one cross-chain funding implementation.
 * Origin tokens are hand-vetted canonical issuers (the same trust posture as
 * stables.ts: identity from config, never from a `symbol()` read); the
 * destination token is always the deployment record's reserve asset. When the
 * origin token is not itself the reserve, Across converts it inside the same
 * intent — on Robinhood Chain that conversion is Paxos Transit (rate locked at
 * submission, no separate swap step) — so the quote's output is already the
 * reserve. The port mints nothing: its last phase is `mint-ready`, and the
 * mint desk takes over from there. Across serves mainnets only — the funding
 * panel checks the chain registry's capabilities before this port is ever used.
 *
 * Quotes and execution go through @across-protocol/app-sdk (its
 * executeSwapQuote owns SpokePool calldata correctness, allowance checks,
 * and fill polling). The SDK is loaded lazily — a build without this flow
 * active never imports it.
 */

import type { Address, Hash, WalletClient } from "viem";
import type { WalletSession } from "@/domain/types";
import type {
  BridgeOrigin,
  BridgeProgress,
  BridgeQuote,
  BridgeToken,
} from "@/domain/bridge";
import type { BridgePort } from "@/domain/ports";
import type { SwapExecutionProgress, ConfiguredWalletClient } from "@across-protocol/app-sdk";
// The quote response type lives under the SDK's api namespace (not re-exported
// from the package root).
import type { SwapApprovalApiResponse } from "@across-protocol/app-sdk/dist/api/swap-approval";
import { parseStable, formatStableRaw } from "@/domain/units";
import { getContracts } from "../contracts";
import { getActiveChain } from "../chains";

/** How the adapter reaches the wallet — the AuthPort surface it needs,
 *  narrowed so tests can stub the seam. */
export interface AcrossBridgeDeps {
  getSession(): WalletSession;
  getWalletClient(chainId: number): Promise<WalletClient>;
  /** The wallet must sit on the origin chain for approve + deposit. */
  switchChain(chainId: number): Promise<void>;
}

/**
 * Origin funding tokens — canonical issuer addresses per chain, verified
 * against the issuers' own deployment lists AND Across's own routing
 * universe (GET /swap/tokens) before shipping. Never extended from a
 * token's self-reported metadata. USDG leads where it is native and
 * routable (Ethereum); USDC/USDT origins are converted to the reserve
 * inside the bridge intent itself. Arbitrum One has native Paxos USDG
 * (0x004B…9bbC) but Across does not serve it — listing it would dead-end
 * every quote to the amber no-route state, so it stays out until the
 * router lists it.
 */
const ORIGIN_TOKENS: Record<number, BridgeToken[]> = {
  1: [
    // Paxos USDG — native on Ethereum (docs.paxos.com/guides/stablecoin/usdg/mainnet)
    // and routable on Across (live-verified against app.across.to/api).
    { address: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", symbol: "USDG", name: "Global Dollar" },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", name: "USD Coin" },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD" },
  ],
  // Base has no native USDG (only the LayerZero USDG0 OFT) — USDC stays the
  // sole origin and converts to the reserve in transit.
  8453: [
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin" },
  ],
  42161: [
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", name: "USD Coin" },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", name: "Tether USD" },
  ],
};

/** Origin chain labels — static because the registry only names chains the
 *  app deploys to, and origins are by definition other chains. */
const ORIGIN_LABELS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum One",
};

/** Slippage on the bridge leg (fraction, Across convention 0–1). The floor
 *  lands in the quote; the mint leg keeps its own tolerance. */
const BRIDGE_SLIPPAGE = 0.002;

/** 2-byte integrator tag — Across attribution; unset integrators send zero. */
const INTEGRATOR_ID = "0x0000" as const;

export class AcrossBridgePort implements BridgePort {
  /** Issued quotes, by id — execution needs the SDK's raw quote object. */
  private issued = new Map<string, { quote: BridgeQuote; raw: SwapApprovalApiResponse }>();
  private client: import("@across-protocol/app-sdk").AcrossClient | null = null;

  constructor(private deps: AcrossBridgeDeps) {}

  origins(): BridgeOrigin[] {
    return Object.entries(ORIGIN_TOKENS).map(([id, tokens]) => ({
      chainId: Number(id),
      label: ORIGIN_LABELS[Number(id)] ?? `Chain ${id}`,
      tokens,
    }));
  }

  async getQuote(
    originChainId: number,
    token: Address,
    amount: number,
  ): Promise<BridgeQuote | null> {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const originTokens = ORIGIN_TOKENS[originChainId];
    if (!originTokens?.some((t) => t.address.toLowerCase() === token.toLowerCase())) return null;
    const destination = destinationToken();
    const depositor = this.depositor();
    if (depositor === null) return null;
    try {
      const client = await this.sdk();
      const raw = await client.getSwapQuote({
        route: { originChainId, inputToken: token, destinationChainId: getActiveChain().id, outputToken: destination },
        amount: parseStable(amount),
        depositor,
        slippage: BRIDGE_SLIPPAGE,
      });
      const quote: BridgeQuote = {
        id: raw.id ?? `${originChainId}:${token}:${raw.expectedOutputAmount}`,
        originChainId,
        inputToken: token,
        inputAmount: formatStableRaw(BigInt(raw.inputAmount)),
        expectedOutput: formatStableRaw(BigInt(raw.expectedOutputAmount)),
        minOutput: formatStableRaw(BigInt(raw.minOutputAmount)),
        originFee: formatStableRaw(BigInt(raw.inputAmount) - BigInt(raw.expectedOutputAmount)),
        etaSeconds: raw.expectedFillTime,
      };
      this.issued.set(quote.id, { quote, raw });
      // Keep the issued set bounded — stale quotes expire server-side anyway.
      if (this.issued.size > 16) {
        const oldest = this.issued.keys().next().value;
        if (oldest !== undefined) this.issued.delete(oldest);
      }
      return quote;
    } catch (err) {
      console.warn(
        `[bridge] quote failed for ${originChainId}:${token}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  async *execute(quote: BridgeQuote): AsyncIterable<BridgeProgress> {
    const issued = this.issued.get(quote.id);
    if (issued === undefined || this.isStale(issued.quote, quote)) {
      yield {
        phase: "failed",
        message: "",
        txHash: null,
        error: "This bridge quote expired — request a fresh one; nothing moved.",
      };
      return;
    }
    const session = this.deps.getSession();
    if (session.status !== "connected" || session.address === null) {
      yield {
        phase: "failed",
        message: "",
        txHash: null,
        error: "Connect a wallet to bridge — nothing signs without one.",
      };
      return;
    }

    const origin = quote.originChainId;
    // The origin legs sign on the origin chain; the wallet is asked to
    // switch (and the chain added) before any transaction is built.
    await this.deps.switchChain(origin);
    const wallet = await this.deps.getWalletClient(origin);

    // A promise-channel turns the SDK's callback stream into the yield
    // stream — every SDK event lands exactly once, in order.
    const queue: BridgeProgress[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (p: BridgeProgress) => {
      queue.push(p);
      wake?.();
      wake = null;
    };
    const finish = () => {
      done = true;
      wake?.();
      wake = null;
    };

    let depositSubmitted = false;
    const client = await this.sdk();
    const running = client
      .executeSwapQuote({
        swapQuote: issued.raw,
        // The SDK narrows viem's client generics (its own viem instance);
        // the runtime surface is the same wallet client.
        walletClient: wallet as ConfiguredWalletClient,
        onProgress: (sdkProgress) => {
          // The flag must flip before the same event maps — the fill leg's
          // error voice depends on whether the deposit landed.
          if (sdkProgress.step === "swap" && sdkProgress.status === "txSuccess") depositSubmitted = true;
          const p = mapProgress(sdkProgress, depositSubmitted);
          if (p !== null) push(p);
        },
      })
      .then(async (res) => {
        if (res.error) {
          push({ phase: "failed", message: "", txHash: null, error: voice(res.error, depositSubmitted) });
          return;
        }
        // The wallet's work is done — the fill was the relayer's. Return it
        // to the desk's chain so the mint leg signs there without a manual
        // switch (and the network strip settles back to green).
        try {
          await this.deps.switchChain(getActiveChain().id);
        } catch {
          // The mint leg's own guard names the fix if the return didn't land.
        }
        push({
          phase: "mint-ready",
          message:
            "Funds landed in the wallet as the reserve asset — the mint desk can take it from here.",
          txHash: null,
          error: null,
        });
      })
      .catch((err: unknown) => {
        push({
          phase: "failed",
          message: "",
          txHash: null,
          error: voice(err instanceof Error ? err : new Error(String(err)), depositSubmitted),
        });
      })
      .finally(finish);

    while (true) {
      while (queue.length > 0) {
        const p = queue.shift();
        if (p) yield p;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await running;
    this.issued.delete(quote.id);
  }

  private isStale(issued: BridgeQuote, presented: BridgeQuote): boolean {
    return (
      issued.originChainId !== presented.originChainId ||
      issued.inputAmount !== presented.inputAmount ||
      issued.minOutput !== presented.minOutput
    );
  }

  private depositor(): string | null {
    const session = this.deps.getSession();
    return session.status === "connected" ? session.address : null;
  }

  /** The SDK client — created lazily (module loads stay network-free) and
   *  kept as the singleton the SDK itself enforces. */
  private async sdk() {
    if (this.client === null) {
      const { createAcrossClient } = await import("@across-protocol/app-sdk");
      const { mainnet, base, arbitrum } = await import("viem/chains");
      this.client = createAcrossClient({
        integratorId: INTEGRATOR_ID,
        chains: [mainnet, base, arbitrum, getActiveChain()],
        pollingInterval: 3_000,
      });
    }
    return this.client;
  }
}

/** SDK progress → bridge phases. Null = not a product-visible event. */
function mapProgress(p: SwapExecutionProgress, depositSubmitted: boolean): BridgeProgress | null {
  switch (p.step) {
    case "approve":
      if (p.status === "txError" || p.status === "error" || p.status === "simulationError") {
        return { phase: "failed", message: "", txHash: null, error: voice(p.error, false) };
      }
      if (p.status === "txPending") {
        return { phase: "approving", message: "Approving the bridge to pull the origin token.", txHash: p.txHash as Hash, error: null };
      }
      if (p.status === "txSuccess") {
        return { phase: "approving", message: "Approval confirmed.", txHash: null, error: null };
      }
      return null;
    case "swap":
      if (p.status === "txError" || p.status === "error" || p.status === "simulationError") {
        return { phase: "failed", message: "", txHash: null, error: voice(p.error, depositSubmitted) };
      }
      if (p.status === "txPending") {
        return { phase: "bridging", message: "Depositing into the bridge on the origin chain.", txHash: p.txHash as Hash, error: null };
      }
      if (p.status === "txSuccess") {
        return { phase: "bridging", message: "Deposit confirmed — waiting for the fill on the destination chain.", txHash: null, error: null };
      }
      return null;
    case "fill":
      if (p.status === "txError" || p.status === "error" || p.status === "simulationError") {
        // A fill error after a confirmed deposit is NOT a loss — the intent
        // still lands; say so instead of inviting a double-bridge.
        return {
          phase: "failed",
          message: "",
          txHash: null,
          error: "The fill watch failed after the deposit landed — the transfer still completes. Check the origin transaction before doing anything.",
        };
      }
      if (p.status === "txPending") {
        return { phase: "bridging", message: "Waiting for the fill on the destination chain.", txHash: null, error: null };
      }
      return {
        phase: "filled",
        message: "Funds landed in the wallet on the destination chain, paid out as the chain's reserve asset.",
        txHash: null,
        error: null,
      };
  }
}

/** Product voice for an SDK failure. Whether a deposit was already
 *  submitted changes everything — allowance/approval failures move no
 *  funds; post-deposit failures leave a live intent on-chain. */
function voice(err: Error, depositSubmitted: boolean): string {
  if (depositSubmitted) {
    return "The bridge stopped after the deposit — that deposit is on-chain and still fills. Do not re-bridge; check the origin transaction first.";
  }
  return `The bridge didn't start — no funds moved. ${err.message}`.trim();
}

/** The destination token is always the deployment record's reserve asset —
 *  the same address the mint desk mints from. */
export function destinationToken(): Address {
  return getContracts().addresses.underlying as Address;
}
