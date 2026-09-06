import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mintSpec,
  parseMintAmount,
  planMintApproval,
  quoteMint,
  quoteRedeem,
  quoteMintViaStable,
  quoteRedeemViaStable,
  redeemSpec,
  stablePoolKey,
  SWAP_TOLERANCE_BPS,
} from "./actions";

// The contract math the mocks reproduce: fee = ceil(amount * bps / 10000),
// previews are execution-identical so the mock IS the answer.
const h = vi.hoisted(() => ({
  mintFeeBps: 20,
  redeemFeeBps: 25,
  paused: false,
  allowance: 0n as bigint,
  /** The swap leg's quoted output; null = the pool cannot price the route. */
  swapOut: 999_000_000n as bigint | null,
}));

vi.mock("../reads", () => ({
  contractReads: () => ({
    gusdState: async () => ({
      mintFeeBps: h.mintFeeBps,
      redeemFeeBps: h.redeemFeeBps,
      paused: h.paused,
    }),
  }),
}));

vi.mock("../stables", () => ({
  stableMetaOf: (addr: string) =>
    addr.toLowerCase() === USDC.toLowerCase()
      ? { address: USDC, symbol: "USDC", name: "USD Coin" }
      : null,
}));

vi.mock("../trading/quotes", () => ({
  quoterReadFor: () => ({
    quoteExactInputSingle: async ([p]: [{ exactAmount: bigint }]) => {
      if (h.swapOut === null) throw new Error("no pool");
      // The mock ignores price impact; the desk's math is what's under test.
      return [h.swapOut > p.exactAmount ? p.exactAmount : h.swapOut, 0n];
    },
    quoteExactOutputSingle: async () => {
      throw new Error("not used here");
    },
  }),
}));

vi.mock("../contracts", () => {
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return {
    getContracts: () => ({
      addresses: {
        gusd: "0x00000000000000000000000000000000000a0001",
        underlying: "0x00000000000000000000000000000000000a0003",
        stableRouter: "0x00000000000000000000000000000000000a0004",
      },
      gusd: {
        read: {
          previewMint: async ([raw]: [bigint]) => raw - ceilDiv(raw * BigInt(h.mintFeeBps), 10000n),
          previewRedeem: async ([raw]: [bigint]) =>
            raw - ceilDiv(raw * BigInt(h.redeemFeeBps), 10000n),
        },
      },
    }),
    erc20Client: () => ({
      read: { allowance: async () => h.allowance },
    }),
  };
});

const GUSD = "0x00000000000000000000000000000000000a0001" as const;
const USDC = "0x00000000000000000000000000000000000a0003" as const;
const ROUTER = "0x00000000000000000000000000000000000a0004" as const;
const OWNER = "0x00000000000000000000000000000000000000aa" as const;

beforeEach(() => {
  h.mintFeeBps = 20;
  h.redeemFeeBps = 25;
  h.paused = false;
  h.allowance = 0n;
  h.swapOut = 999_000_000n;
});

afterEach(() => vi.restoreAllMocks());

describe("quoteMint / quoteRedeem", () => {
  it("quotes a mint from the contract preview: fee on the input, output net", async () => {
    // 1000 USDC at 20bps mint fee → 2 USDC fee, 998 gUSD out.
    const q = await quoteMint(1_000_000_000n);
    expect(q.outputRaw).toBe(998_000_000n);
    expect(q.feeRaw).toBe(2_000_000n);
    expect(q.feeBps).toBe(20);
    expect(q.paused).toBe(false);
  });

  it("quotes a redeem from the contract preview", async () => {
    // 1000 gUSD at 25bps redeem fee → 2.5 gUSD fee, 997.5 USDC out.
    const q = await quoteRedeem(1_000_000_000n);
    expect(q.outputRaw).toBe(997_500_000n);
    expect(q.feeRaw).toBe(2_500_000n);
    expect(q.feeBps).toBe(25);
  });

  it("carries the contract's pause state", async () => {
    h.paused = true;
    expect((await quoteMint(1_000_000n)).paused).toBe(true);
    expect((await quoteRedeem(1_000_000n)).paused).toBe(true);
  });

  it("keeps the fee floor honest on amounts that round up", async () => {
    // 0.000001 USDC at 20bps: ceil(1e0 * 20 / 10000) = 1 raw unit fee — the
    // whole input is fee, the preview says so, the quote must say so.
    const q = await quoteMint(1n);
    expect(q.outputRaw).toBe(0n);
    expect(q.feeRaw).toBe(1n);
  });
});

