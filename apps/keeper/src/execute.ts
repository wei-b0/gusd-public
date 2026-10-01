/**
 * Execution: for each work item, fetch a FRESH attestation (never cached for
 * execution — the pull oracle's honesty rule), gate the broadcast with one
 * eth_call sim (abort on revert — the keeper never pays gas to fail), then
 * send one transaction from the funded hot EOA and reconcile the local book
 * from the indexer rows on the receipt.
 *
 * Broadcasts are serialized (a promise-queue mutex): a keeper racing itself
 * on nonces buys nothing, and execution frequency is bounded by the oracle's
 * epoch grid anyway.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Chain,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Logger } from "@gusd/types";
import type { WorkItem } from "./strategy.js";
import type { Book } from "./state.js";

export const PERP_ENGINE_KEEPER_ABI = [
  {
    type: "function",
    name: "executeOrder",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256" },
      { type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "liquidate",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address" },
      { type: "bytes32" },
      { type: "bool" },
      { type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "minOrderDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "orders",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "address", name: "account" },
          { type: "uint8", name: "kind" },
          { type: "uint8", name: "status" },
          { type: "bool", name: "isLong" },
          { type: "uint128", name: "sizeDeltaUsd" },
          { type: "uint128", name: "collateralDeltaUsd" },
          { type: "uint128", name: "acceptablePrice" },
          { type: "uint128", name: "triggerPrice" },
          { type: "uint96", name: "executionFee" },
          { type: "uint64", name: "createdAt" },
          { type: "bytes32", name: "market" },
        ],
      },
    ],
  },
] as const satisfies Abi;

interface AttestationResponse {
  gpuId: string;
  price: string;
  epoch: number;
  validUntil: number;
  updateData: `0x${string}`;
}

export interface Attestation {
  updateData: `0x${string}`;
  epoch: number;
  validUntil: number;
}

/** Fetches the CURRENT attestation for a SKU. Null = no executable report
 *  right now (never attested, attestor degraded, attestor ahead). Never
 *  cached — each call hits the endpoint (the route never caches either). */
export async function fetchAttestation(
  oracleHttpUrl: string,
  sku: string,
  logger: Logger,
): Promise<Attestation | null> {
  const url = `${oracleHttpUrl}/v1/prices/${encodeURIComponent(sku)}/attestation`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) {
    logger.debug("no attestation yet for this gpu", { sku });
    return null;
  }
  if (res.status === 503) {
    logger.warn("attestor not attesting right now (degraded or clock-skewed)", { sku });
    return null;
  }
  if (res.status !== 200) {
    logger.warn("attestation endpoint returned an unexpected status", { sku, status: res.status });
    return null;
  }
  const body = (await res.json()) as AttestationResponse;
  if (!body.updateData) {
    logger.warn("attestation response missing updateData", { sku });
    return null;
  }
  return { updateData: body.updateData, epoch: body.epoch, validUntil: body.validUntil };
}

