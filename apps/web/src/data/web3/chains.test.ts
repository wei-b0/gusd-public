import { describe, expect, it } from "vitest";
import {
  chainAddParams,
  chainCaip2From,
  chainIdFromCaip2,
  chainLabel,
  getActiveChain,
  isChainSupported,
  isKnownChain,
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
