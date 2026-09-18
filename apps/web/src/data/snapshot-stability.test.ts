/**
 * The snapshot-contract sentinel. Every getter that feeds
 * useSyncExternalStore must return the SAME reference between changes —
 * React compares with Object.is, and a fresh object/array per call makes
 * the component re-render forever the moment any listener fires (the
 * Portfolio crash: the walletless earn snapshot was a fresh literal, and
 * connecting a wallet armed the loop). These tests turn that class of bug
 * into a red test at the port, in every service configuration.
 */
import { describe, expect, it } from "vitest";
import { MockServices } from "./mock/mock-services";
import { OracleServices } from "./oracle/oracle-services";
import { Web3Services } from "./auth/web3-services";
import { WalletlessAuthPort, WalletlessTxPort } from "./web3/walletless";
import { getOnchainAccountStore } from "./onchain/account-store";

/** Call getter twice cold, then again after a subscribe/notify cycle. */
function stableAcrossCycles(get: () => unknown, notify?: (fn: () => void) => () => void): void {
  const a = get();
  const b = get();
  expect(a).toBe(b); // repeated calls agree
  if (notify) {
    const seen: unknown[] = [];
    const unsub = notify(() => seen.push(get()));
    // A notify without a state change must not mint a new snapshot either.
    seen.push(get());
    unsub();
    for (const s of seen) expect(s).toBe(a);
  }
}

describe("snapshot referential stability (the useSyncExternalStore contract)", () => {
  it("walletless seams hold frozen references", () => {
    const auth = new WalletlessAuthPort();
    stableAcrossCycles(() => auth.getSession(), auth.subscribeSession.bind(auth));
    stableAcrossCycles(() => auth.getConnectFlow(), auth.subscribeConnectFlow.bind(auth));

    const tx = new WalletlessTxPort();
    stableAcrossCycles(() => tx.list(), tx.subscribe.bind(tx));
  });

  it("the mock universe's snapshot getters hold stable references", () => {
    const s = new MockServices();
    stableAcrossCycles(() => s.trading.getAccount(), s.trading.subscribe.bind(s.trading));
    stableAcrossCycles(() => s.earn.getEarnState(), s.earn.subscribe.bind(s.earn));
    stableAcrossCycles(() => s.tx.list(), s.tx.subscribe.bind(s.tx));
    stableAcrossCycles(() => s.actions.list(), s.actions.subscribe.bind(s.actions));
    stableAcrossCycles(() => s.auth.getSession(), s.auth.subscribeSession.bind(s.auth));
    stableAcrossCycles(() => s.auth.getConnectFlow());
  });

  it("the oracle services' ports hold stable references (privy-less default path)", () => {
    const s = new OracleServices();
    stableAcrossCycles(() => s.earn.getEarnState(), s.earn.subscribe.bind(s.earn));
    stableAcrossCycles(() => s.trading.getAccount(), s.trading.subscribe.bind(s.trading));
    stableAcrossCycles(() => s.tx.list(), s.tx.subscribe.bind(s.tx));
    stableAcrossCycles(() => s.actions.list(), s.actions.subscribe.bind(s.actions));
    stableAcrossCycles(() => s.auth.getSession(), s.auth.subscribeSession.bind(s.auth));
    stableAcrossCycles(() => s.auth.getConnectFlow(), s.auth.subscribeConnectFlow.bind(s.auth));
    stableAcrossCycles(() => s.accountStore.get(), s.accountStore.subscribe.bind(s.accountStore));
  });

  it("the wallet-backed services' shared stores hold stable references", () => {
    // Web3Services over the oracle base — the deployed wiring. The auth port
    // is Privy-bound (React bridge); only the React-free seams are asserted.
    const base = new OracleServices();
    let s: Web3Services;
    expect(() => {
      s = new Web3Services(base);
    }).not.toThrow();
    stableAcrossCycles(() => s!.accountStore.get(), s!.accountStore.subscribe.bind(s!.accountStore));
    stableAcrossCycles(() => s!.tx.list(), s!.tx.subscribe.bind(s!.tx));
    stableAcrossCycles(() => s!.actions.list(), s!.actions.subscribe.bind(s!.actions));
  });

  it("the onchain account store never mints a snapshot without a change", () => {
    const store = getOnchainAccountStore();
    const a = store.get();
    store.setAddress(null); // a no-op change (already null)
    expect(store.get()).toBe(a);
  });
});
