import { PRICE_SCALE, encodeGpuId, priceToScaled, updatedAtSeconds } from "./encoding.js";
import type { PublishableIndexValue, PublisherTarget } from "./types.js";

/**
 * Minimal hand-written ABI for GPUPriceOracle — three functions, no codegen.
 * Kept in lockstep with apps/contracts/src/oracle/GPUPriceOracle.sol; the
 * encoding contract is pinned in IGPUPriceOracle's NatSpec.
 */
export const GPUPriceOracle_ABI = [
  {
    type: "function",
    name: "publish",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gpuId", type: "bytes32" },
      { name: "price", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "PRICE_SCALE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "publisher",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * The chain seam: everything ChainPublisherTarget needs from a web3 stack,
 * narrow enough to fake in tests without an RPC.
 */
export interface ChainClient {
  chainId(): Promise<bigint>;
  priceScale(): Promise<bigint>;
  publisher(): Promise<`0x${string}`>;
  /** Submit publish() and wait for the receipt; throws on revert/timeout. */
  sendPublish(
    gpuId: `0x${string}`,
    price: bigint,
    updatedAt: number,
  ): Promise<{ txHash: string }>;
}

export interface ChainPublisherTargetOptions {
  /** Address the client signs from — verify() requires it to be the oracle's publisher. */
  accountAddress: string;
  /** Chain id the operator configured — verify() aborts on mismatch. */
  expectedChainId: number;
}

/**
 * The real target: encodes the publishable value into the oracle's wire
 * format, submits publish(), and waits for one receipt. The tx hash is the
 * ledger's txRef. Startup calls verify() — a wrong publisher identity would
 * make every publish revert, so boot aborts loudly instead.
 */
export class ChainPublisherTarget implements PublisherTarget {
  readonly name = "chain";

  constructor(
    private readonly client: ChainClient,
    private readonly opts: ChainPublisherTargetOptions,
  ) {}

  async verify(): Promise<void> {
    const [chainId, priceScale, publisher] = await Promise.all([
      this.client.chainId(),
      this.client.priceScale(),
      this.client.publisher(),
    ]);
    if (chainId !== BigInt(this.opts.expectedChainId)) {
      throw new Error(
        `chain id mismatch: connected to ${chainId}, expected ${this.opts.expectedChainId}`,
      );
    }
    if (priceScale !== PRICE_SCALE) {
      throw new Error(`oracle PRICE_SCALE is ${priceScale}, expected ${PRICE_SCALE}`);
    }
    if (publisher.toLowerCase() !== this.opts.accountAddress.toLowerCase()) {
      throw new Error(
        `oracle publisher is ${publisher}, but this process signs from ${this.opts.accountAddress}`,
      );
    }
  }

  async publish(value: PublishableIndexValue): Promise<{ txRef: string }> {
    // encode first: a bad value throws here, before any chain traffic
    const gpuId = encodeGpuId(value.gpuId);
    const price = priceToScaled(value.price);
    const updatedAt = updatedAtSeconds(value.computedAt);
    const { txHash } = await this.client.sendPublish(gpuId, price, updatedAt);
    return { txRef: txHash };
  }
}
