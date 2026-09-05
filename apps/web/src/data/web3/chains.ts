/**
 * The chain registry — every chain the app can speak of, with exactly one
 * active. Built from public env at module load (frozen at build time, like
 * the rest of NEXT_PUBLIC_*). Anvil 31337 is the working target; Base
 * Sepolia / Base exist as env-gated entries so enabling them is a config
 * change, not a code change — no other network is ever invented here.
 *
 * Contract addresses are deliberately out of scope for this module for now;
 * when the protocol ships, its per-chain address map (sourced from
 * apps/contracts/deployments/<id>.json) lands beside the registry.
 */

import { defineChain, type Chain } from "viem";

/** The build-time chain id (decimal). Default: the local Anvil deployment. */
const CONFIGURED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "31337");

/** Build-time RPC overrides keyed by decimal chain id. */
function rpcUrlFor(chainId: number): string | null {
  if (chainId === 31_337) {
    return process.env.NEXT_PUBLIC_RPC_URL_31337 ?? "http://127.0.0.1:8545";
  }
  if (chainId === 84_532) return process.env.NEXT_PUBLIC_RPC_URL_84532 ?? null;
  if (chainId === 8453) return process.env.NEXT_PUBLIC_RPC_URL_8453 ?? null;
  return null;
}

const ANVIL: Chain = defineChain({
  id: 31_337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const BASE_SEPOLIA: Chain = defineChain({
  id: 84_532,
  name: "base-sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
});

const BASE: Chain = defineChain({
  id: 8453,
  name: "base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
});

interface ChainEntry {
  chain: Chain;
  /** Registry name used in logs and tests. */
  key: "anvil" | "base-sepolia" | "base";
  /** Status label for the network row: "Anvil · dev", "Base · mainnet". */
  label: string;
  /** Params for wallet_addEthereumChain when the wallet lacks the chain. */
  addParams: {
    chainId: `0x${string}`;
    chainName: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrls: string[];
  };
}

const REGISTRY: Record<number, ChainEntry> = {
  [ANVIL.id]: {
    chain: ANVIL,
    key: "anvil",
    label: "Anvil · dev",
    addParams: {
      chainId: "0x7a69",
      chainName: "Anvil",
      nativeCurrency: ANVIL.nativeCurrency,
      rpcUrls: ["http://127.0.0.1:8545"],
    },
  },
  [BASE_SEPOLIA.id]: {
    chain: BASE_SEPOLIA,
    key: "base-sepolia",
    label: "Base Sepolia · testnet",
    addParams: {
      chainId: "0x14a34",
      chainName: "Base Sepolia",
      nativeCurrency: BASE_SEPOLIA.nativeCurrency,
      rpcUrls: ["https://sepolia.base.org"],
    },
  },
  [BASE.id]: {
    chain: BASE,
    key: "base",
    label: "Base · mainnet",
    addParams: {
      chainId: "0x2105",
      chainName: "Base",
      nativeCurrency: BASE.nativeCurrency,
      rpcUrls: ["https://mainnet.base.org"],
    },
  },
};

/** A chain is usable only when selected by env AND an RPC target exists
 *  (31337 carries its local-node default; remote chains require an override
 *  so the app never points at a guessed endpoint). */
function isChainEnabled(chainId: number): boolean {
  if (chainId === CONFIGURED_CHAIN_ID) return rpcUrlFor(chainId) !== null;
  return false;
}

/** The one active chain for this build. */
export function getActiveChain(): Chain {
  const entry = REGISTRY[CONFIGURED_CHAIN_ID];
  if (entry && isChainEnabled(CONFIGURED_CHAIN_ID)) return entry.chain;
  // Fail closed to the only chain the monorepo actually deploys to, with a
  // loud constructor-time truth: the configured id had no usable entry.
  if (CONFIGURED_CHAIN_ID !== ANVIL.id) {
    console.warn(
      `[chains] NEXT_PUBLIC_CHAIN_ID=${CONFIGURED_CHAIN_ID} has no usable chain entry — falling back to Anvil 31337.`,
    );
  }
  return ANVIL;
}

/** True when the app can operate on this chain id (the active chain). */
export function isChainSupported(chainId: number): boolean {
  return chainId === getActiveChain().id;
}

/** Human label for the network row: "Anvil · dev". */
export function chainLabel(chainId: number): string | null {
  return REGISTRY[chainId]?.label ?? null;
}

/** Build-time RPC override for a chain, if any. */
export function configuredRpcUrl(chainId: number): string | null {
  return isChainEnabled(chainId) ? rpcUrlFor(chainId) : null;
}

/** wallet_addEthereumChain params for a chain id, or null when unknown. */
export function chainAddParams(chainId: number): ChainEntry["addParams"] | null {
  return REGISTRY[chainId]?.addParams ?? null;
}

/** True when the chain is one the registry knows (even if not active). */
export function isKnownChain(chainId: number): boolean {
  return chainId in REGISTRY;
}

/** Decimal id from the CAIP-2 form wallets report ("eip155:84532" → 84532),
 *  or null for anything else. Display helper for the wallet's own chain. */
export function chainIdFromCaip2(caip: string | null): number | null {
  if (!caip?.startsWith("eip155:")) return null;
  const id = Number(caip.slice("eip155:".length));
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Canonical CAIP-2 from whatever the wire carried. EIP-1193 providers report
 * chain ids as hex quantities ("0x1") on eth_chainId and chainChanged, while
 * Privy's managed wallets report CAIP-2 ("eip155:1") — both arrive at the
 * same session field, so both must normalize to one form.
 */
export function chainCaip2From(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("0x")) {
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? `eip155:${id}` : null;
  }
  return value.startsWith("eip155:") ? value : null;
}
