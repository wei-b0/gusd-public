import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  depositSpec,
  formatShares,
  parseEarnAmount,
  planEarnApproval,
  quoteDeposit,
  quoteRedeem,
  redeemSpec,
} from "./actions";

// The vault math the mocks reproduce: an ERC-4626 preview over a share
// price of shareNum/shareDen gUSD per 1 sgUSD (both sides 6 decimals, no
// fees). Previews are execution-identical so the mock IS the answer.
const h = vi.hoisted(() => ({
  shareNum: 1_000_000n as bigint,
  shareDen: 1_000_000n as bigint,
  allowance: 0n as bigint,
}));

vi.mock("../contracts", () => {
  const sharesFor = (assets: bigint) => (assets * h.shareNum) / h.shareDen;
  const assetsFor = (shares: bigint) => (shares * h.shareDen) / h.shareNum;
  return {
    getContracts: () => ({
      addresses: {
        gusd: "0x00000000000000000000000000000000000a0001",
        sgusd: "0x00000000000000000000000000000000000a0002",
      },
      sgusd: {
        read: {
          previewDeposit: async ([assets]: [bigint]) => sharesFor(assets),
          previewRedeem: async ([shares]: [bigint]) => assetsFor(shares),
        },
      },
    }),
    erc20Client: () => ({
      read: { allowance: async () => h.allowance },
    }),
  };
});

const GUSD = "0x00000000000000000000000000000000000a0001" as const;
const SGUSD = "0x00000000000000000000000000000000000a0002" as const;
const OWNER = "0x00000000000000000000000000000000000000aa" as const;

beforeEach(() => {
  h.shareNum = 1_000_000n;
  h.shareDen = 1_000_000n;
  h.allowance = 0n;
});

afterEach(() => vi.restoreAllMocks());

describe("quoteDeposit / quoteRedeem", () => {
  it("quotes a stake and a redeem 1:1 at the seed share price", async () => {
    expect(await quoteDeposit(1_000_000_000n)).toBe(1_000_000_000n);
    expect(await quoteRedeem(1_000_000_000n)).toBe(1_000_000_000n);
  });

  it("prices both directions off the same share price", async () => {
    // Price 1.05 gUSD per sgUSD: 1000 gUSD in mints 952.380952 shares,
    // and 2 shares out pay 2.1 gUSD.
    h.shareNum = 1_000_000n;
    h.shareDen = 1_050_000n;
    expect(await quoteDeposit(1_000_000_000n)).toBe(952_380_952n);
    expect(await quoteRedeem(2_000_000n)).toBe(2_100_000n);
  });
});

describe("parseEarnAmount / formatShares", () => {
  it("parses desk amounts as 6-decimal gUSD", () => {
    expect(parseEarnAmount(1000.123456)).toBe(1_000_123_456n);
  });

  it("formats raw shares into product units", () => {
    expect(formatShares(952_380_952n)).toBe(952.380952);
  });
});

describe("depositSpec / redeemSpec", () => {
  const wallet = {
    account: OWNER,
    writeContract: vi.fn(async () => "0xdeadbeef"),
  };

  it("encodes deposit(assets, to) to the sgUSD vault", async () => {
    const spec = depositSpec(1_000_000_000n, OWNER);
    expect(spec.origin).toBe("earn");
    expect(spec.kind).toBe("earn-deposit");
    const { hash } = await spec.execute(wallet as never);
    expect(hash).toBe("0xdeadbeef");
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SGUSD,
        functionName: "deposit",
        args: [1_000_000_000n, OWNER],
        chain: null,
      }),
    );
  });

  it("encodes redeem(shares, receiver, owner) — approval-free", async () => {
    const spec = redeemSpec(500_000_000n, OWNER);
    expect(spec.origin).toBe("unearn");
    expect(spec.kind).toBe("earn-withdraw");
    await spec.execute(wallet as never);
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SGUSD,
        functionName: "redeem",
        args: [500_000_000n, OWNER, OWNER],
        chain: null,
      }),
    );
  });
});

describe("planEarnApproval", () => {
  it("plans an exact gUSD approval for the sgUSD vault when short", async () => {
    const need = await planEarnApproval(OWNER, 1_000_000_000n);
    expect(need).not.toBeNull();
    expect(need?.token).toBe(GUSD);
    expect(need?.spender).toBe(SGUSD);
    expect(need?.spenderKind).toBe("sgusd");
    expect(need?.amount).toBe(1_000_000_000n);
  });

  it("returns null when the allowance already covers the stake", async () => {
    h.allowance = 1_000_000_000n;
    expect(await planEarnApproval(OWNER, 1_000_000_000n)).toBeNull();
  });
});
