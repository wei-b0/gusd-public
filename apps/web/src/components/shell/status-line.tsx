"use client";

/**
 * StatusLine — the terminal's permanent foot: the wire's health, the
 * standing cautions. Fixed to the viewport on every route; the machine is
 * never naked.
 */

import { useMemo, useRef, useSyncExternalStore } from "react";
import type { IndexQuality } from "@/domain/types";
import { useServices } from "@/data/services";

/** Wire health from one market's snapshot — the panel is shared per epoch. */
function useWireQuality(): IndexQuality | null {
  const { marketData } = useServices();
  const cache = useRef<{ live: IndexQuality | null; server: IndexQuality | null }>({
    live: null,
    server: null,
  });
  const subscribe = useMemo(
    () => (listener: () => void) =>
      marketData.subscribe(() => {
        cache.current.live = marketData.getSnapshot("H100")?.quality ?? null;
        listener();
      }),
    [marketData],
  );
  const getSnapshot = () => {
    if (!cache.current.live) {
      cache.current.live = marketData.getSnapshot("H100")?.quality ?? null;
    }
    return cache.current.live;
  };
  const getServerSnapshot = () => {
    if (!cache.current.server) {
      cache.current.server = marketData.getSnapshot("H100")?.quality ?? null;
    }
    return cache.current.server;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function StatusLine() {
  const q = useWireQuality();
  const allLive = q != null && q.sourcesLive === q.sourcesTotal;
  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-rule-strong bg-panel">
      <div className="mx-auto flex h-8 w-full max-w-360 items-center gap-x-4 overflow-x-auto px-3 md:px-5">
        <span className="flex shrink-0 items-baseline gap-1.5">
          <span
            aria-hidden
            className={`num text-[9px] leading-none ${allLive ? "text-up" : "text-amber"}`}
          >
            ●
          </span>
          <span className="slug text-data">Index feed</span>
        </span>
        {q && (
          <span className="num shrink-0 text-[10.5px] text-dim">
            {q.sourcesLive}/{q.sourcesTotal} sources
          </span>
        )}
        {q && <span className="num shrink-0 text-[10.5px] text-dim">{q.latencyMs} ms</span>}
        {q && (
          <span className="num hidden shrink-0 text-[10.5px] text-dim md:inline">
            epoch {q.epoch}
          </span>
        )}
        <span aria-hidden className="h-px min-w-4 flex-1 bg-rule" />
        <span className="slug shrink-0 text-amber">Index ≠ market</span>
        <span className="slug hidden shrink-0 text-amber sm:inline">Demo · all data simulated</span>
      </div>
    </footer>
  );
}