describe("quoteMintViaStable / quoteRedeemViaStable", () => {
  it("composes the swap quote with the mint preview and clips the floor", async () => {
    // 1000 USDC swaps to 999 USDC of underlying (mock), 50bps down-clip,
    // then the mint preview at 20bps.
    const q = await quoteMintViaStable(USDC, 1_000_000_000n);
    expect(q).not.toBeNull();
    expect(q!.underlyingInRaw).toBe(999_000_000n);
    expect(q!.minUnderlyingRaw).toBe(994_005_000n); // 999e6 * (1 - 0.005)
    expect(q!.gusdOutRaw).toBe(997_002_000n); // previewMint(999e6): 20bps ceil fee
    expect(q!.feeBps).toBe(20);
  });

  it("returns null when the pool cannot price the swap", async () => {
    h.swapOut = null;
    expect(await quoteMintViaStable(USDC, 1_000_000_000n)).toBeNull();
  });

  it("quotes the redeem path: preview first, then the reverse swap", async () => {
    // 1000 gUSD redeems 997.5 underlying (25bps), swaps to USDC 1:1 in the
    // mock (clamped to 999e6 cap → 997.5e6), 50bps floor on top.
    const q = await quoteRedeemViaStable(USDC, 1_000_000_000n);
    expect(q).not.toBeNull();
    expect(q!.underlyingOutRaw).toBe(997_500_000n);
    expect(q!.stableOutRaw).toBe(997_500_000n);
    expect(q!.minStableRaw).toBe(992_512_500n);
    expect(q!.feeBps).toBe(25);
  });
});

describe("parseMintAmount", () => {
  it("parses mint amounts as 6-decimal stable units", () => {
    expect(parseMintAmount("mint", 1000.123456)).toBe(1_000_123_456n);
  });

  it("parses redeem amounts as 6-decimal gUSD", () => {
    expect(parseMintAmount("redeem", 12.5)).toBe(12_500_000n);
  });
});

describe("mintSpec / redeemSpec", () => {
  const wallet = {
    account: OWNER,
    writeContract: vi.fn(async () => "0xdeadbeef"),
  };

  it("encodes the reserve-path mint to the GUSD contract", async () => {
    const spec = mintSpec({ asset: USDC, amountInRaw: 1_000_000_000n, minUnderlyingOutRaw: 1_000_000_000n, poolKey: null, to: OWNER });
    expect(spec.origin).toBe("mint");
    expect(spec.kind).toBe("mint");
    const { hash } = await spec.execute(wallet as never);
    expect(hash).toBe("0xdeadbeef");
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: GUSD,
        functionName: "mint",
        args: [1_000_000_000n, OWNER],
        chain: null,
      }),
    );
  });

  it("encodes the reserve-path redeem to the GUSD contract", async () => {
    const spec = redeemSpec({ asset: USDC, gusdInRaw: 500_000_000n, minStableOutRaw: 0n, poolKey: null, to: OWNER });
    expect(spec.origin).toBe("redeem");
    expect(spec.kind).toBe("redeem");
    await spec.execute(wallet as never);
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: GUSD,
        functionName: "redeem",
        args: [500_000_000n, OWNER],
        chain: null,
      }),
    );
  });

  it("encodes the swap-path mint to the StableRouter with its pool key", async () => {
    const other = "0x00000000000000000000000000000000000a0005" as const;
    const key = stablePoolKey(other, USDC);
    const spec = mintSpec({
      asset: other,
      amountInRaw: 1_000_000n,
      minUnderlyingOutRaw: 990_000n,
      poolKey: key,
      to: OWNER,
    });
    await spec.execute(wallet as never);
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ROUTER,
        functionName: "mint",
        args: [other, 1_000_000n, 990_000n, key, OWNER],
        chain: null,
      }),
    );
  });

  it("refuses a swap-path spec without its pool key", () => {
    const other = "0x00000000000000000000000000000000000a0005" as const;
    expect(() =>
      mintSpec({ asset: other, amountInRaw: 1n, minUnderlyingOutRaw: 1n, poolKey: null, to: OWNER }),
    ).toThrow(/funding pool/);
    expect(() =>
      redeemSpec({ asset: other, gusdInRaw: 1n, minStableOutRaw: 1n, poolKey: null, to: OWNER }),
    ).toThrow(/funding pool/);
  });
});

describe("planMintApproval", () => {
  it("plans an exact reserve-asset approval for the GUSD contract when short", async () => {
    const need = await planMintApproval(OWNER, USDC, 1_000_000_000n);
    expect(need).not.toBeNull();
    expect(need?.token).toBe(USDC);
    expect(need?.spender).toBe(GUSD);
    expect(need?.spenderKind).toBe("gusd");
    expect(need?.amount).toBe(1_000_000_000n);
  });

  it("plans a non-reserve stable's approval for the StableRouter", async () => {
    const other = "0x00000000000000000000000000000000000a0005" as const;
    const need = await planMintApproval(OWNER, other, 1_000_000n);
    expect(need?.spender).toBe(ROUTER);
    expect(need?.spenderKind).toBe("stableRouter");
  });

  it("returns null when the allowance already covers the mint", async () => {
    h.allowance = 1_000_000_000n;
    expect(await planMintApproval(OWNER, USDC, 1_000_000_000n)).toBeNull();
  });
});
