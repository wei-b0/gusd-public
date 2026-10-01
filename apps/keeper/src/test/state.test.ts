/**
 * The row mappers — the seam between the Envio entity tables and the book.
 * A mismatched column name here silently unmatches every order in the
 * strategy's market filter (orders stay armed forever with no log), so the
 * mapping is pinned to the columns the tables actually carry.
 */
import { describe, expect, it } from "vitest";
import { orderFromRow } from "../state.js";

// A row as node-postgres hands it back: numeric columns arrive as strings.
const ORDER_ROW = {
  id: "3",
  order_id: "3",
  account: "0x1afcb54d9f33738d1c71cab8362198ad811d8b4e",
  gpu_id: "0x483130305f53584d5f3830474200000000000000000000000000000000000000",
  kind: 0,
  status: 1,
  is_long: true,
  size_delta_usd: "100000000",
  collateral_delta_usd: "10000000",
  acceptable_price: "25976",
  trigger_price: "0",
  execution_fee: "10000",
  created_at_sec: "1790839371",
  chain_id: 31337,
};

describe("orderFromRow", () => {
  it("keys the order by the gpu_id column — the only market key PerpOrder carries", () => {
    const o = orderFromRow(ORDER_ROW);
    expect(o.market).toBe(ORDER_ROW.gpu_id);
    expect(o.orderId).toBe(3n);
    expect(o.sizeDeltaUsd).toBe(100000000n);
    expect(o.acceptablePrice).toBe(25976n);
    expect(o.createdAtSec).toBe(1790839371n);
    expect(o.kind).toBe(0);
    expect(o.isLong).toBe(true);
  });

  it("reads a market no row would ever miss: the strategy filter compares against the encoded tick gpuId", () => {
    const o = orderFromRow(ORDER_ROW);
    expect(o.market.startsWith("0x")).toBe(true);
    expect(o.market).not.toBe("undefined");
  });
});