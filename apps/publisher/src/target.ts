import { createHash } from "node:crypto";
import { canonicalJson } from "@gusd/types";
import type { PublishableIndexValue, PublisherTarget } from "./types.js";

/**
 * The mock chain: acknowledges instantly with a deterministic reference —
 * sha256 over the canonical value, so a replay of the same publish produces
 * the same txRef and a divergence is visible. Records every call for tests
 * and for the ops log.
 */
export class MockPublisherTarget implements PublisherTarget {
  readonly name = "mock";
  readonly published: PublishableIndexValue[] = [];

  async publish(value: PublishableIndexValue): Promise<{ txRef: string }> {
    this.published.push(value);
    const txRef = createHash("sha256").update(canonicalJson(value)).digest("hex");
    return { txRef };
  }
}
