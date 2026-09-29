/** The trigger-condition mirror — same vectors as the engine's _checkTrigger
 *  tests (SL has no floor by design; the condition IS the price bound). */

import { describe, expect, it } from "vitest";
import { triggerMet } from "./triggers";

describe("triggerMet", () => {
  const PRICE = 30_000n;

  it("TP long fires high", () => {
    expect(triggerMet("take-profit", true, 30_001n, PRICE)).toBe(true);
    expect(triggerMet("take-profit", true, PRICE, PRICE)).toBe(true);
    expect(triggerMet("take-profit", true, 29_999n, PRICE)).toBe(false);
  });

  it("TP short fires low", () => {
    expect(triggerMet("take-profit", false, 29_999n, PRICE)).toBe(true);
    expect(triggerMet("take-profit", false, PRICE, PRICE)).toBe(true);
    expect(triggerMet("take-profit", false, 30_001n, PRICE)).toBe(false);
  });

  it("SL long fires low", () => {
    expect(triggerMet("stop-loss", true, 29_999n, PRICE)).toBe(true);
    expect(triggerMet("stop-loss", true, PRICE, PRICE)).toBe(true);
    expect(triggerMet("stop-loss", true, 30_001n, PRICE)).toBe(false);
  });

  it("SL short fires high", () => {
    expect(triggerMet("stop-loss", false, 30_001n, PRICE)).toBe(true);
    expect(triggerMet("stop-loss", false, PRICE, PRICE)).toBe(true);
    expect(triggerMet("stop-loss", false, 29_999n, PRICE)).toBe(false);
  });
});