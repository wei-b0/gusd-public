/**
 * Typed contract configuration and clients — the single place the web app
 * resolves protocol addresses and builds viem contract clients. Reads go
 * through getPublicClient (see ./public-client); every client here is a
 * read-or-write handle over that client.
 *
 * Addresses come from the generated deployment record beside this module
 * (sourced from apps/contracts/deployments/<id>.json). Anvil redeploys
 * rotate every address, so lookups refuse loudly rather than guessing, and
 * memoized clients are droppable via disposeContracts for tests.
 */

import { getContract, type Address, type GetContractReturnType, type PublicClient } from "viem";
import { getPublicClient } from "./public-client";
import { getActiveChain } from "./chains";
import { DEPLOYMENTS, type ProtocolAddresses } from "./abis/addresses.generated";
import { GUSD_ABI } from "./abis/gusd";
import { GPUISSUANCE_ABI } from "./abis/gpuissuance";
import { GPU_ROUTER_ABI } from "./abis/gpu_router";
import { GPU_HOOK_ABI } from "./abis/gpu_hook";
import { SGUSD_ABI } from "./abis/sgusd";
import { STABLE_ROUTER_ABI } from "./abis/stable_router";
import { GPU_PRICE_ORACLE_ABI } from "./abis/gpu_price_oracle";
import { V4_QUOTER_ABI } from "./abis/v4_quoter";
import { STATE_VIEW_ABI } from "./abis/state_view";
import { GPU_TOKEN_ABI } from "./abis/gpu_token";
import { ERC20_ABI } from "./abis/erc20";

export type { ProtocolAddresses };

/**
 * Protocol addresses for a chain id. Refuses chains without a deployment
 * with product voice — the registry knows Base, the monorepo does not
 * deploy there yet, and a guessed address would only misfire on-chain.
 */
export function contractAddresses(chainId?: number): ProtocolAddresses {
  const id = chainId ?? getActiveChain().id;
  const record = DEPLOYMENTS[id];
  if (!record) {
    throw new Error(
      `No protocol deployment for chain ${id} — this desk trades on the deployed protocol's chain.`,
    );
  }
  return record;
}

/** A viem contract bound to the active chain's read client. Explicit
 *  return annotations via ContractFor: the inferred instantiations of the
 *  fat ABIs exceed the compiler's declaration-emit serialization limit. */
function contract<const TAbi extends readonly unknown[]>(
  address: Address,
  abi: TAbi,
  client?: PublicClient,
): ContractFor<TAbi> {
  return getContract({ address, abi, client: client ?? getPublicClient() });
}

export type ContractFor<TAbi extends readonly unknown[]> = GetContractReturnType<
  TAbi,
  PublicClient
>;

export type GusdContract = ContractFor<typeof GUSD_ABI>;
function gusdContract(client?: PublicClient): GusdContract {
  return contract(contractAddresses().gusd, GUSD_ABI, client);
}

export type IssuanceContract = ContractFor<typeof GPUISSUANCE_ABI>;
function issuanceContract(client?: PublicClient): IssuanceContract {
  return contract(contractAddresses().issuance, GPUISSUANCE_ABI, client);
}

export type RouterContract = ContractFor<typeof GPU_ROUTER_ABI>;
function routerContract(client?: PublicClient): RouterContract {
  return contract(contractAddresses().router, GPU_ROUTER_ABI, client);
}

export type HookContract = ContractFor<typeof GPU_HOOK_ABI>;
function hookContract(client?: PublicClient): HookContract {
  return contract(contractAddresses().hook, GPU_HOOK_ABI, client);
}

export type SGusdContract = ContractFor<typeof SGUSD_ABI>;
function sgusdContract(client?: PublicClient): SGusdContract {
  return contract(contractAddresses().sgusd, SGUSD_ABI, client);
}

export type StableRouterContract = ContractFor<typeof STABLE_ROUTER_ABI>;
function stableRouterContract(client?: PublicClient): StableRouterContract {
  return contract(contractAddresses().stableRouter, STABLE_ROUTER_ABI, client);
}

export type OracleContract = ContractFor<typeof GPU_PRICE_ORACLE_ABI>;
function oracleContract(client?: PublicClient): OracleContract {
  return contract(contractAddresses().oracle, GPU_PRICE_ORACLE_ABI, client);
}

export type QuoterContract = ContractFor<typeof V4_QUOTER_ABI>;
function quoterContract(client?: PublicClient): QuoterContract {
  return contract(contractAddresses().quoter, V4_QUOTER_ABI, client);
}

export type StateViewContract = ContractFor<typeof STATE_VIEW_ABI>;
function stateViewContract(client?: PublicClient): StateViewContract {
  return contract(contractAddresses().stateView, STATE_VIEW_ABI, client);
}

/** A GPU position's 18-decimal ERC-20, resolved per gpuId at runtime. */
export type GpuTokenContract = ContractFor<typeof GPU_TOKEN_ABI>;
export function gpuTokenClient(address: Address, client?: PublicClient): GpuTokenContract {
  return contract(address, GPU_TOKEN_ABI, client);
}

/** Generic ERC-20 handle (reserve-asset / stable reads, approvals on any token). */
export type Erc20Contract = ContractFor<typeof ERC20_ABI>;
export function erc20Client(address: Address, client?: PublicClient): Erc20Contract {
  return contract(address, ERC20_ABI, client);
}

export interface ContractSet {
  gusd: GusdContract;
  /** The chain's reserve asset (the gUSD underlying). */
  stable: Erc20Contract;
  router: RouterContract;
  issuance: IssuanceContract;
  hook: HookContract;
  sgusd: SGusdContract;
  stableRouter: StableRouterContract;
  oracle: OracleContract;
  quoter: QuoterContract;
  stateView: StateViewContract;
  /** The addresses themselves — for allowance targets and pool keys. */
  addresses: ProtocolAddresses;
}

const sets = new Map<number, ContractSet>();

/**
 * The memoized contract set for the active chain. Memoized per chain id so
 * tests can dispose between Anvil redeploys; production never drops it.
 */
export function getContracts(chainId?: number): ContractSet {
  const id = chainId ?? getActiveChain().id;
  const existing = sets.get(id);
  if (existing) return existing;
  const addresses = contractAddresses(id);
  const client = getPublicClient(id);
  const set: ContractSet = {
    gusd: gusdContract(client),
    stable: erc20Client(addresses.underlying as Address, client),
    router: routerContract(client),
    issuance: issuanceContract(client),
    hook: hookContract(client),
    sgusd: sgusdContract(client),
    stableRouter: stableRouterContract(client),
    oracle: oracleContract(client),
    quoter: quoterContract(client),
    stateView: stateViewContract(client),
    addresses,
  };
  sets.set(id, set);
  return set;
}

/** Drop memoized contract sets (tests, or an Anvil redeploy under us). */
export function disposeContracts(chainId?: number): void {
  if (chainId === undefined) sets.clear();
  else sets.delete(chainId);
}
