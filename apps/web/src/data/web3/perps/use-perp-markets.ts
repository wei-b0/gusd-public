"use client";

/**
 * usePerpMarketStates — all settlement panels' onchain perp market state in
 * one lazy probe (one verified read per asset). The perps desk's markets
 * rail and the discovery board's perpetuals panel both read this; a
 * failed or unregistered market reads null — the honest empty, never an
 * invented row — and `undefined` marks the still-checking window.
 */

import { useEffect, useState } from "react";
import type { AssetId, PerpMarketState } from "@/domain/types";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import { useServices } from "@/data/services";

export type PerpMarketStates = Partial<Record<AssetId, PerpMarketState | null | undefined>>;

export function usePerpMarketStates(refreshKey = 0): PerpMarketStates {
  const { perp } = useServices();
  const [states, setStates] = useState<PerpMarketStates>({});

  useEffect(() => {
    let alive = true;
    const assets = Object.keys(ORACLE_PANELS) as AssetId[];
    setStates({});
    Promise.all(assets.map((a) => perp.describeMarket(a).catch(() => null))).then((results) => {
      if (!alive) return;
      const next: PerpMarketStates = {};
      assets.forEach((a, i) => {
        next[a] = results[i];
      });
      setStates(next);
    });
    return () => {
      alive = false;
    };
  }, [perp, refreshKey]);

  return states;
}