/**
 * Unit tests for the protocol mappers — pure functions over wire DTOs.
 * Doctrine is tested here too: the published oracle value never leaks into
 * a display figure, and the depth figure is a depth figure (never a price).
 */
import { describe, expect, it } from "vitest";
import type { IndexedEvent } from "@/domain/indexer";
import type {
  ExecutionDto,
  OracleStateDto,
  PoolDto,
  PoolStatsBucketDto,
  SgusdVaultDto,
  SwapTapeDto,
  WalletPositionDto,
} from "./dto";
import {
  basisFromPosition,
  eventRow,
  executionRow,
  gusdNumber,
  inRangeGusdDepth,
  mergeActivity,
  oraclePublicationRow,
  sgusdSupply,
  swapToMarketTrade,
  trades24h,
  vaultDeployedGusd,
  volume24hGusd,
} from "./map";

const H100_GPU_ID = "0x483130305f53584d5f3830474200000000000000000000000000000000000000";
const GUSDC = "0x00000000000000000000000000000000000000aa";
const GPUTOKEN = "0x00000000000000000000000000000000000000bb";
const POOL = `0x${"ab".repeat(32)}`;

function poolDto(overrides: Partial<PoolDto> = {}): PoolDto {
  return {
    chainId: 31337,
    poolId: POOL,
    gpuId: H100_GPU_ID,
    canonical: true,
    registeredBlockNumber: 1,
    registeredAtSec: 1,
    currency0: GUSDC,
    currency1: GPUTOKEN,
    fee: 3000,
    tickSpacing: 60,
    hooks: `0x${"11".repeat(20)}`,
    gusdIsCurrency0: true,
    sqrtPriceX96: "0",
    tick: 0,
    liquidity: "0",
    swapCount: 0,
    volumeGusd: "0",
    buyVolumeGusd: "0",
    sellVolumeGusd: "0",
    hookFeesGusd: "0",
    lpFeesGusdEst: "0",
    lastSwapAtSec: null,
    lastSwapBlockNumber: null,
    ammPriceGusd: null,
    ...overrides,
  };
}

function swapDto(overrides: Partial<SwapTapeDto> = {}): SwapTapeDto {
  return {
    chainId: 31337,
    blockNumber: 100,
    logIndex: 2,
    blockTimestampSec: 1_700_000_000,
    poolId: POOL,
    sender: "0x0000000000000000000000000000000000000abc",
    amount0: "0",
    amount1: "0",
    side: null,
    gusdAmount: null,
    sqrtPriceX96: "0",
    liquidity: "0",
    tick: 0,
    fee: 3000,
    ...overrides,
  };
}

describe("swapToMarketTrade", () => {
  // 2 GPU for 5.00 gUSD, gUSD as currency0 → gpu delta on amount1.
  const BUY_GUSDC0 = swapDto({
    side: "buy",
    gusdAmount: "5000000",
    amount0: "5000000",
    amount1: "-2000000000000000000",
  });

  it("maps a buy with gUSD as currency0 (gpu delta on amount1)", () => {
    const t = swapToMarketTrade(BUY_GUSDC0, poolDto({ gusdIsCurrency0: true }));
    expect(t).not.toBeNull();
    expect(t).toMatchObject({
      id: `${POOL}:100:2`,
      side: "buy",
      size: 2,
      notional: 5,
      price: 2.5,
      t: 1_700_000_000_000,
    });
  });

  it("maps with gUSD as currency1 (gpu delta on amount0)", () => {
    const t = swapToMarketTrade(BUY_GUSDC0, poolDto({ gusdIsCurrency0: false }));
    expect(t).toMatchObject({ side: "buy", notional: 5 });
    // same swap DTO but gpu delta now read from amount0 — feed a sell whose
    // gpu delta sits on amount0 to prove the branch:
    const sell = swapDto({
      side: "sell",
      gusdAmount: "2500000",
      amount0: "-1000000000000000000",
      amount1: "2500000",
    });
    const ts = swapToMarketTrade(sell, poolDto({ gusdIsCurrency0: false }));
    expect(ts).toMatchObject({ side: "sell", size: 1, price: 2.5 });
  });

  it("skips unknown side, unknown pool, and zero gpu delta", () => {
    expect(swapToMarketTrade(swapDto({ side: null }), poolDto())).toBeNull();
    expect(swapToMarketTrade(BUY_GUSDC0, undefined)).toBeNull();
    expect(swapToMarketTrade(swapDto({ amount1: "0" }), poolDto())).toBeNull();
  });
});

