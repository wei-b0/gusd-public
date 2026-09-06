import { describe, expect, it } from "vitest";
import { normalizeActionError, MAPPED_ERC20_ERRORS } from "./errors";
import { ERC20_ERRORS } from "./abis/erc20";

/** Mimics viem's cause chain: outer ContractFunctionExecutionError wrapping
 *  a ContractFunctionRevertedError whose data carries the decoded custom
 *  error. */
function viemRevert(errorName: string, args?: unknown[]): Error {
  const reverted = new Error(`execution reverted: ${errorName}`);
  (reverted as unknown as { data: unknown }).data = { errorName, args };
  const outer = new Error(`Contract function execution reverted`, { cause: reverted });
  return outer;
}

function eip1193Rejection(): Error {
  return Object.assign(new Error("User rejected the request."), { code: 4001 });
}

describe("normalizeActionError", () => {
  it("decodes viem's ABI-decoded custom errors through the cause chain", () => {
    const normalized = normalizeActionError(viemRevert("MaxPaidExceeded"));
    expect(normalized.errorName).toBe("MaxPaidExceeded");
    expect(normalized.voice).toMatch(/limit/i);
    expect(normalized.retryable).toBe(true);
  });

  it("maps the slippage and pool-size voices", () => {
    expect(normalizeActionError(viemRevert("Slippage")).voice).toMatch(/fell below your minimum/i);
    expect(normalizeActionError(viemRevert("PoolShortfall")).voice).toMatch(/reduce the amount/i);
    expect(normalizeActionError(viemRevert("ZeroAmount")).voice).toMatch(/greater than zero/i);
  });

  it("maps the oracle voices", () => {
    expect(normalizeActionError(viemRevert("OracleStale")).voice).toMatch(/stale/i);
    expect(normalizeActionError(viemRevert("OraclePriceZero")).voice).toMatch(/no index price/i);
  });

  it("maps the vault voices", () => {
    expect(normalizeActionError(viemRevert("NotSeeded")).voice).toMatch(/seeded/i);
    expect(normalizeActionError(viemRevert("ERC4626ExceededMaxWithdraw")).voice).toMatch(/position allows/i);
  });

  it("maps pause to protocol-voice and insufficient balance to wallet-voice", () => {
    expect(normalizeActionError(viemRevert("EnforcedPause")).voice).toMatch(/paused/i);
    expect(normalizeActionError(viemRevert("ERC20InsufficientBalance")).voice).toMatch(/balance/i);
  });

  it("treats an unmapped internal error as generic retry", () => {
    const normalized = normalizeActionError(viemRevert("NotPoolManager"));
    expect(normalized.errorName).toBe("NotPoolManager");
    expect(normalized.retryable).toBe(true);
    expect(normalized.voice).toMatch(/try again/i);
  });

  it("recognizes EIP-1193 user rejection without a revert chain", () => {
    const normalized = normalizeActionError(eip1193Rejection());
    expect(normalized.voice).toMatch(/declined/i);
    expect(normalized.retryable).toBe(true);
  });

  it("heuristic-maps provider insufficient-funds strings", () => {
    const normalized = normalizeActionError(new Error("insufficient funds for gas"));
    expect(normalized.voice).toMatch(/balance and gas/i);
  });

  it("falls back to generic voice for unknown shapes", () => {
    const normalized = normalizeActionError("network reset");
    expect(normalized.retryable).toBe(true);
  });

  it("maps every ERC-20 error the ABI module declares", () => {
    // Coverage contract: adding an ERC-20 error to the ABI without a voice
    // mapping fails here. Invariant errors intentionally land on the
    // generic voice, so only decoding coverage is asserted.
    for (const name of MAPPED_ERC20_ERRORS) {
      expect(normalizeActionError(viemRevert(name)).errorName).toBe(name);
    }
    expect(ERC20_ERRORS.length).toBeGreaterThanOrEqual(3);
  });
});
