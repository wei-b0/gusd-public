"use client";

/**
 * StatusLine — the terminal's permanent foot: the wire's health, the
 * standing cautions. Fixed to the viewport on every route; the machine is
 * never naked.
 *
 * The lamp tells the truth about the source: in mock mode it reads the
 * simulated panel; in oracle mode it reads the feed connection and the
 * H100 candidate's publication state — green only when the stream is live
 * AND the Index is fresh AND every observed source is contributing.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IndexQuality, IndexStatus } from "@/domain/types";
import { fmtAge, fmtStamp } from "@/domain/format";
import { useServices } from "@/data/services";
import { DATA_SOURCE } from "@/data/oracle/config";
import { getOracleFeed } from "@/data/oracle/feed";
import { DEMO_TICKS } from "@/data/demo";
import { TickFlash } from "@/components/ui/tick-flash";

interface WireInfo {
  quality: IndexQuality | null;
  indexStatus?: IndexStatus;
}

/** Wire health from one market's snapshot — the panel is shared per epoch. */
function useWireQuality(): WireInfo | null {
  const { marketData } = useServices();
  const cache = useRef<{ live: WireInfo | null; server: WireInfo | null }>({
    live: null,
    server: null,
  });
  const read = (): WireInfo | null => {
    const snapshot = marketData.getSnapshot("H100");
    return snapshot ? { quality: snapshot.quality, indexStatus: snapshot.market.indexStatus } : null;
  };
  const subscribe = useMemo(
    () => (listener: () => void) =>
      marketData.subscribe(() => {
        cache.current.live = read();
        listener();
      }),
    [marketData],
  );
  const getSnapshot = () => {
    if (!cache.current.live) cache.current.live = read();
    return cache.current.live;
  };
  const getServerSnapshot = () => {
    if (!cache.current.server) cache.current.server = read();
    return cache.current.server;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The feed's connection state, oracle mode only — the mock data source
 *  never touches the feed (and never opens a connection), and the dev-only
 *  tick demonstrator reads the mock universe too. */
function useConnection(enabled: boolean) {
  const feed = getOracleFeed();
  return useSyncExternalStore(
    (cb) => (enabled ? feed.subscribe(cb) : () => {}),
    () => (enabled ? feed.getState().connection : "idle"),
    () => "idle",
  );
}

export function StatusLine() {
  const wire = useWireQuality();
  const q = wire?.quality ?? null;
  const indexStatus = wire?.indexStatus;

  // Updated-age needs a clock, and a clock breaks hydration if it reads
  // Date.now() during render — so it starts null (absolute stamp matches the
  // server) and starts ticking after mount.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  // Demo mode flips on after mount (`now` is the mounted flag), so server and
  // first client render agree — no hydration surface.
  const oracle = DATA_SOURCE === "oracle" && !(DEMO_TICKS && now !== null);
  const connection = useConnection(oracle);
  const lampDown = oracle && (connection === "down" || indexStatus === "withheld" || indexStatus === "frozen");
  const lampUp = lampDown
    ? false
    : oracle
      ? connection === "live" && indexStatus === "live" && q != null && q.sourcesLive === q.sourcesTotal
      : q != null && q.sourcesLive === q.sourcesTotal;
  const lampTone = lampDown ? "text-down" : lampUp ? "text-up" : "text-amber";
  const lampLabel = lampDown ? "feed down" : lampUp ? "feed healthy" : "feed degraded";

  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-rule-strong bg-panel">
      <div className="mx-auto flex h-8 w-full max-w-360 items-center gap-x-4 overflow-x-auto px-3 md:px-5">
        <span className="flex shrink-0 items-baseline gap-1.5">
          <span role="img" aria-label={lampLabel} className={`num text-[9px] leading-none ${lampTone}`}>
            ●
          </span>
          <span className="slug text-data">Index feed</span>
        </span>
        {q && (
          <span className="num shrink-0 text-[10.5px] text-dim">
            {q.sourcesLive}/{q.sourcesTotal} sources
          </span>
        )}
        {q && (
          <span className="num shrink-0 text-[10.5px] text-dim">
            {now === null ? `updated ${fmtStamp(q.updatedAt)}` : `updated ${fmtAge(q.updatedAt, now)}`}
          </span>
        )}
        {q && (
          <span className="num hidden shrink-0 text-[10.5px] text-dim md:inline">
            {q.publication ? (
              /* One cyan pulse per real landing — the hash changes only when
                 data arrives, independent of any price moving. */
              <TickFlash value={q.publication} flash="wire" className="inline-block">
                {`#${q.publication}`}
              </TickFlash>
            ) : (
              "—"
            )}
          </span>
        )}
        <span aria-hidden className="h-px min-w-4 flex-1 bg-rule" />
        <span className="slug shrink-0 text-amber">Index ≠ market</span>
        {!oracle && (
          <span className="slug hidden shrink-0 text-amber sm:inline">
            Demo · all data simulated
          </span>
        )}
      </div>
    </footer>
  );
}