describe("inRangeGusdDepth", () => {
  // gUSD currency0: depth = (L · 2^96) / sqrtPriceX96. Pick sqrtPrice = 2^96
  // (price 1 gUSD-wei per GPU-wei is nonsense for real pools but keeps the
  // arithmetic legible): L = 1e12 → depth = 1e12 / 1e6 = 1_000_000 gUSD.
  it("computes the gUSD-side virtual reserve with gUSD as currency0", () => {
    const p = poolDto({ gusdIsCurrency0: true, liquidity: "1000000000000", sqrtPriceX96: (2n ** 96n).toString() });
    expect(inRangeGusdDepth(p)).toBeCloseTo(1_000_000, 6);
  });

  it("inverts the branch with gUSD as currency1: depth = (L · sqrtPriceX96) / 2^96", () => {
    const p = poolDto({
      gusdIsCurrency0: false,
      liquidity: "1000000000000000000000000", // 1e24
      sqrtPriceX96: (2n ** 96n).toString(),
    });
    // (1e24 · 2^96) / 2^96 = 1e24 → 1e18 gUSD. Absurdly large but exact.
    expect(inRangeGusdDepth(p)).toBeCloseTo(1e18, 0);
  });

  it("guards: unknown ordering, zero liquidity, missing fields", () => {
    expect(inRangeGusdDepth(poolDto({ gusdIsCurrency0: null }))).toBeNull();
    expect(inRangeGusdDepth(poolDto({ liquidity: "0", sqrtPriceX96: (2n ** 96n).toString() }))).toBeNull();
    expect(inRangeGusdDepth(poolDto({ liquidity: null, sqrtPriceX96: null }))).toBeNull();
  });
});

describe("24h bucket windows", () => {
  const NOW = 1_720_000_000;
  const buckets = (starts: number[], volumeEach = "1000000", swapsEach = 2): PoolStatsBucketDto[] =>
    starts.map((bucketStart) => ({
      bucketStart,
      volumeGusd: volumeEach,
      buyVolumeGusd: volumeEach,
      sellVolumeGusd: "0",
      buys: swapsEach,
      sells: 1,
      hookFeesGusd: "0",
      lpFeesGusdEst: "0",
      swaps: swapsEach + 1,
    }));

  it("sums only buckets within the 24h window (inclusive boundary)", () => {
    const bs = buckets([NOW - 86_399, NOW - 86_400, NOW - 86_401, NOW - 100_000, NOW]);
    // in-window: NOW−86_399, the boundary NOW−86_400, and NOW = 3 buckets.
    expect(volume24hGusd(bs, NOW)).toBe(3);
    // trades = Σ (buys + sells) = 3 × 3
    expect(trades24h(bs, NOW)).toBe(9);
  });

  it("sums zero over an empty window", () => {
    expect(volume24hGusd([], NOW)).toBe(0);
    expect(trades24h(buckets([NOW - 200_000]), NOW)).toBe(0);
  });
});

describe("cost basis mapping", () => {
  const pos = (overrides: Partial<WalletPositionDto> = {}): WalletPositionDto => ({
    chainId: 31337,
    gpuId: H100_GPU_ID,
    qtyGpu: "1000000000000000000",
    costGusd: "2500000",
    basisState: "complete",
    avgEntryGusd: "2500000",
    realizedPnlGusd: "100000",
    reason: null,
    acquisitions: 2,
    disposals: 1,
    firstActivityAtSec: 1,
    lastActivityAtSec: 2,
    ...overrides,
  });

  it("maps complete basis to product numbers", () => {
    expect(basisFromPosition(pos())).toEqual({ avgEntry: 2.5, realizedPnl: 0.1, basisReason: null });
  });

  it("keeps gated fields null with the reason verbatim", () => {
    const b = basisFromPosition(pos({ avgEntryGusd: null, realizedPnlGusd: null, reason: "transfers_missing" }));
    expect(b.avgEntry).toBeNull();
    expect(b.realizedPnl).toBeNull();
    expect(b.basisReason).toBe("transfers_missing");
  });
});

// --- activity rows -------------------------------------------------------------------

