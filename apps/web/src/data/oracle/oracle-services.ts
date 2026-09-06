/**
 * Oracle-mode wiring: the composite market-data port over the oracle feed.
 *
 * Auth, tx, and the walletless execution stubs (trading/earn/mint) delegate
 * to the same MockServices instances, by reference — one session truth.
 * With Privy configured, Web3Services swaps those seams for the real
 * onchain ports; only the market-data seam is oracle-mode's own.
 */

import type { Services } from "@/domain/ports";
import { MockServices } from "../mock/mock-services";
import { getOracleFeed } from "./feed";
import { OracleMarketData } from "./oracle-market-data";

export class OracleServices implements Services {
  readonly marketData: OracleMarketData;
  readonly trading: MockServices["trading"];
  readonly auth: MockServices["auth"];
  readonly earn: MockServices["earn"];
  readonly mint: MockServices["mint"];
  readonly tx: MockServices["tx"];
  readonly actions: MockServices["actions"];

  constructor() {
    const mock = new MockServices();
    const feed = getOracleFeed();
    this.marketData = new OracleMarketData(mock.marketData, feed);
    this.trading = mock.trading;
    this.auth = mock.auth;
    this.earn = mock.earn;
    this.mint = mock.mint;
    this.tx = mock.tx;
    this.actions = mock.actions;
  }
}
