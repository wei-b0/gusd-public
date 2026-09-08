/**
 * Stable-asset identity — the frontend's trust boundary for funding assets.
 *
 * gUSD mints against one per-chain reserve asset (the GUSD `underlying`):
 * USDC where USDC is canonical, USDG on Robinhood Chain. Extra funding
 * stables ride the StableRouter whitelist. Neither is discoverable from
 * token metadata: lookalike "USDC"/"USDT" scam tokens exist on every chain
 * (verified on Robinhood Chain), so identity comes from exactly two
 * hand-written sources and nowhere else —
 *   1. the deployment record (addresses.generated.ts → on-chain whitelist),
 *   2. this module's display metadata (symbol/name, per chain id).
 * `symbol()` is never read on-chain for identity. A config/deployment
 * mismatch throws loudly instead of rendering a token the router would
 * reject — and every stable renders through stableLabel, so "USDG" (the
 * reserve) and "gUSD" (the product) can never blur in copy.
 */

import type { Address } from "viem";
import type { ProtocolAddresses } from "./abis/addresses.generated";
import { contractAddresses } from "./contracts";
import { getActiveChain } from "./chains";

/** Display metadata for one stable — hand-written, never symbol()-derived. */
export interface StableMeta {
  address: Address;
  symbol: string;
  name: string;
}

export interface ChainStableConfig {
  /** The chain's reserve asset — gUSD's underlying, the mint desk's home asset. */
  underlying: StableMeta;
  /** Extra StableRouter-whitelisted funding stables (may be empty). */
  others: StableMeta[];
}

/** Display-metadata table entry — what this module may name per chain. */
interface ChainStableTableEntry {
  underlying: { symbol: string; name: string };
  others?: Record<string, { symbol: string; name: string }>;
}

/** Display metadata per chain id. Keys are chain ids with deployments;
 *  a deployment without an entry here fails closed. Addresses of extra
 *  stables are pinned only where the token has a fixed address; the
 *  reserve asset's address always comes from the deployment record
 *  (it rotates on Anvil redeploys). */
const CHAIN_STABLES: Record<number, ChainStableTableEntry> = {
  /** Anvil dev — the mock reserve wears USDG's identity by Deploy default,
   *  so the dev preview shows the Robinhood Chain posture. The mock USDT
   *  is created via the CREATE2 proxy with a fixed salt by
   *  Deploy.full.s.sol (`gusd.mock.usdt.v1`), so its address is identical
   *  on every chain the script touches. */
  31337: {
    underlying: { symbol: "USDG", name: "Global Dollar" },
    others: { "0xAd8F7921738819152FFA371c984D736842ed8AFE": { symbol: "USDT", name: "Mock Tether USD" } },
  },
  /** Base Sepolia — testnet deploys of the full posture (Deploy.full);
   *  same mock-reserve display posture as Anvil. */
  84532: {
    underlying: { symbol: "USDG", name: "Global Dollar" },
    others: { "0xAd8F7921738819152FFA371c984D736842ed8AFE": { symbol: "USDT", name: "Mock Tether USD" } },
  },
  /** Robinhood Chain testnet — Paxos USDG (Global Dollar), 6 decimals;
   *  the mock USDT rides the StableRouter as a second funding stable. */
  46630: {
    underlying: { symbol: "USDG", name: "Global Dollar" },
    others: { "0xAd8F7921738819152FFA371c984D736842ed8AFE": { symbol: "USDT", name: "Mock Tether USD" } },
  },
  /** Robinhood Chain mainnet — Paxos USDG, the chain's canonical stable. */
  4663: { underlying: { symbol: "USDG", name: "Global Dollar" } },
};

let memo: Map<number, ChainStableConfig> | null = null;

/**
 * The stable config for the active (or given) chain, cross-checked against
 * the deployment record at first use. Memoized per chain id; throws — in
 * product voice — on any mismatch, so a stale whitelist can never reach the
 * UI silently.
 */
export function stableConfig(chainId?: number): ChainStableConfig {
  const id = chainId ?? getActiveChain().id;
  memo ??= new Map();
  const cached = memo.get(id);
  if (cached) return cached;
  const config = stableConfigFrom(id, contractAddresses(id));
  memo.set(id, config);
  return config;
}

/** The pure cross-check core, injectable (record + table) so tests exercise
 *  every trust-boundary branch without module mocks. Not memoized. */
export function stableConfigFrom(
  id: number,
  record: ProtocolAddresses,
  table: Record<number, ChainStableTableEntry> = CHAIN_STABLES,
): ChainStableConfig {
  const meta = table[id];
  if (!meta) {
    throw new Error(`No stable-asset config for chain ${id} — funding assets are deployment-config only.`);
  }

  const underlying: StableMeta = {
    address: record.underlying,
    symbol: meta.underlying.symbol,
    name: meta.underlying.name,
  };

  // Both directions must agree: the on-chain whitelist decides what the
  // router accepts, this config decides what the UI may name.
  const othersMeta = meta.others ?? {};
  const norm = (a: string) => a.toLowerCase();
  const whitelisted = new Set(record.stables.map(norm));
  if (!whitelisted.has(norm(underlying.address))) {
    throw new Error(`Chain ${id}: underlying ${underlying.address} is not whitelisted on its StableRouter — re-deploy.`);
  }
  const others: StableMeta[] = [];
  for (const addr of record.stables) {
    if (norm(addr) === norm(underlying.address)) continue;
    const m = othersMeta[addr] ?? othersMeta[norm(addr)];
    if (!m) {
      throw new Error(
        `Chain ${id}: StableRouter whitelists ${addr} with no display config in stables.ts — add it or remove it on-chain.`,
      );
    }
    others.push({ address: addr as Address, symbol: m.symbol, name: m.name });
  }
  for (const key of Object.keys(othersMeta)) {
    if (!whitelisted.has(norm(key))) {
      throw new Error(`Chain ${id}: stables.ts names ${key} but the StableRouter whitelist does not — stale config.`);
    }
  }

  return { underlying, others };
}

/** Every funding stable for the chain: the reserve asset first. */
export function stablesFor(chainId?: number): StableMeta[] {
  const cfg = stableConfig(chainId);
  return [cfg.underlying, ...cfg.others];
}

/** Resolve display metadata for an exact address, or null when unknown —
 *  callers must treat null as "not a funding asset here", never fall back
 *  to token metadata. */
export function stableMetaOf(address: string, chainId?: number): StableMeta | null {
  const norm = address.toLowerCase();
  return stablesFor(chainId).find((s) => s.address.toLowerCase() === norm) ?? null;
}

/**
 * The one rendering seam for a stable's identity: "USDG · Global Dollar".
 * Chips may show `meta.symbol` alone; any sentence-level mention goes
 * through here so gUSD (the product) and the reserve can never blur.
 */
export function stableLabel(meta: StableMeta): string {
  return `${meta.symbol} · ${meta.name}`;
}
