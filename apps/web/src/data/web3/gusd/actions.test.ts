import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mintSpec,
  parseMintAmount,
  planMintApproval,
  quoteMint,
  quoteRedeem,
  redeemSpec,
} from "./actions";

// The contract math the mocks reproduce: fee = ceil(amount * bps / 10000),
// previews are execution-identical so the mock IS the answer.
const h = vi.hoisted(() => ({
  mintFeeBps: 20,
  redeemFeeBps: 25,
  paused: false,
  allowance: 0n as bigint,
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

vi.mock("../contracts", () => {
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return {
    getContracts: () => ({
      addresses: {
        gusd: "0x00000000000000000000000000000000000a0001",
        usdc: "0x00000000000000000000000000000000000a0003",
      },
      gusd: {
        read: {
          previewMintUSDC: async ([raw]: [bigint]) =>
            raw - ceilDiv(raw * BigInt(h.mintFeeBps), 10000n),
          previewRedeemUSDC: async ([raw]: [bigint]) =>
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
const OWNER = "0x00000000000000000000000000000000000000aa" as const;

beforeEach(() => {
  h.mintFeeBps = 20;
  h.redeemFeeBps = 25;
  h.paused = false;
  h.allowance = 0n;
});

afterEach(() => vi.restoreAllMocks());

describe("quoteMint / quoteRedeem", () => {
  it("quotes a mint from the contract preview: fee on the input, output net", async () => {
    // 1000 USDC at 20bps mint fee → 2 USDC fee, 998 gUSD out.
    const q = await quoteMint(1_000_000_000n);
    expect(q.output).toBe(998);
    expect(q.fee).toBe(2);
    expect(q.feeBps).toBe(20);
    expect(q.paused).toBe(false);
  });

  it("quotes a redeem from the contract preview", async () => {
    // 1000 gUSD at 25bps redeem fee → 2.5 gUSD fee, 997.5 USDC out.
    const q = await quoteRedeem(1_000_000_000n);
    expect(q.output).toBe(997.5);
    expect(q.fee).toBe(2.5);
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
    expect(q.output).toBe(0);
    expect(q.fee).toBe(0.000001);
  });
});

describe("parseMintAmount", () => {
  it("parses mint amounts as 6-decimal USDC", () => {
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

  it("encodes mintUSDC to the GUSD contract", async () => {
    const spec = mintSpec(1_000_000_000n, OWNER);
    expect(spec.origin).toBe("mint");
    expect(spec.kind).toBe("mint");
    const { hash } = await spec.execute(wallet as never);
    expect(hash).toBe("0xdeadbeef");
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: GUSD,
        functionName: "mintUSDC",
        args: [1_000_000_000n, OWNER],
        chain: null,
      }),
    );
  });

  it("encodes redeemUSDC to the GUSD contract", async () => {
    const spec = redeemSpec(500_000_000n, OWNER);
    expect(spec.origin).toBe("redeem");
    expect(spec.kind).toBe("redeem");
    await spec.execute(wallet as never);
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: GUSD,
        functionName: "redeemUSDC",
        args: [500_000_000n, OWNER],
        chain: null,
      }),
    );
  });
});

describe("planMintApproval", () => {
  it("plans an exact USDC approval for the GUSD contract when short", async () => {
    const need = await planMintApproval(OWNER, 1_000_000_000n);
    expect(need).not.toBeNull();
    expect(need?.token).toBe(USDC);
    expect(need?.spender).toBe(GUSD);
    expect(need?.spenderKind).toBe("gusd");
    expect(need?.amount).toBe(1_000_000_000n);
  });

  it("returns null when the allowance already covers the mint", async () => {
    h.allowance = 1_000_000_000n;
    expect(await planMintApproval(OWNER, 1_000_000_000n)).toBeNull();
  });
});
