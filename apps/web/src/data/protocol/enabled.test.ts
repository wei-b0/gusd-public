/**
 * The feature gates are the mock-mode firewall: with
 * NEXT_PUBLIC_DATA_SOURCE=mock the protocol layer must be entirely off —
 * no store, no poll loop, no fetch. Tested at the module boundary (env is
 * a config-time const, so each mode is a fresh import).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = process.env;

async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL, ...env };
  return await Promise.all([
    import("./enabled"),
    import("./client"),
    import("@/data/oracle/config"),
  ]);
}

afterEach(() => {
  process.env = ORIGINAL;
  vi.resetModules();
});

describe("protocol gates", () => {
  it("opens both gates when the indexer URL is set and the data source is oracle", async () => {
    const [{ protocolEnabled, protocolMarketEnabled }] = await loadWith({
      NEXT_PUBLIC_DATA_SOURCE: "oracle",
      NEXT_PUBLIC_INDEXER_URL: "http://127.0.0.1:8080/v1/protocol/",
    });
    expect(protocolEnabled()).toBe(true);
    expect(protocolMarketEnabled()).toBe(true);
  });

  it("shuts the market gate in mock mode even with the URL configured — zero protocol-market network", async () => {
    const [{ protocolEnabled, protocolMarketEnabled }] = await loadWith({
      NEXT_PUBLIC_DATA_SOURCE: "mock",
      NEXT_PUBLIC_INDEXER_URL: "http://127.0.0.1:8080/v1/protocol",
    });
    // The URL stays available to wallet-history/transparency surfaces (mock
    // auth may still index); the MARKET layer is what mock mode forbids.
    expect(protocolEnabled()).toBe(true);
    expect(protocolMarketEnabled()).toBe(false);
  });

  it("keeps both gates shut without an indexer URL", async () => {
    const [{ protocolEnabled, protocolMarketEnabled }] = await loadWith({
      NEXT_PUBLIC_DATA_SOURCE: "oracle",
      NEXT_PUBLIC_INDEXER_URL: undefined,
    });
    expect(protocolEnabled()).toBe(false);
    expect(protocolMarketEnabled()).toBe(false);
    // The client stays constructible but every URL is null — inert by shape.
    const { protocolBaseUrl } = await import("./client");
    expect(protocolBaseUrl()).toBeNull();
  });
});
