import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { BridgeProgress, BridgeQuote } from "@/domain/bridge";
import type { WalletSession } from "@/domain/types";
import { AcrossBridgePort } from "./across";

/** The SDK surface the adapter touches — mocked so CI stays network-free. */
const h = vi.hoisted(() => ({
  swapQuote: vi.fn(),
  executeSwapQuote: vi.fn(),
  clientChains: [] as unknown[],
}));

vi.mock("@across-protocol/app-sdk", () => ({
  createAcrossClient: (opts: { chains: unknown[] }) => {
    h.clientChains = opts.chains;
    return { getSwapQuote: h.swapQuote, executeSwapQuote: h.executeSwapQuote };
  },
}));

// The adapter's deep type import is compile-time only — nothing to mock.

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
// Paxos-native USDG on Ethereum (docs.paxos.com/guides/stablecoin/usdg/mainnet)
// — routable on Across; the Arbitrum One deployment is NOT (not listed in
// the router's /swap/tokens universe), so it stays out of the origin table.
const USDG_MAINNET = "0xe343167631d89B6Ffc58B88d6b7fB0228795491D";
const OWNER = "0x00000000000000000000000000000000000c0a1e" as Address;

/** Raw SwapApprovalApiResponse shape — decimal strings, 6-decimal stable. */
function rawQuote(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "srv-1",
    inputAmount: "1000000000", // 1000
    expectedOutputAmount: "998000000", // 998
    minOutputAmount: "995000000", // 995 — the execution floor
    expectedFillTime: 120,
    ...over,
  };
}

function session(status: WalletSession["status"]): WalletSession {
  return {
    status,
    did: status === "connected" ? "did:privy:test" : null,
    address: status === "connected" ? OWNER : null,
    walletKind: null,
    walletLabel: null,
    chainId: null,
    networkOk: null,
    syncState: "idle",
    closedReason: null,
  } as unknown as WalletSession;
}

interface Deps {
  getSession: ReturnType<typeof vi.fn>;
  getWalletClient: ReturnType<typeof vi.fn>;
  switchChain: ReturnType<typeof vi.fn>;
}

function makePort(sess: WalletSession = session("connected")) {
  const calls: string[] = [];
  let current = sess;
  const deps: Deps = {
    getSession: vi.fn(() => current),
    getWalletClient: vi.fn(async () => {
      calls.push("wallet");
      return {} as never; // cast through — the SDK's ConfiguredWalletClient seam
    }),
    switchChain: vi.fn(async (chainId: number) => {
      calls.push(`switch:${chainId}`);
    }),
  };
  return { port: new AcrossBridgePort(deps), deps, calls, setSession: (s: WalletSession) => (current = s) };
}

/** Drive execute() to exhaustion, collecting yields. */
async function drain(port: AcrossBridgePort, quote: BridgeQuote): Promise<BridgeProgress[]> {
  const out: BridgeProgress[] = [];
  for await (const p of port.execute(quote)) out.push(p);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.clientChains = [];
});

