/**
 * Unit tests for the user_events projection — pure logic, network-free.
 * Arg fixtures mirror the real decoded shapes from the Demo flow (anvil
 * 31337): gUSD 6-dec, GPU 18-dec, gpuId = left-aligned ASCII bytes32.
 */
import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import { eventKeys, eventToData } from "../events.js";
import {
  INDEXED_EVENT_NAMES,
  isIndexedEventName,
  projectUserEvent,
} from "../projections/user-event.js";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address; // checksummed on purpose
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const GUSD = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const ROUTER = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address;
const H100_GPU_ID =
  "0x4831303000000000000000000000000000000000000000000000000000000000"; // "H100"
const TX = `0x${"ab".repeat(32)}` as Hash;

const KEYS = {
  chainId: 31337,
  blockNumber: 285,
  logIndex: 3,
  blockTimestamp: 1788698065,
};

/** The web wire contract's resolution table, asserted here as the closed
 *  set — a name added on either side without the other fails this suite. */
const EXPECTED_NAMES = [
  "Minted",
  "Redeemed",
  "Issued",
  "Buy",
  "Sell",
  "Deposit",
  "Withdraw",
] as const;

describe("INDEXED_EVENT_NAMES", () => {
  it("is exactly the wire contract's closed set", () => {
    expect(INDEXED_EVENT_NAMES).toEqual(EXPECTED_NAMES);
  });

  it("isIndexedEventName accepts every set member and nothing else", () => {
    for (const name of EXPECTED_NAMES) {
      expect(isIndexedEventName(name)).toBe(true);
    }
    expect(isIndexedEventName("Swap")).toBe(false);
    expect(isIndexedEventName("Transfer")).toBe(false);
    expect(isIndexedEventName("minted")).toBe(false);
  });
});

