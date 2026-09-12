import { afterEach, describe, expect, it, vi } from "vitest";
import type { EIP1193Provider } from "@privy-io/react-auth";

/**
 * The auth port's chain guards. The bridge legitimately asks the wallet to
 * sign on a bridge-origin chain (the funding flow's approve + deposit legs),
 * so the port must serve signers off-desk exactly while the desk serves
 * funding — and nowhere else. The chain registry freezes at module load, so
 * each posture re-imports the modules against a stubbed env (the same
 * pattern chains.test.ts uses).
 */

const OWNER = "0x00000000000000000000000000000000000c0a1e";

/** A provider whose switch behavior the case shapes. */
function fakeProvider(switchResult: "ok" | "declined" = "ok") {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "wallet_switchEthereumChain" && switchResult === "declined") {
        throw Object.assign(new Error("user rejected"), { code: 4001 });
      }
      return null;
    }),
  } as unknown as EIP1193Provider & { request: ReturnType<typeof vi.fn> };
}

interface Loaded {
  port: import("./privy-auth-port").PrivyAuthPort;
  provider: ReturnType<typeof fakeProvider>;
}

/** A Robinhood-4663 build with the wallet attached on the desk's chain. */
async function loadRobinhoodPort(switchResult: "ok" | "declined" = "ok"): Promise<Loaded> {
  vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "4663");
  vi.stubEnv("NEXT_PUBLIC_RPC_URL_4663", "https://rpc.mainnet.chain.robinhood.com");
  vi.resetModules();
  const { PrivyAuthPort } = await import("./privy-auth-port");
  const port = new PrivyAuthPort();
  const provider = fakeProvider(switchResult);
  port.attachWallet({
    address: OWNER,
    walletKind: "external",
    walletLabel: "Test",
    provider,
    chainId: "eip155:4663",
  });
  return { port, provider };
}

async function loadDefaultPort() {
  vi.resetModules();
  const { PrivyAuthPort } = await import("./privy-auth-port");
  const port = new PrivyAuthPort();
  const provider = fakeProvider();
  port.attachWallet({
    address: OWNER,
    walletKind: "external",
    walletLabel: "Test",
    provider,
    chainId: "eip155:31337",
  });
  return { port, provider };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("switchChain — off-desk, on-origin", () => {
  it("switches to a bridge origin and records the landed switch in the session", async () => {
    const { port, provider } = await loadRobinhoodPort();
    await port.switchChain(1);
    expect(provider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1" }],
    });
    const session = port.getSession();
    expect(session.chainId).toBe("eip155:1");
    // The desk's chain it is not — networkOk says so honestly.
    expect(session.networkOk).toBe(false);
  });

  it("refuses chains that are neither the desk's nor a bridge origin", async () => {
    const { port } = await loadRobinhoodPort();
    await expect(port.switchChain(10)).rejects.toThrow(/only switches to robinhood/);
  });

  it("keeps the active-chain-only posture on a desk that serves no funding", async () => {
    const { port, provider } = await loadDefaultPort();
    await expect(port.switchChain(1)).rejects.toThrow(/only switches to anvil/);
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("still switches back to the desk's own chain", async () => {
    const { port, provider } = await loadRobinhoodPort();
    await port.switchChain(1);
    await port.switchChain(4663);
    expect(port.getSession().chainId).toBe("eip155:4663");
    expect(port.getSession().networkOk).toBe(true);
  });

  it("records the switch for a managed (embedded) wallet too — no provider event", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "4663");
    vi.stubEnv("NEXT_PUBLIC_RPC_URL_4663", "https://rpc.mainnet.chain.robinhood.com");
    vi.resetModules();
    const { PrivyAuthPort } = await import("./privy-auth-port");
    const port = new PrivyAuthPort();
    const switchManaged = vi.fn(async () => {});
    port.attachWallet({
      address: OWNER,
      walletKind: "embedded",
      walletLabel: "Privy",
      provider: fakeProvider(),
      chainId: "eip155:4663",
      switchManaged,
    });
    await port.switchChain(1);
    expect(switchManaged).toHaveBeenCalledWith("0x1");
    expect(port.getSession().chainId).toBe("eip155:1");
  });
});

describe("getWalletClient — the origin-leg signer", () => {
  it("binds the signer to the origin chain after a landed switch", async () => {
    const { port } = await loadRobinhoodPort();
    await port.switchChain(1);
    const client = await port.getWalletClient(1);
    expect(client.chain?.id).toBe(1);
    // A second origin resolves to its own bound client.
    await port.switchChain(8453);
    expect((await port.getWalletClient(8453)).chain?.id).toBe(8453);
  });

  it("refuses an origin signer while the wallet still sits on the desk's chain", async () => {
    const { port } = await loadRobinhoodPort();
    await expect(port.getWalletClient(1)).rejects.toThrow(/approve the network switch/);
  });

  it("refuses the desk signer while the wallet sits on an origin chain", async () => {
    const { port } = await loadRobinhoodPort();
    await port.switchChain(1);
    await expect(port.getWalletClient(4663)).rejects.toThrow(/wallet is on another network/);
  });

  it("refuses an origin signer when the switch was declined — the wallet stayed put", async () => {
    const { port } = await loadRobinhoodPort("declined");
    await port.switchChain(1); // resolves: a declined switch is a normal exit
    expect(port.getSession().chainId).toBe("eip155:4663");
    await expect(port.getWalletClient(1)).rejects.toThrow(/approve the network switch/);
  });
});
