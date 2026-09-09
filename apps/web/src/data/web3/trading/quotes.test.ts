import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { TradeQuote } from "@/domain/types";
import { applyBps, parseGpuUnits } from "@/domain/units";
import { gpuIdForAsset } from "../gpu-id";
import { canonicalPoolKey } from "../pool";
import { describeAsset, quoteAsset, quoteBuy, quoteSell, disposeAvailabilityCache, type GpuQuoteResult, type QuoteDeps } from "./quotes";

/**
 * The quote math, not the chain: the GpuQuoter and the issuance contract are
 * fakes with exact bigint answers, and the assertions check the desk's
 * arithmetic — the pool/issuance leg split, the fee rows derived from the
 * QuoteResult, the tolerance caps, and the null paths that stand in for
 * "the market can't fill this size" (a reverted quote is exactly that).
 */

const GUSD = "0x00000000000000000000000000000000000a0001" as Address;
const GPU_TOKEN = "0x00000000000000000000000000000000000a0002" as Address;
const HOOK = "0x00000000000000000000000000000000000a0003" as Address;
/** gUSD sorts below the GPU token, so a buy is zeroForOne. */
const POOL_PARAMS = { fee: 3000, tickSpacing: 60 };

const h = vi.hoisted(() => ({
  reg: null as
    | null
    | {
        gpuId: `0x${string}`;
        token: Address;
        issuanceEnabled: boolean;
        poolRegistered: boolean;
        poolParams: { fee: number; tickSpacing: number };
        issuanceFeeBps: number;
      },
  /** Issuance quote for the last issueRaw, raw bigint [base, fee, total]. */
  issue: [0n, 0n, 0n] as [bigint, bigint, bigint],
  issueCalls: 0,
  /** The QuoteResult the fake GpuQuoter answers with; null = revert
   *  (the honest "can't fill this size" the desk maps to null). */
  buyResult: null as GpuQuoteResult | null,
  sellResult: null as GpuQuoteResult | null,
  buyArgs: null as { poolKey: unknown; sizeRaw: bigint } | null,
  sellArgs: null as { poolKey: unknown; sizeRaw: bigint } | null,
  hookFeeBps: 50,
  block: 7,
  registrationCalls: 0,
}));

/** The contract set the quote math reads from — same object the mocked
 *  getContracts hands out, so deps and module agree. */
const fakeContracts = {
  addresses: { gusd: GUSD, hook: HOOK },
  issuance: {
    read: {
      quoteIssue: async (_args: readonly [`0x${string}`, bigint]) => {
        h.issueCalls += 1;
        return h.issue;
      },
    },
  },
  hook: {
    read: { hookFeeBps: async () => BigInt(h.hookFeeBps) },
  },
  gpuQuoter: {
    read: {
      quoteBuyExactOut: async ([poolKey, sizeRaw]: [unknown, bigint]) => {
        h.buyArgs = { poolKey, sizeRaw };
        if (h.buyResult === null) throw new Error("InsufficientMarketCapacity");
        return h.buyResult;
      },
      quoteSell: async ([poolKey, sizeRaw]: [unknown, bigint]) => {
        h.sellArgs = { poolKey, sizeRaw };
        if (h.sellResult === null) throw new Error("InsufficientMarketCapacity");
        return h.sellResult;
      },
    },
  },
};

vi.mock("../contracts", () => ({
  getContracts: () => fakeContracts,
}));

vi.mock("../public-client", () => ({
  getPublicClient: () => ({ getBlockNumber: async () => BigInt(h.block) }),
}));

function makeDeps(): QuoteDeps {
  return {
    reads: {
      registration: async () => {
        h.registrationCalls += 1;
        return h.reg;
      },
      hookFeeBps: async () => h.hookFeeBps,
    },
    contracts: fakeContracts,
    getBlockNumber: async () => h.block,
    now: () => 1_000,
  } as unknown as QuoteDeps;
}

/** A full QuoteResult: `poolGpu` fills from the book/POL, `backstopGpu`
 *  from the in-swap issuance backstop, `gusdIn` the all-in total. */
