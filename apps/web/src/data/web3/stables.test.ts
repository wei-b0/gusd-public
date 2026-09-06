import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { ProtocolAddresses } from "./abis/addresses.generated";
import { stableConfig, stableConfigFrom, stableLabel, stableMetaOf, stablesFor } from "./stables";

/** A fabricated deployment record — only underlying/stables matter here. */
function record(underlying: string, stables: string[]): ProtocolAddresses {
  return {
    chainId: 31337,
    gusd: "0x00000000000000000000000000000000000000a1" as Address,
    hook: "0x0000000000000000000000000000000000000001",
    issuance: "0x0000000000000000000000000000000000000002",
    ledger: "0x0000000000000000000000000000000000000003",
    oracle: "0x0000000000000000000000000000000000000004",
    permit2: "0x0000000000000000000000000000000000000005",
    poolManager: "0x0000000000000000000000000000000000000006",
    positionManager: "0x0000000000000000000000000000000000000007",
    quoter: "0x0000000000000000000000000000000000000008",
    router: "0x0000000000000000000000000000000000000009",
    sgusd: "0x000000000000000000000000000000000000000a",
    stateView: "0x000000000000000000000000000000000000000b",
    underlying: underlying as Address,
    stableRouter: "0x000000000000000000000000000000000000000c",
    stables: stables as Address[],
    weth: "0x000000000000000000000000000000000000000d",
  };
}

const USDC = "0x0000000000000000000000000000000000000aA0";
const USDT = "0x0000000000000000000000000000000000000aB1";

/** Underlying-only table — the shape of every real entry today. */
const MIN_TABLE = {
  31337: { underlying: { symbol: "USDC", name: "USD Coin" } },
  /** Robinhood Chain — Paxos USDG. */
  4663: { underlying: { symbol: "USDG", name: "Global Dollar" } },
};

/** Anvil entry plus display metadata for one extra stable. */
const TABLE = {
  31337: {
    underlying: { symbol: "USDC", name: "USD Coin" },
    others: { [USDT]: { symbol: "USDT", name: "Tether USD" } },
  },
};

/** Same, keyed lowercase — how hand-written config is expected to pin. */
const LOWER_TABLE = {
  31337: {
    underlying: { symbol: "USDC", name: "USD Coin" },
    others: { [USDT.toLowerCase()]: { symbol: "USDT", name: "Tether USD" } },
  },
};

describe("stableConfigFrom — the config↔deployment trust boundary", () => {
  it("builds the reserve-asset meta from the deployment record", () => {
    const cfg = stableConfigFrom(31337, record(USDC, [USDC]), MIN_TABLE);
    expect(cfg.underlying).toEqual({ address: USDC, symbol: "USDC", name: "USD Coin" });
    expect(cfg.others).toEqual([]);
  });

  it("lists whitelisted extras in record order, underlying excluded", () => {
    const cfg = stableConfigFrom(31337, record(USDC, [USDC, USDT]), TABLE);
    expect(cfg.others).toEqual([{ address: USDT, symbol: "USDT", name: "Tether USD" }]);
    expect(stablesFor).toBeDefined();
  });

  it("matches addresses case-insensitively (checksummed record, lower config)", () => {
    const cfg = stableConfigFrom(31337, record(USDC.toUpperCase(), [USDC.toUpperCase(), USDT.toLowerCase()]), LOWER_TABLE);
    expect(cfg.others).toHaveLength(1);
    expect(cfg.underlying.address).toBe(USDC.toUpperCase());
  });

  it("throws when the record's underlying is not whitelisted on the router", () => {
    // A redeploy that forgot the constructor whitelist — re-deploy, not guess.
    expect(() => stableConfigFrom(31337, record(USDC, [USDT]), MIN_TABLE)).toThrow(
      "not whitelisted on its StableRouter",
    );
  });

  it("throws when the router whitelists a stable this config cannot name", () => {
    expect(() => stableConfigFrom(31337, record(USDC, [USDC, USDT]), MIN_TABLE)).toThrow(
      "no display config in stables.ts",
    );
  });

  it("throws when the config names a stable the whitelist dropped", () => {
    expect(() => stableConfigFrom(31337, record(USDC, [USDC]), TABLE)).toThrow("stale config");
  });

  it("throws in product voice for a chain with no stable config at all", () => {
    expect(() => stableConfigFrom(999_999, record(USDC, [USDC]), MIN_TABLE)).toThrow(
      "No stable-asset config for chain 999999",
    );
  });
});

describe("stableConfig — the real wiring (deployment record + table)", () => {
  it("resolves Anvil's USDG reserve against the generated deployment", () => {
    const cfg = stableConfig(31337);
    // The dev mock wears the Robinhood Chain reserve's identity by Deploy
    // default, so the local preview matches the real posture.
    expect(cfg.underlying.symbol).toBe("USDG");
    expect(cfg.underlying.name).toBe("Global Dollar");
    expect(cfg.underlying.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(stablesFor(31337)[0]).toEqual(cfg.underlying);
  });
});

describe("identity seams — the labeling guard", () => {
  it("renders 'SYMBOL · Name' sentence-level identity", () => {
    expect(stableLabel({ address: USDC, symbol: "USDG", name: "Global Dollar" })).toBe("USDG · Global Dollar");
    expect(stableLabel({ address: USDC, symbol: "USDT", name: "Tether USD" })).toBe("USDT · Tether USD");
  });

  it("never blurs a funding stable with the product token gUSD", () => {
    for (const meta of stablesFor(31337)) {
      expect(stableLabel(meta)).not.toContain("gUSD");
      expect(meta.symbol.toLowerCase() === "gusd").toBe(false);
    }
  });

  it("resolves metadata only for whitelisted addresses — unknown stays null", () => {
    expect(stableMetaOf(USDT, 31337)).toBeNull();
    const cfg = stableConfig(31337);
    expect(stableMetaOf(cfg.underlying.address, 31337)).toEqual(cfg.underlying);
  });

  it("matches stableMetaOf case-insensitively", () => {
    const cfg = stableConfig(31337);
    const mixed = cfg.underlying.address.slice(0, 8) + cfg.underlying.address.slice(8).toLowerCase();
    expect(stableMetaOf(mixed, 31337)).toEqual(cfg.underlying);
  });
});