export class Executor {
  readonly publicClient: PublicClient<HttpTransport, Chain>;
  readonly walletClient: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;
  readonly account: PrivateKeyAccount;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly book: Book,
    readonly engineAddress: `0x${string}`,
    private readonly env: { rpcUrl: string; chainId: number; privateKey: `0x${string}`; oracleHttpUrl: string; maxFeeGwei: number },
    private readonly logger: Logger,
  ) {
    const chain = defineChain({
      id: env.chainId,
      name: `gusd-${env.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [env.rpcUrl] } },
    });
    this.account = privateKeyToAccount(env.privateKey);
    this.publicClient = createPublicClient({ chain, transport: http(env.rpcUrl) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(env.rpcUrl),
    });
  }

  get executorAddress(): string {
    return this.account.address;
  }

  /** Reads the engine's execution delay (boot + periodic refresh). */
  async minOrderDelay(): Promise<bigint> {
    const v = (await this.publicClient.readContract({
      address: this.engineAddress,
      abi: PERP_ENGINE_KEEPER_ABI,
      functionName: "minOrderDelay",
    })) as bigint | number;
    return BigInt(v);
  }

  /** The hot EOA's native balance (health alerting). */
  async executorBalanceWei(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  /** Serializes all broadcasts through one promise chain. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async gasAllowed(): Promise<boolean> {
    const gas = await this.publicClient.estimateFeesPerGas();
    const max = gas?.maxFeePerGas ?? (await this.publicClient.getGasPrice());
    const ok = max <= BigInt(this.env.maxFeeGwei) * 1_000_000_000n;
    if (!ok) {
      this.logger.warn("base fee above the keeper's ceiling — skipping broadcast", {
        maxFeeGwei: Number(max / 1_000_000_000n),
        ceiling: this.env.maxFeeGwei,
      });
    }
    return ok;
  }

  /** Runs a batch of work items for one gpuId/attestation window. */
  async run(items: WorkItem[], sku: string): Promise<void> {
    const attestation = await fetchAttestation(this.env.oracleHttpUrl, sku, this.logger);
    if (!attestation) return;
    for (const item of items) {
      await this.runExclusive(() => this.execute(item, attestation));
    }
  }

  private encodeCall(item: WorkItem, updateData: `0x${string}`): `0x${string}` {
    return item.type === "executeOrder"
      ? encodeFunctionData({
          abi: PERP_ENGINE_KEEPER_ABI,
          functionName: "executeOrder",
          args: [item.orderId, updateData],
        })
      : encodeFunctionData({
          abi: PERP_ENGINE_KEEPER_ABI,
          functionName: "liquidate",
          args: [item.wallet as `0x${string}`, item.gpuId as `0x${string}`, item.isLong, updateData],
        });
  }

  private async execute(item: WorkItem, attestation: Attestation): Promise<void> {
    const log = (msg: string, extra: Record<string, unknown> = {}) =>
      this.logger.info(msg, { ...item, epoch: attestation.epoch, executor: this.executorAddress, ...extra });

    // Stale-check against the in-memory book before spending anything.
    if (item.type === "executeOrder" && !this.book.orders.has(String(item.orderId))) {
      this.logger.debug("order already resolved in book — skipping", { orderId: String(item.orderId) });
      return;
    }
    if (
      item.type === "liquidate" &&
      !this.book.positions.has(`${item.wallet}|${item.gpuId}|${item.isLong}`)
    ) {
      this.logger.debug("position already gone from book — skipping", { wallet: item.wallet });
      return;
    }

    // Gas ceiling first — cheaper than a sim.
    try {
      if (!(await this.gasAllowed())) return;
    } catch (err) {
      this.logger.warn("fee estimation failed — skipping", { err: String(err) });
      return;
    }

    // The one sim: abort on revert, never pay gas to fail. The sim MUST run
    // from the real executor EOA — an eth_call without `from` gives the engine
    // msg.sender == address(0), and the execution fee transfer to the keeper
    // reverts ERC20InvalidReceiver(0), which would abort every item forever.
    try {
      await this.publicClient.call({
        account: this.account.address,
        to: this.engineAddress,
        data: this.encodeCall(item, attestation.updateData),
      });
    } catch (err) {
      this.logger.info("sim reverted — item stays for a later tick", {
        type: item.type,
        detail: item.type === "executeOrder" ? String(item.orderId) : `${item.wallet}/${item.gpuId}`,
        err: String(err),
      });
      return;
    }

    // Broadcast + wait for the receipt.
    let hash: `0x${string}`;
    try {
      hash = await this.walletClient.sendTransaction({
        account: this.account.address,
        to: this.engineAddress,
        data: this.encodeCall(item, attestation.updateData),
      });
    } catch (err) {
      this.logger.warn("broadcast failed", { err: String(err) });
      return;
    }
    try {
      await this.publicClient.waitForTransactionReceipt({ hash, timeout: 30_000, confirmations: 1 });
      log("execution settled", { hash });
    } catch (err) {
      this.logger.warn("receipt wait failed — relying on the periodic reload", { hash, err: String(err) });
      return;
    }
    await this.reconcile(item);
  }

  /** Re-reads the affected indexer rows until they reflect the execution;
   *  falls back to one full book reload when the indexer lags past the bound. */
  private async reconcile(item: WorkItem): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        if (item.type === "executeOrder") {
          await this.book.refreshOrder(item.orderId);
          await this.book.refreshPositions(item.wallet, item.gpuId);
          await this.book.refreshMarket(item.gpuId);
          if (!this.book.orders.has(String(item.orderId))) return; // resolved in the indexer
        } else {
          await this.book.refreshPositions(item.wallet, item.gpuId);
          await this.book.refreshMarket(item.gpuId);
          if (!this.book.positions.has(`${item.wallet}|${item.gpuId}|${item.isLong}`)) return;
        }
      } catch (err) {
        this.logger.warn("reconcile read failed", { attempt: i, err: String(err) });
      }
    }
    this.logger.info("indexer lagged past the reconcile bound — full book reload");
    await this.book.load();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}