function makeBuy(opts: {
  poolGpu?: bigint;
  backstopGpu?: bigint;
  poolGusd?: bigint;
  issueBase?: bigint;
  issueFee?: bigint;
  polFee?: bigint;
  hookFee?: bigint;
}): GpuQuoteResult {
  const poolGpu = opts.poolGpu ?? 0n;
  const backstopGpu = opts.backstopGpu ?? 0n;
  const issueBase = opts.issueBase ?? 0n;
  const issueFee = opts.issueFee ?? 0n;
  return {
    isBuy: true,
    exactIn: false,
    gusdIn: (opts.poolGusd ?? 0n) + issueBase + issueFee,
    gusdOut: 0n,
    gpuIn: 0n,
    gpuOut: poolGpu + backstopGpu,
    nativeGpu: poolGpu, // the desk merges native + POL into one pool leg
    polGpu: 0n,
    backstopGpu,
    polFeeGusd: opts.polFee ?? 0n,
    hookFeeGusd: opts.hookFee ?? 0n,
    issueBase,
    issueFee,
    endTick: 0,
  };
}

/** 1.25 gUSD per GPU issued: base = raw × 1.25, ceil 50bps fee, total. */
function setIssue(raw: bigint): void {
  const base = (raw * 1_250_000n) / 10n ** 18n;
  const fee = (base * 50n + 9_999n) / 10_000n; // ceil — mirrors the contract
  h.issue = [base, fee, base + fee];
}

beforeEach(() => {
  h.reg = {
    gpuId: gpuIdForAsset("H100"),
    token: GPU_TOKEN,
    issuanceEnabled: true,
    poolRegistered: true,
    poolParams: POOL_PARAMS,
    issuanceFeeBps: 50,
  };
  h.issue = [0n, 0n, 0n];
  h.issueCalls = 0;
  h.buyResult = null;
  h.sellResult = null;
  h.buyArgs = null;
  h.sellArgs = null;
  h.hookFeeBps = 50;
  h.block = 7;
  h.registrationCalls = 0;
  disposeAvailabilityCache();
});

