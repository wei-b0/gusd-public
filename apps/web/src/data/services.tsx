"use client";

/**
 * Services wiring.
 *
 * One provider owns the port implementations and hands them to the React
 * tree. Swapping the mock universe for real infrastructure means replacing
 * the adapters here — UI components never change.
 *
 * Snapshot consistency: hooks read versioned snapshots through
 * useSyncExternalStore, so server render and hydration agree and live ticks
 * replace the snapshot only after mount.
 */

import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  AssetId,
  ChartRange,
  EarnState,
  Market,
  MarketSnapshot,
  MintReceipt,
  TradeReceipt,
} from "@/domain/types";
import { MockServices } from "./mock/mock-services";

export interface Services {
  marketData: MockServices["marketData"];
  trading: MockServices["trading"];
  auth: MockServices["auth"];
  earn: MockServices["earn"];
  mint: MockServices["mint"];
}

/**
 * Prototype wiring. When real integrations land, construct them here instead:
 *   const services = { marketData: new ApiMarketData(...), trading: new ProtocolTrading(...), auth: new PrivyAuth(...) }
 */
function createServices(): Services {
  return new MockServices();
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  children,
  services,
}: {
  children: React.ReactNode;
  /** Injection point for tests or a server-configured implementation. */
  services?: Services;
}) {
  const value = useMemo(() => services ?? createServices(), [services]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices requires <ServicesProvider>");
  return services;
}

/** Live list of all GPU asset markets, ordered by traded volume. */
export function useMarkets(): Market[] {
  const { marketData } = useServices();
  // One cached snapshot per hook instance: useSyncExternalStore compares with
  // Object.is, so both the live and server snapshots must hold references.
  const cache = useRef<{ live: Market[] | null; server: Market[] | null }>({
    live: null,
    server: null,
  });
  const subscribe = useMemo(
    () => (listener: () => void) =>
      marketData.subscribe((markets) => {
        cache.current.live = markets;
        listener();
      }),
    [marketData],
  );
  const getSnapshot = () => {
    if (!cache.current.live) cache.current.live = marketData.listMarkets();
    return cache.current.live;
  };
  const getServerSnapshot = () => {
    if (!cache.current.server) cache.current.server = marketData.listMarkets();
    return cache.current.server;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Full snapshot for one market at a chart range; refreshed on live ticks. */
export function useMarketSnapshot(asset: AssetId, range: ChartRange = "1D"): MarketSnapshot | null {
  const { marketData } = useServices();
  const key = `${asset}:${range}`;
  const cache = useRef<{
    key: string;
    live: MarketSnapshot | null;
    server: MarketSnapshot | null;
  }>({ key: "", live: null, server: null });
  const subscribe = useMemo(
    () => (listener: () => void) =>
      marketData.subscribe(() => {
        cache.current = {
          key,
          live: marketData.getSnapshot(asset, range),
          server: cache.current.server,
        };
        listener();
      }),
    [marketData, asset, range, key],
  );
  const getSnapshot = () => {
    if (cache.current.key !== key || !cache.current.live) {
      cache.current = { key, live: marketData.getSnapshot(asset, range), server: cache.current.server };
    }
    return cache.current.live;
  };
  const getServerSnapshot = () => {
    if (cache.current.key !== key || !cache.current.server) {
      cache.current = { key, live: cache.current.live, server: marketData.getSnapshot(asset, range) };
    }
    return cache.current.server;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Live account state; re-renders on fills and connection changes. */
export function useAccount(): ReturnType<Services["trading"]["getAccount"]> {
  const { trading } = useServices();
  return useSyncExternalStore(
    (listener) => trading.subscribe(listener),
    () => trading.getAccount(),
    () => trading.getAccount(),
  );
}

/** This session's simulated fills, oldest first; refreshed on fills. */
export function useActivity(): TradeReceipt[] {
  const { trading } = useServices();
  const cache = useRef<TradeReceipt[] | null>(null);
  return useSyncExternalStore(
    (listener) =>
      trading.subscribe(() => {
        cache.current = trading.getActivity();
        listener();
      }),
    () => cache.current ?? trading.getActivity(),
    () => trading.getActivity(),
  );
}

/** Live earning-layer state; re-renders on deposits, withdrawals, accrual. */
export function useEarn(): EarnState {
  const { earn } = useServices();
  return useSyncExternalStore(
    (listener) => earn.subscribe(listener),
    () => earn.getEarnState(),
    () => earn.getEarnState(),
  );
}

/** This session's mint receipts, oldest first. */
export function useMintActivity(): MintReceipt[] {
  const { mint } = useServices();
  const cache = useRef<MintReceipt[] | null>(null);
  return useSyncExternalStore(
    (listener) =>
      mint.subscribe(() => {
        cache.current = mint.getActivity();
        listener();
      }),
    () => cache.current ?? mint.getActivity(),
    () => mint.getActivity(),
  );
}