function execution(overrides: Partial<ExecutionDto> = {}): ExecutionDto {
  return {
    side: "buy",
    chainId: 31337,
    blockNumber: 200,
    logIndex: 1,
    txHash: `0x${"aa".repeat(32)}`,
    blockTimestampSec: 1_700_000_100,
    gpuId: H100_GPU_ID,
    wallet: "0x0000000000000000000000000000000000000abc",
    payer: null,
    gpuAmount: "1000000000000000000",
    gUsdAmount: "3000000",
    polFeeGusd: "0",
    issuanceFeeGusd: "10000",
    hookFeeGusd: "15000",
    ...overrides,
  };
}

function event(overrides: Partial<IndexedEvent> = {}): IndexedEvent {
  return {
    contract: GUSDC,
    event: "Minted",
    user: "0x0000000000000000000000000000000000000abc",
    chainId: 31337,
    blockNumber: 150,
    logIndex: 0,
    txHash: `0x${"bb".repeat(32)}`,
    seenAtMs: 1_700_000_050_000,
    data: { to: "0x0000000000000000000000000000000000000abc", underlyingIn: "5000000", gusdOut: "4990000", fee: "10000" },
    ...overrides,
  };
}

describe("activity rows", () => {
  it("executionRow maps legs into size/notional and resolves the asset", () => {
    const r = executionRow(execution());
    expect(r).toMatchObject({
      id: `x:31337:200:1`,
      verb: "Buy",
      asset: "H100",
      size: 1,
      notional: 3,
      source: "execution",
      blockNumber: 200,
      logIndex: 1,
    });
    expect(r.t).toBe(1_700_000_100_000);
  });

  it("eventRow extracts amounts by each event's real arg names", () => {
    expect(eventRow(event())).toMatchObject({ verb: "Mint", notional: 4.99, size: null });
    expect(
      eventRow(event({ event: "Redeemed", data: { gusdIn: "1000000", underlyingOut: "999000", fee: "1000" } })),
    ).toMatchObject({ verb: "Redeem", notional: 0.999 });
    expect(
      eventRow(event({ event: "Issued", data: { amount: "2500000000000000000", base: "2500000", fee: "10000" } })),
    ).toMatchObject({ verb: "Issue", size: 2.5, notional: null });
    expect(
      eventRow(event({ event: "Deposit", data: { sender: GUSDC, owner: GUSDC, assets: "7000000", shares: "7000000" } })),
    ).toMatchObject({ verb: "Stake", notional: 7 });
    expect(
      eventRow(event({ event: "Withdraw", data: { owner: GUSDC, receiver: GUSDC, assets: "7000000", shares: "7000000" } })),
    ).toMatchObject({ verb: "Unstake", notional: 7 });
    expect(
      eventRow(
        event({
          event: "Sell",
          data: { gpuId: H100_GPU_ID, recipient: GUSDC, gpuIn: "1000000000000000000", out: "2900000", hookFee: "15000" },
        }),
      ),
    ).toMatchObject({ verb: "Sell", size: 1, notional: 2.9 });
  });

  it("eventRow leaves unrecognized args null rather than printing a wrong number", () => {
    expect(eventRow(event({ event: "Minted", data: { to: GUSDC } })).notional).toBeNull();
    expect(eventRow(event({ event: "SomethingElse", data: {} })).verb).toBe("SomethingElse");
  });

  it("mergeActivity dedupes Buy/Sell events by tx hash, newest first, capped", () => {
    const exec = execution();
    const dupEvent = event({
      event: "Buy",
      txHash: exec.txHash,
      blockNumber: 200,
      logIndex: 2, // different log index, same tx — still deduped
      data: { gpuId: H100_GPU_ID, recipient: GUSDC, payer: GUSDC, gpuOut: "1", paid: "3" },
    });
    const mint = event({ blockNumber: 190, logIndex: 0 });
    const rows = mergeActivity([exec], [dupEvent, mint], 10);
    expect(rows).toHaveLength(2);
    // newest first: execution (block 200) before the mint (block 190)
    const [first, second] = rows;
    expect(first).toMatchObject({ source: "execution", verb: "Buy" });
    expect(second).toMatchObject({ verb: "Mint" });

    // cap honored
    expect(mergeActivity([], [mint, dupEvent], 1)).toHaveLength(1);
  });

  it("mergeActivity breaks time ties by block/log descending", () => {
    const a = event({ blockNumber: 100, logIndex: 5 });
    const b = event({ blockNumber: 100, logIndex: 2 });
    const c = event({ blockNumber: 101, logIndex: 0 });
    const rows = mergeActivity([], [a, b, c], 10);
    expect(rows.map((r) => `${r.blockNumber}:${r.logIndex}`)).toEqual(["101:0", "100:5", "100:2"]);
    expect(rows.length).toBe(3);
  });
});

