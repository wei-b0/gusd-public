import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, uuidPk } from "./common.js";

/**
 * The pull-oracle publication ledger: every report the attestor has signed,
 * exactly as it is served and consumed on-chain. Replaces the push-era
 * `published_index_values` chain-write flow — attestation is a DB insert, an
 * EVM tx never happens.
 *
 * Wire fidelity: `price` is the scaled uint (USD/GPU-hour x 10_000) and the
 * epoch fields are unix seconds as signed on-chain — no display rounding is
 * persisted, so a served report re-encodes byte-identically to what was
 * signed.
 *
 * Unique (gpu_id, epoch) is the first-consumer-wins premise mirrored
 * off-chain: one report per GPU per epoch. A second row for the same epoch
 * would be an equivocation the GpuOracle would reject with
 * EpochAlreadyBound — the schema makes that unrepresentable.
 */
export const reports = pgTable(
  "reports",
  {
    id: uuidPk(),
    createdAt: createdAt(),
    /** Report schema version (1 = GpuOracle V1). */
    version: integer("version").notNull(),
    /** Canonical SKU the price applies to (e.g. "H100_SXM_80GB"). */
    gpuId: text("gpu_id").notNull(),
    /** The index candidate this report attests (lineage; calcHash binds bytes). */
    candidateId: uuid("candidate_id"),
    /** USD/GPU-hour x PRICE_SCALE (10_000) — the exact on-chain uint. */
    price: bigint("price", { mode: "number" }).notNull(),
    /** Engine computation time, unix seconds (<= attestedAt). */
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    /** Validity epoch: floor(unix_sec / EPOCH_LENGTH). */
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    /** epoch * EPOCH_LENGTH (inclusive). */
    validFrom: bigint("valid_from", { mode: "number" }).notNull(),
    /** validFrom + EPOCH_LENGTH (exclusive). */
    validUntil: bigint("valid_until", { mode: "number" }).notNull(),
    /** Methodology/receipt hash carried in the signed report. */
    calcHash: text("calc_hash").notNull(),
    /** 65-byte (r, s, v) EIP-712 signature, 0x-prefixed. */
    signature: text("signature").notNull(),
    /** keccak256(abi.encode(report, signature)) — the epoch-binding identity. */
    reportHash: text("report_hash").notNull(),
    /** When the attestor signed (may lag createdAt only under clock skew). */
    attestedAt: timestamp("attested_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reports_gpu_epoch_unique").on(t.gpuId, t.epoch),
    index("reports_gpu_attested_idx").on(t.gpuId, t.attestedAt.desc()),
  ],
);