describe("projectUserEvent", () => {
  it("Minted resolves the user to `to`", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: GUSD,
      event: "Minted",
      user: ALICE,
      args: { to: ALICE, underlyingIn: 1_000_000n, gusdOut: 999_900n, fee: 100n },
      txHash: TX,
    });
    expect(row.user).toBe(ALICE.toLowerCase());
    expect(row.event).toBe("Minted");
    expect(row.contract).toBe(GUSD.toLowerCase());
    expect(row.data).toEqual({
      to: ALICE.toLowerCase(),
      underlyingIn: "1000000",
      gusdOut: "999900",
      fee: "100",
    });
  });

  it("Redeemed resolves the user to `from`", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: GUSD,
      event: "Redeemed",
      user: ALICE,
      args: { from: ALICE, gusdIn: 500_000n, underlyingOut: 499_950n, fee: 50n },
      txHash: TX,
    });
    expect(row.user).toBe(ALICE.toLowerCase());
    expect(row.data.from).toBe(ALICE.toLowerCase());
  });

  it("Issued resolves the user to `to` and stringifies the 18-dec amount", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: (`0x${"e7".repeat(20)}`) as Address,
      event: "Issued",
      user: BOB,
      args: {
        caller: BOB,
        gpuId: H100_GPU_ID.toUpperCase(), // uppercase hex must come back lowercase
        to: BOB,
        amount: 2_000_000_000_000_000_000n,
        base: 5_000_000n,
        fee: 12_500n,
      },
      txHash: TX,
    });
    expect(row.user).toBe(BOB.toLowerCase());
    expect(row.data.gpuId).toBe(H100_GPU_ID);
    expect(row.data.amount).toBe("2000000000000000000");
    expect(row.data.caller).toBe(BOB.toLowerCase());
  });

  it("Buy resolves the user to `recipient` and keeps `payer` distinct in data", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: ROUTER,
      event: "Buy",
      user: BOB,
      args: {
        gpuId: H100_GPU_ID,
        recipient: BOB,
        payer: BOB,
        gpuOut: 5_000_000_000_000_000_000n,
        paid: 12_562_500n,
        poolGpuOut: 3_000_000_000_000_000_000n,
        issueGpuOut: 2_000_000_000_000_000_000n,
        hookFee: 43_539n,
        issuanceFee: 12_500n,
      },
      txHash: TX,
    });
    expect(row.user).toBe(BOB.toLowerCase());
    expect(row.data.paid).toBe("12562500");
    expect(row.data.hookFee).toBe("43539");
  });

  it("Sell resolves the user to `recipient`", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: ROUTER,
      event: "Sell",
      user: BOB,
      args: {
        gpuId: H100_GPU_ID,
        recipient: BOB,
        gpuIn: 1_000_000_000_000_000_000n,
        out: 2_995_837n,
        hookFee: 15_055n,
      },
      txHash: TX,
    });
    expect(row.user).toBe(BOB.toLowerCase());
    expect(row.data.out).toBe("2995837");
  });

  it("Deposit resolves the user to `owner` (not sender)", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: (`0x${"cf".repeat(20)}`) as Address,
      event: "Deposit",
      user: ALICE,
      args: { sender: ALICE, owner: ALICE, assets: 1_000_000n, shares: 998_001n },
      txHash: TX,
    });
    expect(row.user).toBe(ALICE.toLowerCase());
    expect(row.data.sender).toBe(ALICE.toLowerCase());
    expect(row.data.shares).toBe("998001");
  });

  it("Withdraw resolves the user to `owner` (not receiver)", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: (`0x${"cf".repeat(20)}`) as Address,
      event: "Withdraw",
      user: ALICE,
      args: {
        sender: ALICE,
        receiver: BOB,
        owner: ALICE,
        assets: 400_000n,
        shares: 399_200n,
      },
      txHash: TX,
    });
    expect(row.user).toBe(ALICE.toLowerCase());
    expect(row.data.receiver).toBe(BOB.toLowerCase());
  });

  it("carries the (chainId, blockNumber, logIndex, blockTimestamp) keys and lowercased txHash", () => {
    const row = projectUserEvent({
      keys: KEYS,
      contract: GUSD,
      event: "Minted",
      user: ALICE,
      args: { to: ALICE, underlyingIn: 1n, gusdOut: 1n, fee: 0n },
      txHash: TX.toUpperCase() as Hash,
    });
    expect(row.chainId).toBe(31337);
    expect(row.blockNumber).toBe(285);
    expect(row.logIndex).toBe(3);
    expect(row.blockTimestamp).toBe(1788698065);
    expect(row.txHash).toBe(TX);
  });

  it("throws on an event outside the closed set", () => {
    expect(() =>
      projectUserEvent({
        keys: KEYS,
        contract: GUSD,
        event: "Swap" as never,
        user: ALICE,
        args: {},
        txHash: TX,
      }),
    ).toThrow(/not in the indexed user-event set/);
  });
});

describe("eventKeys", () => {
  it("extracts the PK + settlement time from event metadata", () => {
    const keys = eventKeys(
      {
        block: { number: 285n, timestamp: 1788698065n },
        log: { logIndex: 7 },
        transaction: { hash: TX },
      },
      31337,
    );
    expect(keys).toEqual({
      chainId: 31337,
      blockNumber: 285,
      logIndex: 7,
      blockTimestamp: 1788698065,
    });
  });
});

describe("eventToData", () => {
  it("stringifies bigints at any depth", () => {
    expect(eventToData(123n)).toBe("123");
    expect(eventToData({ a: [1n, { b: 2n }] })).toEqual({ a: ["1", { b: "2" }] });
  });

  it("lowercases hex strings but leaves non-hex strings and decimals alone", () => {
    expect(eventToData("0xABCDEF")).toBe("0xabcdef");
    expect(eventToData("Minted")).toBe("Minted");
    expect(eventToData("12345")).toBe("12345");
    expect(eventToData(["0xF39F"])).toEqual(["0xf39f"]);
  });

  it("passes through numbers, booleans, nulls", () => {
    expect(eventToData({ n: 3000, ok: true, x: null })).toEqual({
      n: 3000,
      ok: true,
      x: null,
    });
  });
});
