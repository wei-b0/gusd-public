import { beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, http, type Address, type Hex, type WalletClient } from "viem";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { getActiveChain } from "../chains";
import { disposeContracts, getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { GPU_PERP_ENGINE_ABI } from "../abis/gpu_perp_engine";
import { approveSpec } from "../approvals";
import { gpuIdForAsset, gpuIdToString } from "../gpu-id";
import type { ActionPlan, ActionPhase, ActionRecord, ActionStep } from "@/domain/actions";
import type { ActionPort } from "@/domain/ports";
import {
  buildReport,
  encodeUpdateData,
  reportHash,
  signReport,
  type SignerLike,
  type SignedReport,
} from "@gusd/attestor-client";
import { OnChainPerpPort } from "./onchain-perp-port";

/**
 * The perps desk verified against the deployed protocol (a fresh Deploy.full
 * chain) — the trading.anvil.test.ts posture. The whole two-stage lifecycle
 * runs here at desk level: quoteOpen → open (the desk's own action flow:
 * exact-amount approval → createOrder) → probe → the test plays the keeper
 * (`executeOrder` is permissionless past `minOrderDelay`) → verified
 * position view → close → settle → claim.
 *
 * Run with an anvil node up (default port 8545, raised gas limit) and the
 * protocol deployed via Deploy.full's runFull() — the day-grid deploy the
 * contract recipes document, because the test signs its own reports:
 *
 *   anvil --port 8545 --gas-limit 1000000000
 *   cd apps/contracts
 *   ORACLE_EPOCH_LENGTH=86400 ORACLE_MAX_OBSERVATION_AGE=86400 \
 *   PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 *     forge script script/Deploy.full.s.sol --rpc-url http://127.0.0.1:8545 \
 *     --broadcast --sig "runFull()" --gas-limit 600000000
 *   RUN_ANVIL_TESTS=1 npm test
 *
 * A FRESH chain per run: the suite trades real positions, so a second run
 * inherits the first's balances, OI, and claimable and its exact-amount
 * assertions fail (like every anvil suite in this repo, it is not idempotent).
 *
 * The suite is SELF-SUFFICIENT for attestations — no oracle API or attestor
 * container is involved. The port's `attestation` dep is injected with a
 * signer that reproduces the attestor's exact job (@gusd/attestor-client's
 * buildReport + signReport over the oracle's EIP-712 domain) using the
 * deployment's own signer key — anvil account #0 in the dev posture, where
 * the attestor IS the deployer; the suite aborts loudly when
 * `oracle.signer()` isn't a key it holds. Probes (verify) accept any
 * structurally valid report; only executions consume, and consume binds the
 * epoch first-consumer-wins. So every consume here is deliberate: the suite
 * warps the day-grid clock one epoch forward before each (the open and the
 * close must not share an epoch, since the suite signs its own reports —
 * byte-identical reuse is the real attestor's discipline, not this suite's),
 * and each phase holds one report price for the whole phase.
 */

const run = process.env.RUN_ANVIL_TESTS === "1";
const d = run ? describe : describe.skip;

/** Anvil's well-known funded accounts. Dev keys only — never real keys. */
const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ANVIL_KEY_1 =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const RPC_URL = "http://127.0.0.1:8545";
const H100 = gpuIdForAsset("H100");
const H100_SKU = gpuIdToString(H100);

/** The deployment's GUSD is the perp collateral; the ERC-20 ABI in the bundle
 *  stays user-surface only by design, so the fund step carries its own
 *  test-only transfer handle. */
const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** The trader's gUSD float — collateral for an open, a close, and a
 *  cancel-refund arm, with slack. */
const FUND = 200_000_000_000n; // 200,000 gUSD (6-dec)

/** A stable calcHash — the oracle records it, it never gates. */
const CALC_HASH = keccak256(toHex("gusd perps anvil test"));

d("perps desk against the deployed protocol", () => {
  const chain = getActiveChain();
  const publicClient = getPublicClient();
  const deployer: WalletClient = createWalletClient({
    account: privateKeyToAccount(ANVIL_KEY_0),
    chain,
    transport: http(RPC_URL),
  });
  const trader: WalletClient = createWalletClient({
    account: privateKeyToAccount(ANVIL_KEY_1),
    chain,
    transport: http(RPC_URL),
  });
  const traderAddress = trader.account!.address;

  /** The attestor's signer, typed like the attestor holds it — viem's
   *  signTypedData is structurally narrower than SignerLike; the same
   *  bridge the oracle e2e and apps/attestor make. */
  const attestorSigner = privateKeyToAccount(ANVIL_KEY_0) as unknown as SignerLike;

  // ------------------------------------------------------- suite state
  let port: OnChainPerpPort;
  let epochLength = 0;
  let maxObservationAge = 0;
  let minOrderDelay = 0;
  /** The report price this phase attests (USD/GPU-hour, 4-decimal). */
  let reportPrice = 3.0;
  let openOrderId = 0n;
  let closeOrderId = 0n;

  async function anvilRpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error !== undefined) throw new Error(`${method} failed: ${body.error.message}`);
    return body.result as T;
  }

  /** Moves anvil's clock — the day grid makes epoch-jumps invisible and the
   *  order delay a plain 17-second hop. */
  async function warp(seconds: number): Promise<void> {
    await anvilRpc("evm_increaseTime", [seconds]);
    await anvilRpc("evm_mine", []);
  }

  /**
   * The attestor's job, reproduced: one signed report for the CURRENT epoch
   * at the phase's price, anchored to the head clock. The oracle checks
   * epoch/validity/age structurally and the signature against `signer()` —
   * the deployer key in the dev posture.
   */
  async function currentAttestation(): Promise<
    { kind: "current"; signed: SignedReport; updateData: Hex; reportHash: Hex }
  > {
    const contracts = getContracts();
    const head = await publicClient.getBlock();
    const nowSec = Number(head.timestamp);
    const report = buildReport({
      gpuId: H100_SKU,
      price: reportPrice,
      observedAtSec: nowSec,
      nowSec,
      epochLength,
      maxObservationAge,
      calcHash: CALC_HASH,
    });
    const signed = await signReport(attestorSigner, report, {
      chainId: chain.id,
      verifyingContract: contracts.addresses.oracle as Address,
    });
    return { kind: "current", signed, updateData: encodeUpdateData(signed), reportHash: reportHash(signed) };
  }

  /** The keeper's execution — permissionless on the engine; anyone holding a
   *  current-epoch report can run it past the order delay. */
  async function executeAsKeeper(orderId: bigint): Promise<void> {
    const contracts = getContracts();
    const { updateData } = await currentAttestation();
    const hash = await deployer.writeContract({
      address: contracts.addresses.perpEngine as Address,
      abi: GPU_PERP_ENGINE_ABI,
      functionName: "executeOrder",
      args: [orderId, updateData],
      account: deployer.account ?? null,
      chain: null,
    });
    const receipt = await waitForTransactionReceipt(publicClient, { hash });
    if (receipt.status === "reverted") throw new Error(`executeOrder(${orderId}) reverted`);
  }

  /**
   * The desk's own action runner for a real wallet: exact-amount approvals,
   * the pre-signature simulation, the signature, receipt confirmation — the
   * ActionRunner's sequence, minus the browser.
   */
  class AnvilActions implements ActionPort {
    private n = 0;
    async run(plan: ActionPlan): Promise<ActionRecord> {
      const steps: ActionStep[] = [];
      let phase: ActionPhase = "complete";
      let error: string | null = null;
      try {
        for (const need of plan.approvals) {
          const { hash } = await approveSpec(need, plan.origin).execute(trader);
          const receipt = await waitForTransactionReceipt(publicClient, { hash });
          if (receipt.status === "reverted") throw new Error(`the approval reverted: ${need.tokenLabel}`);
          steps.push({ kind: "approve", label: `approve ${need.tokenLabel}`, txId: null, hash, done: true });
        }
        if (plan.simulate) {
          const sim = await plan.simulate();
          if (!sim.ok) throw new Error(sim.error);
        }
        const { hash } = await plan.buildSpec().execute(trader);
        const receipt = await waitForTransactionReceipt(publicClient, { hash });
        steps.push({ kind: "action", label: plan.label, txId: null, hash, done: true });
        if (receipt.status === "reverted") throw new Error(`the transaction reverted: ${plan.label}`);
        await plan.reconcile?.([]);
      } catch (e) {
        phase = "failed";
        error = e instanceof Error ? e.message : String(e);
      }
      return {
        id: `anvil-${++this.n}`,
        origin: plan.origin,
        label: plan.label,
        phase,
        steps,
        quote: plan.quote,
        error,
        txIds: steps.map((s) => s.hash).filter((x): x is string => x !== null),
        indexed: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    list() {
      return [];
    }
    get(): ActionRecord | null {
      return null;
    }
    subscribe() {
      return () => {};
    }
    isActionActive(): boolean {
      return false;
    }
    clear() {}
  }

  beforeAll(async () => {
    if ((await publicClient.getBlockNumber().catch(() => null)) === null) {
      throw new Error(`no anvil reachable at ${RPC_URL} — start one and run Deploy.full's runFull() first`);
    }
    disposeContracts();
    const contracts = getContracts();
    if (!contracts.addresses.perpEngine) {
      throw new Error("the deployment record has no perpEngine — deploy Deploy.full's runFull() first");
    }

    epochLength = Number(await contracts.oracle.read.epochLength());
    maxObservationAge = Number(await contracts.oracle.read.maxObservationAge());
    minOrderDelay = Number(await contracts.perpEngine.read.minOrderDelay());

    const signer = (await contracts.oracle.read.signer()).toLowerCase();
    if (signer !== deployer.account!.address.toLowerCase()) {
      throw new Error(
        `oracle.signer() is ${signer} — this suite signs with anvil account #0; redeploy the dev posture`,
      );
    }

    const fundHash = await deployer.writeContract({
      address: contracts.addresses.gusd as Address,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [traderAddress, FUND],
      account: deployer.account ?? null,
      chain: null,
    });
    await waitForTransactionReceipt(publicClient, { hash: fundHash });

    // A fresh epoch before the suite's first consume: the deploy's demo may
    // have bound the head epoch, and this suite signs its own reports.
    await warp(epochLength);

    port = new OnChainPerpPort({
      getSession: () => ({ status: "connected", address: traderAddress }),
      actions: new AnvilActions(),
      attestation: () => currentAttestation(),
      getBlockNumber: async () => Number(await publicClient.getBlockNumber()),
    });
  }, 60_000);

  it("quotes the open the desk previews — fees, bound, execution fee", async () => {
    const q = await port.quoteOpen({ asset: "H100", side: "long", collateral: 500, leverage: 2, toleranceBps: 50 });
    expect(q).not.toBeNull();
    expect(q!.collateral).toBe(500);
    expect(q!.sizeUsd).toBe(1000);
    expect(q!.openFee).toBe(1); // 10 bps of 1,000 — the engine ceils
    expect(q!.executionFee).toBe(0.01); // the MIN_EXECUTION_FEE floor
    expect(q!.acceptablePrice).toBe(3.015); // long buys with an upper bound
    expect(q!.referencePrice).toBe(3);
  }, 30_000);

  it("opens — locks collateral + fee, arms the pending order", async () => {
    const contracts = getContracts();
    const nonceBefore = await contracts.perpEngine.read.orderNonce();
    const record = await port.open({ asset: "H100", side: "long", collateral: 500, leverage: 2, toleranceBps: 50 });
    expect(record.phase).toBe("complete");
    expect(record.error).toBeNull();
    openOrderId = nonceBefore + 1n;

    const o = await contracts.perpEngine.read.orders([openOrderId]);
    expect(Number(o.status)).toBe(1); // Pending
    expect(Number(o.kind)).toBe(0); // MarketIncrease
    expect(o.isLong).toBe(true);
    expect(o.sizeDeltaUsd).toBe(1_000_000_000n);
    expect(o.collateralDeltaUsd).toBe(500_000_000n);
    expect(o.executionFee).toBe(10_000n);
    // The engine pulled exactly collateral + fee — no more, no less.
    expect(await contracts.gusd.read.balanceOf([traderAddress])).toBe(FUND - 500_010_000n);

    // The session registry holds this order — the desk lists it pending.
    const pending = await port.listPendingOrders();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.orderId).toBe(Number(openOrderId));
    expect(pending[0]!.kind).toBe("open");
  }, 30_000);

  it("the probe stays null until the keeper executes", async () => {
    // Nothing consumed yet — no position exists, verified at the live report.
    expect(await port.getPosition("H100", "long")).toBeNull();
  }, 30_000);

  it("the keeper executes and the position goes live", async () => {
    const contracts = getContracts();
    await warp(minOrderDelay + 2);
    await executeAsKeeper(openOrderId);

    const p = await port.getPosition("H100", "long");
    expect(p).not.toBeNull();
    expect(p!.sizeUsd).toBe(1000);
    expect(p!.collateral).toBe(499); // the open fee came out of the lock
    expect(p!.entryPrice).toBe(3); // filled exactly at the report
    expect(p!.uPnl).toBe(0);
    expect(p!.equity).toBe(499);
    expect(p!.fundingNet).toBe(0); // the deploy's default posture: zero rates
    expect(p!.liquidatable).toBe(false);
    // headroom = 499 − 25 (2.5% maintenance) = 474 → entry × (1 − 474/1000).
    expect(p!.liquidationPrice).toBeCloseTo(1.578, 9);

    // OI grew by exactly this position (the demo's open never executed here).
    const m = await port.describeMarket("H100");
    expect(m!.openInterestLong).toBe(1000);
    // The rest invariant: the engine holds live-position collateral + the
    // escrowed fees of pending orders — here also the demo's armed open
    // (alice's 1,000 collateral + 0.01 fee, never executed on this chain).
    expect(await contracts.gusd.read.balanceOf([contracts.addresses.perpEngine as Address])).toBe(
      1_499_010_000n,
    );
  }, 30_000);

  it("quotes a close in profit after the report moves", async () => {
    // A fresh epoch for the close's consume, then the report moves +10%.
    reportPrice = 3.3;
    await warp(epochLength);
    const q = await port.quoteClose({ asset: "H100", side: "long", size: null, toleranceBps: 50 });
    expect(q).not.toBeNull();
    expect(q!.sizeUsd).toBe(1000);
    expect(q!.entryPrice).toBe(3);
    expect(q!.pnl).toBe(100); // 10% of notional, floored
    expect(q!.closeFee).toBe(1);
    expect(q!.fundingNet).toBe(0);
    expect(q!.proceeds).toBe(598); // 499 coll + 100 pnl − 1 fee
  }, 30_000);

  it("closes and settles the payout to the claimable counter", async () => {
    const contracts = getContracts();
    const nonceBefore = await contracts.perpEngine.read.orderNonce();
    const record = await port.close({ asset: "H100", side: "long", size: null, toleranceBps: 50 });
    expect(record.phase).toBe("complete");
    closeOrderId = nonceBefore + 1n; // the nonce advances at createOrder

    await warp(minOrderDelay + 2);
    await executeAsKeeper(closeOrderId);

    expect(await port.getPosition("H100", "long")).toBeNull();
    expect(await port.getClaimable()).toBe(598);
  }, 30_000);

  it("cancels an armed order — the escrow comes straight back", async () => {
    const contracts = getContracts();
    const nonceBefore = await contracts.perpEngine.read.orderNonce();
    const record = await port.open({ asset: "H100", side: "long", collateral: 100, leverage: 1 });
    expect(record.phase).toBe("complete");
    const locked = await contracts.gusd.read.balanceOf([traderAddress]);
    await port.cancelOrder(Number(nonceBefore + 1n));
    // The refund is physical: collateral + escrowed fee, straight back —
    // claimable (the settlement counter) doesn't move.
    const after = await contracts.gusd.read.balanceOf([traderAddress]);
    expect(after - locked).toBe(100_010_000n);
    expect(await port.getClaimable()).toBe(598);
  }, 30_000);

  it("claims the settled balance out of the vault", async () => {
    const contracts = getContracts();
    const before = await contracts.gusd.read.balanceOf([traderAddress]);
    const record = await port.claim(0); // full counter
    expect(record.phase).toBe("complete");
    const after = await contracts.gusd.read.balanceOf([traderAddress]);
    expect(after - before).toBe(598_000_000n);
    expect(await port.getClaimable()).toBe(0);
  }, 30_000);
});