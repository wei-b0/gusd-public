import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { TradeQuote } from "@/domain/types";
import { applyBps, parseGpuUnits } from "@/domain/units";
import { gpuIdForAsset } from "../gpu-id";
import { canonicalPoolKey } from "../pool";
import { describeAsset, quoteAsset, quoteBuy, quoteSell, disposeProbeCache, disposeAvailabilityCache, type QuoteDeps } from "./quotes";

/**
 * The quote math, not the chain: the quoter and the issuance contract are
 * fakes with exact bigint answers, and the assertions check the desk's
 * arithmetic — the pool/issuance split, the hook-fee split, the tolerance
 * caps, and the null paths that stand in for "no depth".
 */

const GUSD = "0x00000000000000000000000000000000000a0001" as Address;
const GPU_TOKEN = "0x00000000000000000000000000000000000a0002" as Address;
const HOOK = "0x00000000000000000000000000000000000a0003" as Address;
/** gUSD sorts below the GPU token, so a buy is zeroForOne. */
const POOL_PARAMS = { fee: 3000, tickSpacing: 60 };
const HOOK_FEE_BPS = 50;

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
  /** gUSD raw the fake pool charges per whole GPU unit. */
  poolPricePerUnit: 2_000_000n,
  /** The largest GPU raw the fake pool can fill; 0n = empty pool. */
  maxFill: 0n,
  hookFeeBps: 50,
  block: 7,
  buyProbe: null as { poolKey: unknown; zeroForOne: boolean; exactAmount: bigint } | null,
  sellProbe: null as { poolKey: unknown; zeroForOne: boolean; exactAmount: bigint } | null,
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
  quoter: {
    read: {
      // The fake pool: `poolPricePerUnit` gUSD per whole GPU; reverts past
      // `maxFill` exactly the way v4's quoter reverts past max liquidity.
      quoteExactOutputSingle: async ([args]: [never]) => {
        const a = args as unknown as { poolKey: unknown; zeroForOne: boolean; exactAmount: bigint };
        h.buyProbe = a;
        if (h.maxFill === 0n || a.exactAmount > h.maxFill) {
          throw new Error("exceeds max liquidity");
        }
        return [(a.exactAmount * h.poolPricePerUnit) / 10n ** 18n, 150_000n];
      },
      quoteExactInputSingle: async ([args]: [never]) => {
        const a = args as unknown as { poolKey: unknown; zeroForOne: boolean; exactAmount: bigint };
        h.sellProbe = a;
        if (h.maxFill === 0n || a.exactAmount > h.maxFill) {
          throw new Error("exceeds max liquidity");
        }
        // Sells quote the net out; 1.9 gUSD per GPU here.
        return [(a.exactAmount * 1_900_000n) / 10n ** 18n, 150_000n];
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
  h.poolPricePerUnit = 2_000_000n;
  h.maxFill = 0n;
  h.hookFeeBps = HOOK_FEE_BPS;
  h.block = 7;
  h.buyProbe = null;
  h.sellProbe = null;
  h.registrationCalls = 0;
  disposeProbeCache();
  disposeAvailabilityCache();
});

describe("quoteBuy", () => {
  it("fills entirely from issuance when the pool holds no depth", async () => {
    setIssue(parseGpuUnits(2));
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    expect(q.legs.map((l) => [l.kind, l.gpuUnits])).toEqual([[
      "issuance",
      2,
    ]]);
    // 2.5 gUSD base + 50bps fee = 2.5125 total for the two units.
    expect(q.price).toBeCloseTo(1.25625, 12);
    expect(q.notional).toBeCloseTo(2.5125, 12);
    // No pool leg → no protocol fee to split out; the issuance fee stands
    // alone, carried by its own leg.
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

  it("fills entirely from the pool when depth covers the size", async () => {
    h.maxFill = parseGpuUnits(10);
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    expect(q.legs.map((l) => [l.kind, l.gpuUnits])).toEqual([[
      "pool",
      2,
    ]]);
    expect(q.notional).toBeCloseTo(4, 12);
    // The quoter's amountIn is all-in: the hook's take is split out for
    // display, floor(4,000,000 × 10,000 / 10,050) = 3,980,099 net.
    expect(q.legs).toEqual([
      {
        kind: "pool",
        gpuUnits: 2,
        gUsd: 4,
        fees: { protocol: Number(4_000_000n - 3_980_099n) / 1e6 },
      },
    ]);
    expect(h.issueCalls).toBe(0);
  });

  it("splits the fill between the pool and issuance", async () => {
    h.maxFill = parseGpuUnits(1.5);
    setIssue(parseGpuUnits(0.5));
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    expect(q.legs.map((l) => [l.kind, l.gpuUnits])).toEqual([
      ["pool", 1.5],
      ["issuance", 0.5],
    ]);
    // 3 gUSD pool leg + 0.628125 issuance leg.
    expect(q.notional).toBeCloseTo(3.628125, 12);
    const expectedMax = Number(applyBps(3_000_000n + 628_125n, 50, "up")) / 1e6;
    expect(q.maxPaid).toBeCloseTo(expectedMax, 12);
  });

  it("refuses a size the pool can't fill when issuance is closed", async () => {
    h.reg = { ...h.reg!, issuanceEnabled: false };
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).toBeNull();
  });

  it("serves a pool-only buy even when issuance is closed", async () => {
    h.maxFill = parseGpuUnits(10);
    h.reg = { ...h.reg!, issuanceEnabled: false };
    const quote = await quoteBuy("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    expect(quote?.legs.map((l) => [l.kind, l.gpuUnits])).toEqual([["pool", 2]]);
  });

  it("returns null for an unregistered asset and invalid sizes", async () => {
    h.reg = null;
    expect(await quoteBuy("H100", 2, 50, makeDeps())).toBeNull();
    h.reg = {
      gpuId: gpuIdForAsset("H100"),
      token: GPU_TOKEN,
      issuanceEnabled: true,
      poolRegistered: true,
      poolParams: POOL_PARAMS,
      issuanceFeeBps: 50,
    };
    expect(await quoteBuy("H100", 0, 50, makeDeps())).toBeNull();
    expect(await quoteBuy("H100", -3, 50, makeDeps())).toBeNull();
    expect(await quoteBuy("H100", Number.NaN, 50, makeDeps())).toBeNull();
  });

  it("probes the pool in the buy direction through the canonical pool", async () => {
    h.maxFill = parseGpuUnits(10);
    await quoteBuy("H100", 1, 50, makeDeps());
    expect(h.buyProbe).not.toBeNull();
    expect(h.buyProbe!.zeroForOne).toBe(true);
    expect(h.buyProbe!.poolKey).toEqual(canonicalPoolKey(GUSD, GPU_TOKEN, POOL_PARAMS, HOOK));
  });
});

describe("quoteSell", () => {
  it("quotes the net payout and floors the minOut with tolerance", async () => {
    h.maxFill = parseGpuUnits(10);
    const quote = await quoteSell("H100", 2, 50, makeDeps());
    expect(quote).not.toBeNull();
    const q = quote as TradeQuote;
    expect(q.legs.map((l) => [l.kind, l.gpuUnits])).toEqual([[
      "pool",
      2,
    ]]);
    expect(q.notional).toBeCloseTo(3.8, 12);
    expect(q.price).toBeCloseTo(1.9, 12);
    // gross = floor(3,800,000 × 10,000 / 9,950) = 3,819,095; the split is
    // display-only — the row that signs is the net.
    expect(q.legs).toHaveLength(1);
    expect(q.legs[0]!.kind).toBe("pool");
    if (q.legs[0]!.kind !== "pool") return;
    expect(q.legs[0]!.fees.protocol).toBeCloseTo(Number(3_819_095n - 3_800_000n) / 1e6, 12);
    // minOut = floor(3,800,000 × 9,950 / 10,000).
    expect(q.minOut).toBeCloseTo(Number(applyBps(3_800_000n, 50, "down")) / 1e6, 12);
    expect(q.maxPaid).toBe(0);
  });

  it("sells in the opposite direction of a buy", async () => {
    h.maxFill = parseGpuUnits(10);
    await quoteSell("H100", 1, 50, makeDeps());
    expect(h.sellProbe!.zeroForOne).toBe(false);
  });

  it("refuses sells without secondary depth", async () => {
    h.reg = { ...h.reg!, poolRegistered: false };
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
    h.reg = { ...h.reg!, poolRegistered: true };
    h.maxFill = 0n; // registered but empty
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
  });

  it("refuses sells of unregistered assets", async () => {
    h.reg = null;
    expect(await quoteSell("H100", 1, 50, makeDeps())).toBeNull();
  });
});

describe("quoteAsset", () => {
  it("dispatches by side", async () => {
    h.maxFill = parseGpuUnits(10);
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
