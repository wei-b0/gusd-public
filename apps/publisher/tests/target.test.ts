import { describe, expect, it } from "vitest";
import { MockPublisherTarget } from "../src/target.js";
import type { PublishableIndexValue } from "../src/types.js";

const VALUE: PublishableIndexValue = {
  candidateId: "c1",
  gpuId: "H100_SXM_80GB",
  panelId: "H100_PANEL_V1",
  price: 2.94,
  confidenceLow: 2.86,
  confidenceHigh: 3.02,
  status: "healthy",
  methodologyVersion: "0.1.0",
  calcHash: "abc",
  computedAt: "2026-09-04T12:00:00.000Z",
};

describe("MockPublisherTarget", () => {
  it("returns a deterministic txRef — same value, same reference", async () => {
    const target = new MockPublisherTarget();
    const a = await target.publish(VALUE);
    const b = await new MockPublisherTarget().publish(VALUE);
    expect(a.txRef).toMatch(/^[0-9a-f]{64}$/);
    expect(a.txRef).toBe(b.txRef);
  });

  it("produces a different reference for a different value", async () => {
    const target = new MockPublisherTarget();
    const a = await target.publish(VALUE);
    const b = await target.publish({ ...VALUE, price: 2.95 });
    expect(a.txRef).not.toBe(b.txRef);
  });

  it("records every publish call in order", async () => {
    const target = new MockPublisherTarget();
    await target.publish(VALUE);
    await target.publish({ ...VALUE, price: 2.95 });
    expect(target.published).toHaveLength(2);
    expect(target.published[0]?.price).toBe(2.94);
    expect(target.published[1]?.price).toBe(2.95);
  });
});
