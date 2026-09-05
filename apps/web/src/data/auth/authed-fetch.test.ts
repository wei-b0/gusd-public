/**
 * Network-free tests for the authed-fetch boundary. The token getters are
 * injectable, so every Privy-side failure mode (null token, throwing getter,
 * 429 rate limit) is exercised without any Privy traffic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthedFetch, type AuthedFetchDeps } from "./authed-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

function deps(overrides: Partial<AuthedFetchDeps> = {}): AuthedFetchDeps {
  return {
    getAccessToken: vi.fn().mockResolvedValue("access-token"),
    getIdentityToken: vi.fn().mockResolvedValue("id-token"),
    ...overrides,
  };
}

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ ok: status < 400 }), { status });
}

/** Capture requests, serve the given statuses in order. */
function stubFetch(statuses: number[]): { requests: { url: string; headers: Headers }[] } {
  const requests: { url: string; headers: Headers }[] = [];
  const queue = [...statuses];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return jsonResponse(queue.shift() ?? 200);
  }));
  return { requests };
}

describe("createAuthedFetch", () => {
  it("sends both tokens when both are available", async () => {
    const { requests } = stubFetch([200]);
    const fetcher = createAuthedFetch(deps());
    await fetcher("/api/auth/session", { method: "POST" });
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer access-token");
    expect(requests[0]?.headers.get("X-Privy-Id-Token")).toBe("id-token");
  });

  it("sends the Bearer alone when the identity token is null", async () => {
    const { requests } = stubFetch([200]);
    const fetcher = createAuthedFetch(deps({ getIdentityToken: vi.fn().mockResolvedValue(null) }));
    await fetcher("/api/auth/session", { method: "POST" });
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer access-token");
    expect(requests[0]?.headers.get("X-Privy-Id-Token")).toBeNull();
  });

  it("survives a throwing identity-token getter (Privy 429) and still authenticates", async () => {
    const { requests } = stubFetch([200]);
    const fetcher = createAuthedFetch(
      deps({ getIdentityToken: vi.fn().mockRejectedValue(new Error("Too many requests.")) }),
    );
    const res = await fetcher("/api/auth/session", { method: "POST" });
    expect(res.status).toBe(200);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer access-token");
    expect(requests[0]?.headers.get("X-Privy-Id-Token")).toBeNull();
  });

  it("presents no headers when the access token is null", async () => {
    const { requests } = stubFetch([401]);
    const fetcher = createAuthedFetch(deps({ getAccessToken: vi.fn().mockResolvedValue(null) }));
    await fetcher("/api/auth/session", { method: "POST" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
  });

  it("survives a throwing access-token getter as an unauthenticated request", async () => {
    const { requests } = stubFetch([401]);
    const fetcher = createAuthedFetch(
      deps({ getAccessToken: vi.fn().mockRejectedValue(new Error("Too many requests.")) }),
    );
    await expect(fetcher("/api/auth/session", { method: "POST" })).resolves.toMatchObject({
      status: 401,
    });
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
  });

  it("retries once with fresh tokens on a 401", async () => {
    const { requests } = stubFetch([401, 200]);
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    const fetcher = createAuthedFetch(deps({ getAccessToken }));
    const res = await fetcher("/api/auth/session", { method: "POST" });
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("Authorization")).toBe("Bearer fresh-token");
  });

  it("surfaces the second 401 without retrying further", async () => {
    const { requests } = stubFetch([401, 401]);
    const fetcher = createAuthedFetch(deps());
    const res = await fetcher("/api/auth/session", { method: "POST" });
    expect(res.status).toBe(401);
    expect(requests).toHaveLength(2);
  });
});
