/**
 * Unit tests for the /v1/protocol REST client — URL building, 404⇒null,
 * error surfaces, and the inert mode (no env ⇒ no calls, no client).
 * Network-free: fetch is stubbed with a responder fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetchCalls: [] as string[],
  responder: ((url: string) => {
    void url;
    throw new Error("no responder");
  }) as (url: string) => { status: number; body: unknown },
}));

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  h.fetchCalls.push(url);
  const { status, body } = h.responder(url);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}) as typeof fetch;

let mod: typeof import("./client");
let enabled: typeof import("./enabled");

beforeEach(async () => {
  h.fetchCalls = [];
  h.responder = () => {
    throw new Error("no responder");
  };
  vi.resetModules();
  process.env.NEXT_PUBLIC_INDEXER_URL = "http://127.0.0.1:8080/v1/protocol";
  mod = await import("./client");
  enabled = await import("./enabled");
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_INDEXER_URL;
  delete process.env.NEXT_PUBLIC_DATA_SOURCE;
  mod.disposeProtocolClient();
});

function json(status: number, body: unknown) {
  return { status, body };
}

describe("protocolBaseUrl", () => {
  it("trims and strips trailing slashes; empty/absent ⇒ null", async () => {
    expect(mod.protocolBaseUrl()).toBe("http://127.0.0.1:8080/v1/protocol");
    process.env.NEXT_PUBLIC_INDEXER_URL = "  http://x/y/  ";
    expect(mod.protocolBaseUrl()).toBe("http://x/y");
    process.env.NEXT_PUBLIC_INDEXER_URL = "";
    expect(mod.protocolBaseUrl()).toBeNull();
    delete process.env.NEXT_PUBLIC_INDEXER_URL;
    expect(mod.protocolBaseUrl()).toBeNull();
  });
});

describe("protocolMarketEnabled", () => {
  // DATA_SOURCE is a config-time const: re-import after each env change.
  async function reimport(): Promise<void> {
    vi.resetModules();
    enabled = await import("./enabled");
  }
  it("true only when configured AND data source is oracle", async () => {
    process.env.NEXT_PUBLIC_DATA_SOURCE = "oracle";
    await reimport();
    expect(enabled.protocolMarketEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_DATA_SOURCE = "mock";
    await reimport();
    expect(enabled.protocolMarketEnabled()).toBe(false);
    delete process.env.NEXT_PUBLIC_DATA_SOURCE;
    await reimport();
    expect(enabled.protocolMarketEnabled()).toBe(true);
    // the plain gate follows the env alone
    expect(enabled.protocolEnabled()).toBe(true);
  });
});

describe("getProtocolClient singleton", () => {
  it("is null without env, built with it, rebuilt after dispose", async () => {
    delete process.env.NEXT_PUBLIC_INDEXER_URL;
    expect(mod.getProtocolClient()).toBeNull();
    process.env.NEXT_PUBLIC_INDEXER_URL = "http://127.0.0.1:8080/v1/protocol";
    const a = mod.getProtocolClient();
    expect(a).not.toBeNull();
    expect(mod.getProtocolClient()).toBe(a);
    mod.disposeProtocolClient();
    expect(mod.getProtocolClient()).not.toBe(a);
  });
});

describe("request building", () => {
  it("getUserEvents encodes address, filters, and paging", async () => {
    h.responder = () => json(200, { events: [] });
    const c = mod.getProtocolClient();
    if (c === null) throw new Error("client missing");
    await c.getUserEvents("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", {
      events: ["Minted", "Buy"],
      limit: 50,
      cursor: "v1:100:2",
      fromBlock: 7,
    });
    expect(h.fetchCalls[0]).toBe(
      "http://127.0.0.1:8080/v1/protocol/user-events?address=0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc&fromBlock=7&events=Minted,Buy&limit=50&cursor=v1%3A100%3A2",
    );
  });

  it("wallet, pools, gpu and oracle paths build as the API serves them", async () => {
    h.responder = () => json(200, {});
    const c = mod.getProtocolClient();
    if (c === null) throw new Error("client missing");
    await c.getWalletBalances("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    await c.getWalletPositions("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    await c.getWalletExecutions("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", { limit: 20 });
    await c.listPools();
    await c.getPoolStats(`0x${"ab".repeat(32)}`, { fromSec: 100, toSec: 200 });
    await c.getPoolSwaps(`0x${"ab".repeat(32)}`, { limit: 30 });
    await c.listGpus();
    await c.getGpu("H100_SXM_80GB");
    await c.getStats();
    await c.getOracleState(`0x${"cd".repeat(32)}`, { history: true, limit: 5 });
    expect(h.fetchCalls).toEqual([
      "http://127.0.0.1:8080/v1/protocol/wallets/0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc/balances",
      "http://127.0.0.1:8080/v1/protocol/wallets/0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc/positions",
      "http://127.0.0.1:8080/v1/protocol/wallets/0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc/executions?limit=20",
      "http://127.0.0.1:8080/v1/protocol/pools",
      `http://127.0.0.1:8080/v1/protocol/pools/0x${"ab".repeat(32)}/stats?intervalSec=3600&from=100&to=200`,
      `http://127.0.0.1:8080/v1/protocol/pools/0x${"ab".repeat(32)}/swaps?limit=30`,
      "http://127.0.0.1:8080/v1/protocol/gpus",
      "http://127.0.0.1:8080/v1/protocol/gpus/H100_SXM_80GB",
      "http://127.0.0.1:8080/v1/protocol/stats",
      `http://127.0.0.1:8080/v1/protocol/oracle/0x${"cd".repeat(32)}?history=1&limit=5`,
    ]);
  });
});

describe("error semantics", () => {
  it("404 ⇒ null only for single-resource reads (getGpu)", async () => {
    h.responder = () => json(404, { error: "no such gpu" });
    const c = mod.getProtocolClient();
    if (c === null) throw new Error("client missing");
    await expect(c.getGpu("NOPE")).resolves.toBeNull();
    await expect(c.listPools()).rejects.toMatchObject({ kind: "http", status: 404 });
  });

  it("400 surfaces as an http error carrying the status", async () => {
    h.responder = () => json(400, { error: "bad cursor" });
    const c = mod.getProtocolClient();
    if (c === null) throw new Error("client missing");
    await expect(c.getPoolSwaps(`0x${"ab".repeat(32)}`)).rejects.toMatchObject({ kind: "http", status: 400 });
  });

  it("network failure ⇒ kind network (the store then fail-softs)", async () => {
    h.responder = () => {
      throw new Error("ECONNREFUSED");
    };
    const c = mod.getProtocolClient();
    if (c === null) throw new Error("client missing");
    await expect(c.getStats()).rejects.toMatchObject({ kind: "network" });
  });
});
