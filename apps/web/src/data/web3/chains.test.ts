import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeOriginChains,
  chainAddParams,
  chainCaip2From,
  chainIdFromCaip2,
  chainLabel,
  getActiveChain,
  isChainSupported,
  isKnownChain,
  signableChain,
} from "./chains";

describe("chains registry", () => {
  it("defaults to Anvil 31337", () => {
    expect(getActiveChain().id).toBe(31_337);
    expect(isChainSupported(31_337)).toBe(true);
  });

  it("refuses chains the build does not enable", () => {
    expect(isChainSupported(84_532)).toBe(false);
    expect(isChainSupported(8453)).toBe(false);
    expect(isChainSupported(1)).toBe(false);
  });

  it("knows its placeholder chains even while inactive", () => {
    expect(isKnownChain(84_532)).toBe(true);
    expect(isKnownChain(8453)).toBe(true);
    expect(isKnownChain(1)).toBe(false);
  });

  it("labels the registry chains and nothing else", () => {
    expect(chainLabel(31_337)).toBe("Anvil · dev");
    expect(chainLabel(84_532)).toBe("Base Sepolia · testnet");
    expect(chainLabel(8453)).toBe("Base · mainnet");
    expect(chainLabel(1)).toBeNull();
  });

  it("carries wallet_addEthereumChain params for the local node", () => {
    const params = chainAddParams(31_337);
    expect(params?.chainId).toBe("0x7a69");
    expect(params?.rpcUrls[0]).toBe("http://127.0.0.1:8545");
    expect(chainAddParams(1)).toBeNull();
  });

  it("names the desk's chain as the only always-signable chain", () => {
    expect(signableChain(31_337)?.id).toBe(31_337);
    // Bridge origins stay closed while the desk serves no funding.
    expect(signableChain(1)).toBeNull();
    expect(signableChain(8453)).toBeNull();
  });

  it("normalizes both wire forms of a chain id to CAIP-2", () => {
    // EIP-1193 providers report hex quantities (eth_chainId, chainChanged).
    expect(chainCaip2From("0x7a69")).toBe("eip155:31337");
    expect(chainCaip2From("0x1")).toBe("eip155:1");
    // Privy managed wallets report CAIP-2 directly.
    expect(chainCaip2From("eip155:84532")).toBe("eip155:84532");
    // Anything else is not a chain this desk can name.
    expect(chainCaip2From("0xzz")).toBeNull();
    expect(chainCaip2From("cosmos:keplr-118")).toBeNull();
    expect(chainCaip2From(null)).toBeNull();
  });

  it("round-trips CAIP-2 to the decimal id", () => {
    expect(chainIdFromCaip2("eip155:31337")).toBe(31_337);
    expect(chainIdFromCaip2(chainCaip2From("0x2105"))).toBe(8453);
    expect(chainIdFromCaip2("0x2105")).toBeNull(); // hex is not CAIP-2
  });
});

// The dev override is read from env at module load, so each case re-imports
// the module against a stubbed env.
describe("dev funding override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("forces the live surface onto the configured chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_FUNDING_DEV", "live");
    vi.resetModules();
    const { chainCapabilities } = await import("./chains");
    expect(chainCapabilities(31_337)).toEqual({
      crossChainFunding: true,
      crossChainGuidance: false,
    });
  });

  it("forces the guidance surface onto the configured chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_FUNDING_DEV", "guidance");
    vi.resetModules();
    const { chainCapabilities } = await import("./chains");
    expect(chainCapabilities(31_337)).toEqual({
      crossChainFunding: false,
      crossChainGuidance: true,
    });
  });

  it("never widens a chain the build did not configure", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_FUNDING_DEV", "guidance");
    vi.resetModules();
    const { chainCapabilities } = await import("./chains");
    // Base keeps its real (live) capability; Sepolia keeps none.
    expect(chainCapabilities(8453)).toEqual({ crossChainFunding: true, crossChainGuidance: false });
    expect(chainCapabilities(84_532)).toEqual({
      crossChainFunding: false,
      crossChainGuidance: false,
    });
  });

  it("unrecognized values leave the registry untouched", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_FUNDING_DEV", "yes");
    vi.resetModules();
    const { chainCapabilities } = await import("./chains");
    expect(chainCapabilities(31_337)).toEqual({
      crossChainFunding: false,
      crossChainGuidance: false,
    });
  });
});

// The bridge-origin universe mirrors the Across adapter's ORIGIN_TOKENS keys
// and opens only while the desk serves the live funding surface.
describe("bridge origins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the origins closed when the desk serves no funding", async () => {
    vi.resetModules();
    const { bridgeOriginChains, signableChain, chainAddParams, chainLabel } = await import("./chains");
    expect(bridgeOriginChains()).toEqual([]);
    expect(signableChain(1)).toBeNull();
    expect(chainAddParams(1)).toBeNull();
    expect(chainLabel(1)).toBeNull();
  });

  it("opens the Across universe — Ethereum, Base, Arbitrum One — under the live surface", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_FUNDING_DEV", "live");
    vi.resetModules();
    const { bridgeOriginChains, signableChain, chainAddParams, chainLabel } = await import("./chains");
    expect(bridgeOriginChains().map((c) => c.id)).toEqual([1, 8453, 42_161]);
    expect(signableChain(1)?.id).toBe(1);
    expect(chainAddParams(1)?.chainId).toBe("0x1");
    expect(chainAddParams(42_161)?.chainId).toBe("0xa4b1");
    expect(chainLabel(1)).toBe("Ethereum · bridge origin");
    // A chain neither the registry nor the origins know stays unknown.
    expect(signableChain(10)).toBeNull();
    expect(chainAddParams(10)).toBeNull();
  });
});
