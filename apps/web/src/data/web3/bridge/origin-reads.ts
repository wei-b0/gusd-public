/**
 * Balance reads on bridge origin chains — the funding desk's "what you hold
 * where" figures. The wallet sits on the deployment chain, but the bridge
 * spends from origin chains, so these reads go over public transports keyed
 * by the origin registry — the same viem chain defs the Across adapter builds
 * on (see ./across). A chain id outside the map refuses (null): no endpoint
 * is ever guessed, matching ./public-client's posture.
 *
 * Fail-soft by contract: every failure — unknown chain, RPC flake — reads
 * as null, which the desk renders as "—", never as a zero balance.
 */

import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { ERC20_ABI } from "../abis/erc20";

/** The origin chains a read can speak to — mirrors across.ts's ORIGIN_TOKENS
 *  keys. Origin chains are by definition chains the app doesn't deploy to,
 *  so they ride viem's public defs rather than the chain registry. */
const ORIGIN_CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [arbitrum.id]: arbitrum,
};

const clients = new Map<number, PublicClient>();

/** The memoized read client for an origin chain; null outside the map. */
function clientFor(chainId: number): PublicClient | null {
  const chain = ORIGIN_CHAINS[chainId];
  if (!chain) return null;
  const existing = clients.get(chainId);
  if (existing) return existing;
  const client = createPublicClient({
    chain,
    transport: http(undefined, {
      batch: { wait: 16 },
      timeout: 10_000,
      retryCount: 2,
      retryDelay: 250,
    }),
  });
  clients.set(chainId, client);
  return client;
}

/** The owner's ERC-20 balance on an origin chain, raw units. Null for an
 *  unknown origin chain or a failed read. */
export async function originBalanceOf(
  chainId: number,
  token: Address,
  owner: Address,
): Promise<bigint | null> {
  const client = clientFor(chainId);
  if (client === null) return null;
  try {
    return await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  } catch {
    return null;
  }
}

/** Drop the memoized clients (tests). */
export function disposeOriginClients(): void {
  clients.clear();
}
