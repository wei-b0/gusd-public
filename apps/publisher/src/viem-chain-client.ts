import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GPUPriceOracle_ABI, type ChainClient } from "./chain-target.js";
import type { PublisherEnv } from "./env.js";

export type ViemChainClient = ChainClient & { readonly accountAddress: string };

/**
 * The viem-backed ChainClient: the only file in the publisher that touches a
 * web3 library. The chain is defined from the configured id (no registry
 * lookup — the oracle address is the deployment source of truth), and
 * sendPublish waits for one receipt before returning, so the ledger's txRef
 * is a mined transaction hash. A revert or timeout throws into the poller's
 * per-candidate catch, which logs and lets the next tick retry.
 */
export function createViemChainClient(env: {
  rpcUrl: string;
  privateKey: string;
  oracleAddress: string;
  chainId: number;
  txTimeoutMs: number;
}): ViemChainClient {
  const chain: Chain = defineChain({
    id: env.chainId,
    name: `gusd-publisher-${env.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.rpcUrl] } },
  });
  const account = privateKeyToAccount(env.privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain, transport: http(env.rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(env.rpcUrl), account });

  return {
    accountAddress: account.address,
    async chainId() {
      return BigInt(await publicClient.getChainId());
    },
    async priceScale() {
      return publicClient.readContract({
        address: env.oracleAddress as `0x${string}`,
        abi: GPUPriceOracle_ABI,
        functionName: "PRICE_SCALE",
      });
    },
    async publisher() {
      return publicClient.readContract({
        address: env.oracleAddress as `0x${string}`,
        abi: GPUPriceOracle_ABI,
        functionName: "publisher",
      });
    },
    async sendPublish(gpuId, price, updatedAt) {
      const hash = await walletClient.writeContract({
        address: env.oracleAddress as `0x${string}`,
        abi: GPUPriceOracle_ABI,
        functionName: "publish",
        args: [gpuId, price, BigInt(updatedAt)],
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: env.txTimeoutMs,
      });
      return { txHash: hash };
    },
  };
}
