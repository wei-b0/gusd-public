import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeIndexerClient, getIndexerClient } from "./indexer-client";

/**
 * The client must be provably inert without NEXT_PUBLIC_INDEXER_URL: zero
 * network calls, null results. With the URL set it speaks the wire contract
 * and every failure resolves to null — indexing lag is not an error state.
 */

const ANVIL_CHAIN = 31337;

function fetchMock(impl: () => Promise<unknown>) {
  const fn = vi.fn(impl as unknown as typeof fetch);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("indexer-client", () => {
  beforeEach(() => {
    disposeIndexerClient();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    disposeIndexerClient();
  });

  it("is inert without the env: null results, zero network calls", async () => {
    const fetchSpy = fetchMock(vi.fn());
    const client = getIndexerClient();

    expect(client.isIndexed(ANVIL_CHAIN)).toBe(false);
    await expect(client.getUserEvents("0xAaAa00110000000000000000000000000000AaAa")).resolves.toBe(
      null,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with the env: indexed for the active chain only", () => {
    vi.stubEnv("NEXT_PUBLIC_INDEXER_URL", "https://indexer.test");
    const client = getIndexerClient();

    expect(client.isIndexed(ANVIL_CHAIN)).toBe(true);
    expect(client.isIndexed(1)).toBe(false);
  });

  it("fetches user events and parses the response", async () => {
    vi.stubEnv("NEXT_PUBLIC_INDEXER_URL", "https://indexer.test");
    const events = [
      {
        contract: "0x0000000000000000000000000000000000000b01",
        event: "Buy",
        user: "0xaaaa00110000000000000000000000000000aaaa",
        chainId: ANVIL_CHAIN,
        blockNumber: 42,
        logIndex: 0,
        txHash: "0xh1",
        seenAtMs: 1000,
        data: { gpuOut: "1000000000000000000" },
      },
    ];
    const fetchSpy = fetchMock(
      () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ events }),
        }) as unknown as Promise<Response>,
    );
    const client = getIndexerClient();

    const result = await client.getUserEvents("0xAaAa00110000000000000000000000000000AaAa", {
      fromBlock: 40,
      events: ["Buy", "Minted"],
    });

    expect(result).toEqual(events);
    const url = String(fetchSpy.mock.calls[0]![0]);
    const parsed = new URL(url);
    expect(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).toBe(
      "https://indexer.test/user-events",
    );
    expect(parsed.searchParams.get("address")).toBe("0xaaaa00110000000000000000000000000000aaaa");
    expect(parsed.searchParams.get("fromBlock")).toBe("40");
    expect(parsed.searchParams.get("events")).toBe("Buy,Minted");
  });

  it("resolves null on a non-ok response", async () => {
    vi.stubEnv("NEXT_PUBLIC_INDEXER_URL", "https://indexer.test");
    fetchMock(() => Promise.resolve({ ok: false }) as unknown as Promise<Response>);
    const client = getIndexerClient();

    await expect(client.getUserEvents("0xAaAa00110000000000000000000000000000AaAa")).resolves.toBe(
      null,
    );
  });

  it("resolves null when the fetch itself fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_INDEXER_URL", "https://indexer.test");
    fetchMock(() => Promise.reject(new Error("unreachable")));
    const client = getIndexerClient();

    await expect(client.getUserEvents("0xAaAa00110000000000000000000000000000AaAa")).resolves.toBe(
      null,
    );
  });

  it("resolves null on a malformed body", async () => {
    vi.stubEnv("NEXT_PUBLIC_INDEXER_URL", "https://indexer.test");
    fetchMock(
      () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ nope: true }),
        }) as unknown as Promise<Response>,
    );
    const client = getIndexerClient();

    await expect(client.getUserEvents("0xAaAa00110000000000000000000000000000AaAa")).resolves.toBe(
      null,
    );
  });
});
