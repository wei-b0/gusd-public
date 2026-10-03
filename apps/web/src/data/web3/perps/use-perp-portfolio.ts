"use client";

/**
 * The portfolio's perp book data — one hook, one probe fan-out. The
 * portfolio is an action surface (rows carry Close), so its numbers are
 * the desk's truth: verified `getPosition` probes across every market the
 * engine registers, both sides, on a lazy interval — not indexer
 * projections re-marked by preview math.
 *
 * One instance per page. `PortfolioBook` owns it and prop-drills the
 * result to the perp and orders books; a second instance would double the
 * probe fan-out and let the two books disagree.
 */

import { useCallback, useEffect, useState } from "react";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import { useServices, useWalletSession } from "@/data/services";
import type { AssetId, PerpPendingOrder, PerpPositionProbe } from "@/domain/types";
import { fetchIndexedPerpClaimable } from "./indexed";
import { emptyProbes, mergeProbe, type PerpProbeMap } from "./portfolio-book";

export interface PerpPortfolioBook {
  /** The wallet session the probes gate on — perp actions fire only under
   *  a live session (the demo build diverges from account.connected). */
  connected: boolean;
  probes: PerpProbeMap;
  /** Armed orders across all markets; null = the read failed (never
   *  "nothing armed"). */
  orders: PerpPendingOrder[] | null;
  ordersLoaded: boolean;
  /** Claimable settlements — chain truth first; the indexed projection
   *  fills the gap only while the chain read is missing. */
  claimable: number | null;
  /** First probe cycle resolved (existence resolved; not "all flat"). */
  loaded: boolean;
  /** Re-probe now (order/cancel receipts, read failures). */
  refresh: () => void;
}

/** Probe cadence — the desk polls one market at 15s; the portfolio spans
 *  four markets, so it polls at double the interval. */
const PROBE_INTERVAL_MS = 30_000;

export function usePerpPortfolio(bumpKey = 0): PerpPortfolioBook {
  const { perp } = useServices();
  const session = useWalletSession();
  const connected = session.status === "connected";
  const [probes, setProbes] = useState<PerpProbeMap>(emptyProbes);
  const [orders, setOrders] = useState<PerpPendingOrder[] | null>(null);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [claimable, setClaimable] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [bump, setBump] = useState(0);
  const refresh = useCallback(() => setBump((b) => b + 1), []);

  useEffect(() => {
    if (!connected) {
      // Disconnected: reset to unknowns so the panels speak the connect
      // voice — never a fabricated flat book.
      setProbes(emptyProbes());
      setOrders(null);
      setOrdersLoaded(false);
      setClaimable(null);
      setLoaded(false);
      return;
    }
    let alive = true;
    const owner =
      session.status === "connected" ? (session.address?.toLowerCase() ?? null) : null;

    const load = () => {
      const assets = Object.keys(ORACLE_PANELS) as AssetId[];
      Promise.all(
        assets.flatMap((asset) => [
          perp.getPosition(asset, "long").catch((): PerpPositionProbe => ({ kind: "unknown" })),
          perp.getPosition(asset, "short").catch((): PerpPositionProbe => ({ kind: "unknown" })),
        ]),
      ).then((flat) => {
        if (!alive) return;
        setLoaded(true);
        setProbes((prev) => {
          const next = emptyProbes();
          assets.forEach((asset, i) => {
            next[asset] = {
              long: mergeProbe(flat[i * 2] ?? { kind: "unknown" }, prev[asset].long),
              short: mergeProbe(flat[i * 2 + 1] ?? { kind: "unknown" }, prev[asset].short),
            };
          });
          return next;
        });
      });
      perp
        .listPendingOrders()
        .catch(() => null)
        .then((pending) => {
          if (!alive) return;
          setOrders(pending);
          setOrdersLoaded(true);
        });
      // The claim figure prefers chain truth (the port answers null
      // without a session); the indexed projection fills the gap only
      // while the chain read is missing — chain never loses to the record.
      perp
        .getClaimable()
        .catch(() => null)
        .then((c) => {
          if (alive && c !== null) setClaimable(c);
        });
      if (owner !== null) {
        fetchIndexedPerpClaimable(owner).then((c) => {
          if (alive) setClaimable((prev) => prev ?? c);
        });
      }
    };

    load();
    const timer = setInterval(load, PROBE_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connected, session, perp, bumpKey, bump]);

  return { connected, probes, orders, ordersLoaded, claimable, loaded, refresh };
}
