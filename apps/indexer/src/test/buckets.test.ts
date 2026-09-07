/**
 * Bucket aggregate tests — pure bucket-start math plus the net-add upsert
 * contract of the DB helpers, checked against a capturing fake db (no
 * network, no real Ponder runtime).
 */
import { describe, expect, it } from "vitest";
import {
  bumpDailyBucket,
  bumpPoolHourBucket,
} from "../handlers/buckets.js";
import { dayBucketStart, hourBucketStart } from "../projections/buckets.js";

const POOL_ID =
  "0x9ecd2222879f5d4b3f7dfe8f4e164b6b9e8b9c6ecc0d0f2c1eae9ed3f9b1c07a" as const;

describe("bucket starts", () => {
  it("floors to the hour and day containing the block timestamp", () => {
    // A fixture timestamp from the dev chain (chain time, never wall clock).
    expect(hourBucketStart(1_788_698_065n)).toBe(1_788_696_000n);
    expect(dayBucketStart(1_788_698_065n)).toBe(1_788_652_800n);
  });

  it("keeps exact bucket boundaries as their own bucket", () => {
    expect(hourBucketStart(3_600n)).toBe(3_600n);
    expect(hourBucketStart(3_599n)).toBe(0n);
    expect(dayBucketStart(86_400n)).toBe(86_400n);
    expect(dayBucketStart(86_399n)).toBe(0n);
  });
});

interface CapturedInsert {
  values: Record<string, unknown>;
  set: unknown;
}

/** A BucketDb double that records insert values and the conflict callback. */
function capture(): {
  db: Parameters<typeof bumpDailyBucket>[0];
  inserts: CapturedInsert[];
} {
  const inserts: CapturedInsert[] = [];
  const db = {
    insert() {
      return {
        values(value: Record<string, unknown>) {
          return {
            onConflictDoUpdate(fn: unknown) {
              inserts.push({ values: value, set: fn });
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof bumpDailyBucket>[0];
  return { db, inserts };
}

describe("bumpDailyBucket", () => {
  it("inserts the zero row plus the delta, bucketed on chain time", async () => {
    const { db, inserts } = capture();
    await bumpDailyBucket(db, 31337, 1_788_698_065, {
      mintedGusd: 1_000_000n,
      mintCount: 1,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toEqual({
      chainId: 31337,
      bucketStart: 1_788_652_800,
      mintedGusd: 1_000_000n,
      redeemedGusd: 0n,
      mintCount: 1,
      redeemCount: 0,
      issuedGpu: 0n,
      issuedCount: 0,
      issuanceProceedsGusd: 0n,
      buyVolumeGusd: 0n,
      sellVolumeGusd: 0n,
      buyCount: 0,
      sellCount: 0,
      hookFeesGusd: 0n,
      revenueDistributedGusd: 0n,
    });
  });

  it("adds the delta to the existing row on conflict, leaving the rest", async () => {
    const { db, inserts } = capture();
    await bumpDailyBucket(db, 31337, 1_788_698_065, {
      mintedGusd: 1_000_000n,
      mintCount: 1,
    });
    const set = inserts[0]?.set as (row: Record<string, any>) => Record<string, any>;
    const result = set({
      mintedGusd: 5_000_000n,
      redeemedGusd: 2_000_000n,
      mintCount: 4,
      redeemCount: 1,
      issuedGpu: 3_000_000_000_000_000_000n,
      issuedCount: 2,
      issuanceProceedsGusd: 250_000_000n,
      buyVolumeGusd: 15_000_000n,
      sellVolumeGusd: 3_000_000n,
      buyCount: 3,
      sellCount: 1,
      hookFeesGusd: 47_554n,
      revenueDistributedGusd: 900_000n,
    });
    expect(result.mintedGusd).toBe(6_000_000n);
    expect(result.mintCount).toBe(5);
    expect(result.redeemedGusd).toBe(2_000_000n); // untouched: +0
    expect(result.issuedGpu).toBe(3_000_000_000_000_000_000n);
    expect(result.buyCount).toBe(3);
  });
});

describe("bumpPoolHourBucket", () => {
  it("inserts the zero row plus the swap delta, bucketed on chain time", async () => {
    const { db, inserts } = capture();
    await bumpPoolHourBucket(db, 31337, POOL_ID, 1_788_698_065, {
      volumeGusd: 12_562_500n,
      buyVolumeGusd: 12_562_500n,
      buys: 1,
      lpFeesGusdEst: 37_687n,
      swaps: 1,
    });
    expect(inserts[0]?.values).toEqual({
      chainId: 31337,
      poolId: POOL_ID,
      bucketStart: 1_788_696_000,
      volumeGusd: 12_562_500n,
      buyVolumeGusd: 12_562_500n,
      sellVolumeGusd: 0n,
      buys: 1,
      sells: 0,
      hookFeesGusd: 0n,
      lpFeesGusdEst: 37_687n,
      swaps: 1,
    });
  });

  it("applies negative hook-fee netting deltas on conflict", async () => {
    const { db, inserts } = capture();
    await bumpPoolHourBucket(db, 31337, POOL_ID, 1_788_698_065, {
      volumeGusd: -25_000n,
      buyVolumeGusd: -25_000n,
      hookFeesGusd: 25_000n,
    });
    const set = inserts[0]?.set as (row: Record<string, any>) => Record<string, any>;
    const result = set({
      volumeGusd: 200_000n,
      buyVolumeGusd: 150_000n,
      sellVolumeGusd: 50_000n,
      buys: 2,
      sells: 1,
      hookFeesGusd: 0n,
      lpFeesGusdEst: 600n,
      swaps: 3,
    });
    expect(result.volumeGusd).toBe(175_000n);
    expect(result.buyVolumeGusd).toBe(125_000n);
    expect(result.sellVolumeGusd).toBe(50_000n); // buy-side netting only
    expect(result.hookFeesGusd).toBe(25_000n);
    expect(result.swaps).toBe(3); // counts untouched by fee netting
  });
});