describe("oraclePublicationRow — transparency only, never a price", () => {
  const state = (overrides: Partial<OracleStateDto> = {}): OracleStateDto => ({
    chainId: 31337,
    gpuId: H100_GPU_ID,
    price: "25000",
    previousPrice: "24000",
    updatedAtSec: 1_700_000_000,
    overriddenPrice: null,
    overriddenAtSec: null,
    lastPublishedBlockNumber: 300,
    priceScale: 10_000,
    ageSec: 5,
    staleness: "fresh",
    ...overrides,
  });

  it("exposes health fields and recomputes age at read time", () => {
    const r = oraclePublicationRow(state(), 1_700_000_030);
    expect(r).toEqual({
      staleness: "fresh",
      ageSec: 30,
      updatedAtSec: 1_700_000_000,
      lastPublishedBlockNumber: 300,
      overridden: false,
    });
  });

  it("flags overrides and unknown state", () => {
    expect(oraclePublicationRow(state({ overriddenPrice: "26000", overriddenAtSec: 1_699_999_000 }), 1).overridden).toBe(true);
    expect(oraclePublicationRow(null, 1).staleness).toBe("unknown");
  });

  it("leaves the age null on the pre-mount clock rather than guessing", () => {
    const r = oraclePublicationRow(state(), null);
    expect(r.ageSec).toBeNull();
    expect(r.updatedAtSec).toBe(1_700_000_000);
    expect(r.staleness).toBe("fresh");
    expect(oraclePublicationRow(state({ updatedAtSec: null }), 1).ageSec).toBeNull();
  });

  it("the row type carries no price field — the published value cannot render", () => {
    const r = oraclePublicationRow(state(), 1);
    expect(Object.keys(r).sort()).toEqual([
      "ageSec",
      "lastPublishedBlockNumber",
      "overridden",
      "staleness",
      "updatedAtSec",
    ]);
  });
});

describe("vault aggregates", () => {
  const vault = (overrides: Partial<SgusdVaultDto> = {}): SgusdVaultDto => ({
    chainId: 31337,
    seededGusd: "500000000", // 500 gUSD
    depositsGusd: "250000000", // 250 gUSD
    withdrawsGusd: "50000000", // 50 gUSD
    sharesMinted: "300000000", // 300 sGUSD raw6 (shares are 6-dec)
    sharesBurned: "50000000", // 50 sGUSD
    depositCount: 4,
    withdrawCount: 1,
    revenueGusd: "1000000", // 1 gUSD
    ...overrides,
  });

  it("deployed gUSD = seed + deposits − withdraws + revenue (6-dec)", () => {
    expect(vaultDeployedGusd(vault())).toBe(701);
  });

  it("sGUSD supply = minted − burned shares (6-dec)", () => {
    expect(sgusdSupply(vault())).toBe(250);
  });

  it("parses the live session aggregate at the 6-dec scale", () => {
    // 1,519,804 raw shares minted, none burned → 1.519804 sGUSD (the 1e18
    // scale printed 0 and the 29× rate hid behind it).
    expect(sgusdSupply(vault({ sharesMinted: "1519804", sharesBurned: "0" }))).toBe(1.519804);
  });

  it("malformed wire figures yield null, never a partial guess", () => {
    expect(vaultDeployedGusd(vault({ depositsGusd: "oops" }))).toBeNull();
    expect(vaultDeployedGusd(vault({ revenueGusd: undefined as unknown as string }))).toBeNull();
    expect(sgusdSupply(vault({ sharesMinted: "x" }))).toBeNull();
  });

  it("gusdNumber parses 6-dec strings and propagates null", () => {
    expect(gusdNumber("123456789")).toBe(123.456789);
    expect(gusdNumber("0")).toBe(0);
    expect(gusdNumber(null)).toBeNull();
    expect(gusdNumber("NaN")).toBeNull();
  });
});
