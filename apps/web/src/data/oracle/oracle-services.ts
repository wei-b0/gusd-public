/**
 * Oracle-mode wiring: the composite market-data port over the mock universe.
 *
 * Trading, auth, earning, and mint have no backend — the protocol surface is
 * not integrated — so they delegate to the same MockServices instances, by
 * reference. One shared session truth; only the market-data seam changes.
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

  constructor() {
    const mock = new MockServices();
    const feed = getOracleFeed();
    this.marketData = new OracleMarketData(mock.marketData, feed);
    // Prototype execution prices off the API's Index — the one real price —
    // so quotes, fills, receipts, and position marks stay coherent with what
    // every interface displays. No asserted price → no quote, never a
    // simulated stand-in.
    mock.trading.priceSource = (asset) => this.marketData.indexPriceOf(asset);
    this.trading = mock.trading;
    this.auth = mock.auth;
    this.earn = mock.earn;
    this.mint = mock.mint;
    this.tx = mock.tx;
  }
}
