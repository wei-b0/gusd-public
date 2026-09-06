import { afterEach, describe, expect, it, vi } from "vitest";
import { approveCalldata, approveSpec, planApproval } from "./approvals";

vi.mock("./contracts", () => {
  return {
    getContracts: vi.fn(() => ({
      addresses: {
        router: "0x00000000000000000000000000000000000c0ffe",
        gusd: "0x00000000000000000000000000000000000a0001",
        sgusd: "0x00000000000000000000000000000000000a0002",
      },
    })),
    erc20Client: vi.fn((address: string) => ({
      read: {
        allowance: vi.fn(async () => (address === "0xallowance0" ? 0n : 5_000_000n)),
      },
    })),
  };
});

const TOKEN = "0xallowance0" as const;
const TOKEN_FUNDED = "0xallowance5" as const;
const OWNER = "0x00000000000000000000000000000000000000aa" as const;
const SPENDER = "0x00000000000000000000000000000000000c0ffe" as const;

afterEach(() => vi.restoreAllMocks());

describe("planApproval", () => {
  it("returns null when the allowance already covers the need", async () => {
    const need = await planApproval(TOKEN_FUNDED, "gUSD", SPENDER, "router", OWNER, 5_000_000n);
    expect(need).toBeNull();
  });

  it("returns a discrete need sized to the exact amount", async () => {
    const need = await planApproval(TOKEN, "gUSD", SPENDER, "router", OWNER, 4_999_999n);
    expect(need).not.toBeNull();
    expect(need?.amount).toBe(4_999_999n);
    expect(need?.spenderKind).toBe("router");
  });

  it("flags when the current allowance is short of the need", async () => {
    const need = await planApproval(TOKEN_FUNDED, "gUSD", SPENDER, "router", OWNER, 5_000_001n);
    expect(need?.amount).toBe(5_000_001n);
  });
});

describe("approveSpec", () => {
  it("encodes an exact-amount approve to the need's spender", async () => {
    const wallet = {
      account: "0x00000000000000000000000000000000000000aa",
      // viem's writeContract resolves to the hash string itself.
      writeContract: vi.fn(async () => "0xdeadbeef"),
    };
    const record = await approveSpec(
      { token: TOKEN, tokenLabel: "gUSD", spender: SPENDER, spenderKind: "router", amount: 1_000_000n },
      "trade",
    ).execute(wallet as never);
    expect(record.hash).toBe("0xdeadbeef");
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: "approve",
        args: [SPENDER, 1_000_000n],
        chain: null,
      }),
    );
  });
});

describe("approveCalldata", () => {
  it("encodes the approve selector", () => {
    const data = approveCalldata({
      token: TOKEN,
      tokenLabel: "gUSD",
      spender: SPENDER,
      spenderKind: "router",
      amount: 1n,
    });
    // approve(address,uint256) selector, spender and amount left-padded.
    const spenderHex = SPENDER.slice(2).padStart(64, "0");
    const amountHex = 1n.toString(16).padStart(64, "0");
    expect(data).toBe(`0x095ea7b3${spenderHex}${amountHex}`);
  });
});