describe("origins — hand-vetted canonical issuers", () => {
  it("serves Ethereum, Base, and Arbitrum with canonical stable addresses, USDG first where native and routable", () => {
    const { port } = makePort();
    const origins = port.origins();
    expect(origins.map((o) => o.chainId)).toEqual([1, 8453, 42161]);
    // Ethereum: native USDG leads (it moves across directly), then USDC/USDT.
    expect(origins[0]!.tokens.map((t) => t.address.toLowerCase())).toEqual([
      USDG_MAINNET.toLowerCase(),
      USDC_MAINNET.toLowerCase(),
      USDT_MAINNET.toLowerCase(),
    ]);
    // Base carries USDC only — no native USDG there, no invented USDT.
    expect(origins[1]!.tokens).toHaveLength(1);
    expect(origins[1]!.tokens[0]!.address.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    // Arbitrum One: USDC/USDT only — native Paxos USDG exists there but
    // Across does not serve it, and an unroutable origin dead-ends to amber.
    expect(origins[2]!.tokens.map((t) => t.address.toLowerCase())).toEqual([
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    ]);
  });
});

describe("getQuote — fail-closed to null", () => {
  it("refuses origins the adapter never whitelisted without calling the SDK", async () => {
    const { port } = makePort();
    expect(await port.getQuote(10, USDC_MAINNET as Address, 1000)).toBeNull();
    expect(h.swapQuote).not.toHaveBeenCalled();
  });

  it("refuses tokens outside the origin's canonical list", async () => {
    const { port } = makePort();
    const scam = "0x00000000000000000000000000000000000dea11" as Address;
    expect(await port.getQuote(1, scam, 1000)).toBeNull();
    expect(h.swapQuote).not.toHaveBeenCalled();
  });

  it("refuses to quote without a wallet — the depositor is the destination", async () => {
    const { port } = makePort(session("idle"));
    expect(await port.getQuote(1, USDC_MAINNET as Address, 1000)).toBeNull();
    expect(h.swapQuote).not.toHaveBeenCalled();
  });

  it("refuses non-positive or non-finite amounts", async () => {
    const { port } = makePort();
    expect(await port.getQuote(1, USDC_MAINNET as Address, 0)).toBeNull();
    expect(await port.getQuote(1, USDC_MAINNET as Address, -5)).toBeNull();
    expect(await port.getQuote(1, USDC_MAINNET as Address, Number.NaN)).toBeNull();
  });

  it("maps the raw response into a product quote — floor included", async () => {
    h.swapQuote.mockResolvedValue(rawQuote());
    const { port } = makePort();
    const q = await port.getQuote(1, USDC_MAINNET as Address, 1000);
    expect(q).toEqual({
      id: "srv-1",
      originChainId: 1,
      inputToken: USDC_MAINNET,
      inputAmount: 1000,
      expectedOutput: 998,
      minOutput: 995,
      originFee: 2,
      etaSeconds: 120,
    });
    // The SDK call pinned the deployment record's underlying as output.
    const call = h.swapQuote.mock.calls[0]![0]!;
    expect(call.route.originChainId).toBe(1);
    expect(call.route.inputToken).toBe(USDC_MAINNET);
    expect(call.route.destinationChainId).toBe(31337);
    expect(call.route.outputToken).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(call.depositor).toBe(OWNER);
    expect(call.amount).toBe(1_000_000_000n);
    expect(call.slippage).toBe(0.002);
  });

  it("quotes a native-USDG origin — the reserve moves across directly", async () => {
    h.swapQuote.mockResolvedValue(rawQuote());
    const { port } = makePort();
    const q = await port.getQuote(1, USDG_MAINNET as Address, 1000);
    expect(q).not.toBeNull();
    expect(q!.inputToken).toBe(USDG_MAINNET);
    const call = h.swapQuote.mock.calls[0]![0]!;
    expect(call.route.inputToken).toBe(USDG_MAINNET);
    // The output is still pinned to the deployment record's underlying.
    expect(call.route.outputToken).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(call.route.destinationChainId).toBe(31337);
  });

  it("coalesces a quote id when the API omits one", async () => {
    h.swapQuote.mockResolvedValue(rawQuote({ id: undefined }));
    const { port } = makePort();
    const q = await port.getQuote(1, USDC_MAINNET as Address, 1000);
    expect(q?.id).toBe(`1:${USDC_MAINNET}:998000000`);
  });

  it("returns null — never throws — when the bridge API fails", async () => {
    h.swapQuote.mockRejectedValue(new Error("api down"));
    const { port } = makePort();
    expect(await port.getQuote(1, USDC_MAINNET as Address, 1000)).toBeNull();
  });
});

describe("execute — the progress stream", () => {
  const raw = rawQuote();

  async function issueQuote(port: AcrossBridgePort): Promise<BridgeQuote> {
    h.swapQuote.mockResolvedValue(raw);
    const q = await port.getQuote(1, USDC_MAINNET as Address, 1000);
    expect(q).not.toBeNull();
    return q!;
  }

  it("refuses a stale quote before anything signs", async () => {
    const { port, deps } = makePort();
    const q = await issueQuote(port);
    const stale = { ...q, minOutput: 1 };
    const yields = await drain(port, stale);
    expect(yields).toHaveLength(1);
    expect(yields[0]!.phase).toBe("failed");
    expect(yields[0]!.error).toContain("expired");
    expect(yields[0]!.error).toContain("nothing moved");
    expect(deps.switchChain).not.toHaveBeenCalled();
    expect(h.executeSwapQuote).not.toHaveBeenCalled();
  });

  it("refuses to sign without a connected wallet", async () => {
    const { port, deps, setSession } = makePort();
    const q = await issueQuote(port);
    setSession(session("idle")); // the wallet dropped between quote and run
    const yields = await drain(port, q);
    expect(yields).toHaveLength(1);
    expect(yields[0]!.phase).toBe("failed");
    expect(yields[0]!.error).toContain("Connect a wallet");
    expect(deps.switchChain).not.toHaveBeenCalled();
  });

  it("switches the wallet to the origin before building transactions", async () => {
    const yields: BridgeProgress[] = [];
    h.executeSwapQuote.mockImplementation((opts: { onProgress?: (p: unknown) => void }) => {
      return Promise.resolve({ error: null });
    });
    const { port, calls } = makePort();
    const q = await issueQuote(port);
    for await (const p of port.execute(q)) yields.push(p);
    expect(calls[0]).toBe("switch:1");
    expect(calls[1]).toBe("wallet");
    expect(yields[yields.length - 1]!.phase).toBe("mint-ready");
  });

  it("streams approve → bridge → fill phases in order, then hands off", async () => {
    h.executeSwapQuote.mockImplementation((opts: { onProgress?: (p: unknown) => void }) => {
      opts.onProgress?.({ step: "approve", status: "txPending", txHash: "0xapprove" });
      opts.onProgress?.({ step: "approve", status: "txSuccess" });
      opts.onProgress?.({ step: "swap", status: "txPending", txHash: "0xdeposit" });
      opts.onProgress?.({ step: "swap", status: "txSuccess" });
      opts.onProgress?.({ step: "fill", status: "txPending" });
      opts.onProgress?.({ step: "fill", status: "txSuccess" });
      return Promise.resolve({ error: null });
    });
    const { port } = makePort();
    const q = await issueQuote(port);
    const yields = await drain(port, q);
    expect(yields.map((p) => p.phase)).toEqual([
      "approving",
      "approving",
      "bridging",
      "bridging",
      "bridging",
      "filled",
      "mint-ready",
    ]);
    expect(yields[0]!.txHash).toBe("0xapprove");
    expect(yields[2]!.txHash).toBe("0xdeposit");
    // The mint hand-off carries no hash — the mint desk reads the wallet.
    expect(yields[yields.length - 1]!.txHash).toBeNull();
  });

  it("tells the truth after a post-deposit watch failure: do not re-bridge", async () => {
    h.executeSwapQuote.mockImplementation((opts: { onProgress?: (p: unknown) => void }) => {
      opts.onProgress?.({ step: "swap", status: "txSuccess" });
      opts.onProgress?.({ step: "fill", status: "error", error: new Error("poll blew up") });
      return Promise.resolve({ error: null });
    });
    const { port } = makePort();
    const q = await issueQuote(port);
    const yields = await drain(port, q);
    const failed = yields.find((p) => p.phase === "failed");
    expect(failed?.error).toContain("the transfer still completes");
    expect(failed?.error).toContain("Check the origin transaction");
  });

  it("gives the post-deposit voice when the run itself fails after the deposit", async () => {
    h.executeSwapQuote.mockImplementation((opts: { onProgress?: (p: unknown) => void }) => {
      opts.onProgress?.({ step: "swap", status: "txSuccess" });
      return Promise.resolve({ error: new Error("watcher died") });
    });
    const { port } = makePort();
    const q = await issueQuote(port);
    const yields = await drain(port, q);
    const failed = yields.find((p) => p.phase === "failed");
    expect(failed?.error).toContain("deposit is on-chain and still fills");
  });

  it("gives the no-funds-moved voice when it fails before the deposit", async () => {
    h.executeSwapQuote.mockImplementation((opts: { onProgress?: (p: unknown) => void }) => {
      opts.onProgress?.({ step: "approve", status: "error", error: new Error("user rejected") });
      return Promise.resolve({ error: new Error("user rejected") });
    });
    const { port } = makePort();
    const q = await issueQuote(port);
    const yields = await drain(port, q);
    const failed = yields.find((p) => p.phase === "failed");
    expect(failed?.error).toContain("The bridge didn't start — no funds moved.");
  });

  it("consumes the issued quote on a completed run — a replay cannot re-bridge", async () => {
    h.executeSwapQuote.mockImplementation(() => Promise.resolve({ error: null }));
    const { port } = makePort();
    const q = await issueQuote(port);
    const first = await drain(port, q);
    expect(first[first.length - 1]!.phase).toBe("mint-ready");
    const replay = await drain(port, q);
    expect(replay[0]!.phase).toBe("failed");
    expect(replay[0]!.error).toContain("expired");
  });
});