describe("quoteBuy", () => {
  it("fills entirely from issuance when no pool exists yet", async () => {
    h.reg = { ...h.reg!, poolRegistered: false };
    setIssue(parseGpuUnits(2));
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    // 2.5 gUSD base + 50bps fee = 2.5125 total for the two units.
    expect(q.price).toBeCloseTo(1.25625, 12);
    expect(q.notional).toBeCloseTo(2.5125, 12);
    expect(q.legs).toEqual([
      { kind: "issuance", gpuUnits: 2, gUsd: 2.5125, fees: { issuance: 0.0125 } },
    ]);
    // The signed cap is the notional plus tolerance, rounded up.
    expect(q.maxPaid).toBeCloseTo(Number(applyBps(2_512_500n, 50, "up")) / 1e6, 12);
    expect(q.minOut).toBe(0);
    expect(q.toleranceBps).toBe(50);
    expect(q.quotedAtMs).toBe(1_000);
    expect(q.blockNumber).toBe(7);
  });

  it("maps a pool-covered buy to a single pool leg with its fee row", async () => {
    h.buyResult = makeBuy({ poolGpu: parseGpuUnits(2), poolGusd: 4_000_000n, polFee: 4_000n, hookFee: 20_000n });
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    expect(q.legs).toEqual([
      { kind: "pool", gpuUnits: 2, gUsd: 4, fees: { protocol: 0.024 } },
    ]);
    expect(q.notional).toBeCloseTo(4, 12);
    expect(q.price).toBeCloseTo(2, 12);
    expect(h.issueCalls).toBe(0);
  });

  it("splits the fill between the pool leg and the backstop leg", async () => {
    h.buyResult = makeBuy({
      poolGpu: parseGpuUnits(1.5),
      poolGusd: 3_000_000n,
      backstopGpu: parseGpuUnits(0.5),
      issueBase: 600_000n,
      issueFee: 28_125n,
      polFee: 3_000n,
      hookFee: 15_000n,
    });
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    // 3 gUSD pool leg + 0.628125 issuance leg = 3.628125 all-in.
    expect(q.legs).toEqual([
      { kind: "pool", gpuUnits: 1.5, gUsd: 3, fees: { protocol: 0.018 } },
      { kind: "issuance", gpuUnits: 0.5, gUsd: 0.628125, fees: { issuance: 0.028125 } },
    ]);
    expect(q.notional).toBeCloseTo(3.628125, 12);
    const expectedMax = Number(applyBps(3_628_125n, 50, "up")) / 1e6;
    expect(q.maxPaid).toBeCloseTo(expectedMax, 12);
  });

  it("maps a reverted quote to null — the honest can't-fill", async () => {
    h.buyResult = null; // quoter reverts (capacity exceeded)
    expect(await quoteBuy("H100", 2, 50, makeDeps())).toBeNull();
  });

  it("refuses a result that does not cover the size", async () => {
    // gpuOut short of the ask (partial answers are not quotes)
    h.buyResult = { ...makeBuy({ poolGpu: parseGpuUnits(1), poolGusd: 2_000_000n }), gpuOut: parseGpuUnits(1) };
    expect(await quoteBuy("H100", 2, 50, makeDeps())).toBeNull();
    // zero-cost fill is nonsense
    h.buyResult = { ...makeBuy({ poolGpu: parseGpuUnits(2) }), gusdIn: 0n };
    expect(await quoteBuy("H100", 2, 50, makeDeps())).toBeNull();
  });

  it("serves a pool-only buy regardless of the issuance switch", async () => {
    h.reg = { ...h.reg!, issuanceEnabled: false };
    h.buyResult = makeBuy({ poolGpu: parseGpuUnits(2), poolGusd: 4_000_000n });
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote?.legs.map((l) => l.kind)).toEqual(["pool"]);
  });

  it("returns null for an unregistered asset and invalid sizes", async () => {
    h.reg = null;
    expect(await quoteBuy("H100", 2, 50, makeDeps())).toBeNull();
    h.reg = { ...h.reg!, gpuId: gpuIdForAsset("H100"), token: GPU_TOKEN, issuanceEnabled: true, poolRegistered: true, poolParams: POOL_PARAMS, issuanceFeeBps: 50 };
    expect(await quoteBuy("H100", 0, 50, makeDeps())).toBeNull();
    expect(await quoteBuy("H100", -3, 50, makeDeps())).toBeNull();
    expect(await quoteBuy("H100", Number.NaN, 50, makeDeps())).toBeNull();
  });

  it("quotes the registered pool through the canonical pool key", async () => {
    h.buyResult = makeBuy({ poolGpu: parseGpuUnits(1), poolGusd: 2_000_000n });
    await quoteBuy("H100", 1, 50, makeDeps());
    expect(h.buyArgs).not.toBeNull();
    expect(h.buyArgs!.sizeRaw).toBe(parseGpuUnits(1));
    expect(h.buyArgs!.poolKey).toEqual(canonicalPoolKey(GUSD, GPU_TOKEN, POOL_PARAMS, HOOK));
  });
});

