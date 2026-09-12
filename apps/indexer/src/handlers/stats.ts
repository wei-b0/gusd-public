/**
 * Singleton aggregate rows (protocol_stats, sgusd_vault). Counters are
 * delta-based upserts — the event's own delta rides the insert VALUES too
 * (the entity insert writes `values` verbatim when the row is absent, so an all-zero
 * insert silently drops the first event's delta), then add deltas on
 * conflict — so reorg rollback + replay converges (never SET x = total).
 * Config mirrors (fee bps, recipients) are last-write-wins by event order.
 */
import { protocolStats, sgusdVault } from "../schema.js";

type ProtocolStatsInsert = typeof protocolStats.$inferInsert;
type SgusdVaultInsert = typeof sgusdVault.$inferInsert;

export function zeroProtocolStats(chainId: number): ProtocolStatsInsert {
  return {
    chainId,
    gusdMintedGusd: 0n,
    gusdRedeemedGusd: 0n,
    mintCount: 0,
    redeemCount: 0,
    issuedGpu: 0n,
    issuedCount: 0,
    issuanceProceedsGusd: 0n,
    issuanceFeesGusd: 0n,
    buyCount: 0,
    sellCount: 0,
    buyVolumeGusd: 0n,
    sellVolumeGusd: 0n,
    hookFeesGusd: 0n,
    lpFeesGusdEst: 0n,
    revenueDistributedGusd: 0n,
    revenueToVaultGusd: 0n,
    revenueToTreasuryGusd: 0n,
  };
}

export function zeroSgusdVault(chainId: number): SgusdVaultInsert {
  return {
    chainId,
    seededGusd: 0n,
    depositsGusd: 0n,
    withdrawsGusd: 0n,
    sharesMinted: 0n,
    sharesBurned: 0n,
    depositCount: 0,
    withdrawCount: 0,
    revenueGusd: 0n,
  };
}