describe("quoteSell", () => {
  it("quotes the net payout and floors the minOut with tolerance", async () => {
    h.sellResult = {
      isBuy: false,
      exactIn: true,
      gusdIn: 0n,
      gusdOut: 3_800_000n,
      gpuIn: parseGpuUnits(2),
      gpuOut: 0n,
      nativeGpu: 0n,
      polGpu: 0n,
      backstopGpu: 0n,
      polFeeGusd: 3_800n,
      hookFeeGusd: 19_000n,
      issueBase: 0n,
      issueFee: 0n,
      endTick: 0,
    };
    const quote = await quoteSell("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    expect(q.side).toBe("sell");
    expect(q.notional).toBeCloseTo(3.8, 12);
    expect(q.price).toBeCloseTo(1.9, 12);
    // One pool leg; the fee row is display-only — the row that signs is
    // the net.
    expect(q.legs).toHaveLength(1);
    expect(q.legs[0]!.kind).toBe("pool");
    if (q.legs[0]!.kind !== "pool") return;
    expect(q.legs[0]!.fees.protocol).toBeCloseTo(0.0228, 12);
    // minOut = floor(3,800,000 × 9,950 / 10,000).
    expect(q.minOut).toBeCloseTo(Number(applyBps(3_800_000n, 50, "down")) / 1e6, 12);
    expect(q.maxPaid).toBe(0);
  });

  it("quotes the registered pool through the canonical pool key", async () => {
    h.sellResult = {
      isBuy: false,
      exactIn: true,
      gusdIn: 0n,
      gusdOut: 1_900_000n,
      gpuIn: parseGpuUnits(1),
      gpuOut: 0n,
      nativeGpu: 0n,
      polGpu: 0n,
      backstopGpu: 0n,
      polFeeGusd: 0n,
      hookFeeGusd: 0n,
      issueBase: 0n,
      issueFee: 0n,
      endTick: 0,
    };
    await quoteSell("H100", 1, 50, makeDeps());
    expect(h.sellArgs).not.toBeNull();
    expect(h.sellArgs!.sizeRaw).toBe(parseGpuUnits(1));
    expect(h.sellArgs!.poolKey).toEqual(canonicalPoolKey(GUSD, GPU_TOKEN, POOL_PARAMS, HOOK));
  });

  it("maps a reverted quote to null", async () => {
    h.sellResult = null; // no bid depth — the honest can't-fill
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
  });

  it("refuses a result that does not cover the size or pays nothing", async () => {
    h.sellResult = {
      isBuy: false,
      exactIn: true,
      gusdIn: 0n,
      gusdOut: 1_900_000n,
      gpuIn: parseGpuUnits(0.5), // short of the size
      gpuOut: 0n,
      nativeGpu: 0n,
      polGpu: 0n,
      backstopGpu: 0n,
      polFeeGusd: 0n,
      hookFeeGusd: 0n,
      issueBase: 0n,
      issueFee: 0n,
      endTick: 0,
    };
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
    h.sellResult = { ...h.sellResult, gpuIn: parseGpuUnits(1), gusdOut: 0n };
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
  });

  it("refuses sells without secondary depth or registration", async () => {
    h.reg = { ...h.reg!, poolRegistered: false };
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
    h.reg = null;
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
  });
});

describe("quoteAsset", () => {
  it("dispatches by side", async () => {
    h.buyResult = makeBuy({ poolGpu: parseGpuUnits(1), poolGusd: 2_000_000n });
    h.sellResult = {
      isBuy: false,
      exactIn: true,
      gusdIn: 0n,
      gusdOut: 1_900_000n,
      gpuIn: parseGpuUnits(1),
      gpuOut: 0n,
      nativeGpu: 0n,
      polGpu: 0n,
      backstopGpu: 0n,
      polFeeGusd: 0n,
      hookFeeGusd: 0n,
      issueBase: 0n,
      issueFee: 0n,
      endTick: 0,
    };
    const buy = await quoteAsset("H100", "buy", 1, 50, makeDeps());
    expect(buy?.side).toBe("buy");
    const sell = await quoteAsset("H100", "sell", 1, 50, makeDeps());
    expect(sell?.side).toBe("sell");
  });
});

describe("describeAsset", () => {
  it("reads registration and fees, and caches within its TTL", async () => {
    const deps = makeDeps();
    expect(await describeAsset("H100", deps)).toEqual({
      issuanceEnabled: true,
      poolRegistered: true,
      // the fake's raw v4 fee (3000 hundredths-of-a-bip) arrives as 30 bps
      poolFeeBps: 30,
      hookFeeBps: 50,
      issuanceFeeBps: 50,
    });
    expect(h.registrationCalls).toBe(1);
    await describeAsset("H100", deps);
    expect(h.registrationCalls).toBe(1);
  });

  it("returns null for an unregistered asset", async () => {
    h.reg = null;
    expect(await describeAsset("H100", makeDeps())).toBeNull();
  });

  it("re-reads after the cache is disposed", async () => {
    const deps = makeDeps();
    await describeAsset("H100", deps);
    disposeAvailabilityCache();
    await describeAsset("H100", deps);
    expect(h.registrationCalls).toBe(2);
  });
});
