"use client";

/**
 * TvPriceChart — the dominant plate, rendered by TradingView Advanced Charts
 * (self-hosted, public/charting_library/).
 *
 * The component owns nothing about the data: a custom datafeed
 * (src/data/oracle/tv-feed.ts) serves history from the oracle's
 * server-bucketed /candles endpoint and realtime from the shared feed store,
 * so the chart renders exactly what the backend computes — no client-side
 * OHLC, no smoothing, no chart-side reconciliation. The widget's own chrome
 * is disabled (header/toolbars) because the TuiPanel head and the interval
 * selector above it ARE the chart's chrome; the built-in legend is kept and
 * restyled through custom-theme.css to the terminal's phosphor palette.
 *
 * Mount discipline: the desk hides-but-does-not-unmount chart cells on
 * mobile (hidden ≠ unmounted), and an iframe created at 0×0 is the classic
 * blank pane — so the widget is created on the first measurable size
 * (ResizeObserver), not on mount.
 */

import { useEffect, useRef, useState } from "react";
import type { AssetId, ChartRange } from "@/domain/types";
import { RANGE_INTERVAL_SEC } from "@/domain/types";
import type { TvWidgetApi } from "@/types/tradingview";
import { DATA_SOURCE } from "@/data/oracle/config";
import { createOracleClient } from "@/data/oracle/client";
import { getOracleFeed } from "@/data/oracle/feed";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import type { TvDatafeedHandle } from "@/data/oracle/tv-feed";
import { createTvDatafeed, tvResolution } from "@/data/oracle/tv-feed";
import { useServices } from "@/data/services";
import { loadTradingView } from "./tv-loader";

export interface TvPriceChartProps {
  asset: AssetId;
  range: ChartRange;
  className?: string;
}

/**
 * The widget's fixed configuration. Palette literals, not CSS variables —
 * the widget renders in an iframe that does not inherit the app's custom
 * properties (same reason custom-theme.css restates them). Values are the
 * chart theme contract in DESIGN.md: phosphor text, borderless candles,
 * dotted crosshair/price line, grid at the rule color.
 */
const WIDGET_BASE = {
  library_path: "/charting_library/",
  locale: "en",
  timezone: "Etc/UTC",
  theme: "dark",
  autosize: true,
  custom_css_url: "custom-theme.css",
  custom_font_family: "JetBrains Mono",
  loading_screen: { backgroundColor: "#090e0b", foregroundColor: "#2a9455" },
  // The TuiPanel head + interval selector are our chrome; the drawing tools,
  // search, and persistence have no place on a read-only index plate. No
  // settings localStorage — a fresh terminal every load. The two
  // create_volume_indicator featuresets are the documented way to keep the
  // widget from attaching its default Volume study — benchmark candles are
  // OHLC-only until real swap volume exists (see DESIGN.md).
  disabled_features: [
    "header_widget",
    "timeframes_toolbar",
    "left_toolbar",
    "control_bar",
    "symbol_search_hotkey",
    "compare_symbol",
    "use_localstorage_for_settings",
    "study_templates",
    "show_object_tree",
    "show_chart_property_page",
    "legend_context_menu",
    "create_volume_indicator_by_default",
    "create_volume_indicator_by_default_once",
  ],
  enabled_features: ["legend_widget"],
  overrides: {
    "paneProperties.background": "#090e0b",
    "paneProperties.backgroundType": "solid",
    "paneProperties.vertGridProperties.color": "rgba(26, 43, 32, 0.55)",
    "paneProperties.horzGridProperties.color": "rgba(26, 43, 32, 0.55)",
    "paneProperties.crossHairProperties.color": "#3a6a4a",
    "paneProperties.crossHairProperties.style": 2,
    "paneProperties.crossHairProperties.width": 1,
    // Crosshair label background is theme-driven in this build (not
    // overrides-reachable) — `theme: "dark"` picks TV's dark label.
    "scalesProperties.textColor": "#2a9455",
    "scalesProperties.lineColor": "#24402e",
    "scalesProperties.fontSize": 10,
    "mainSeriesProperties.style": 1,
    "mainSeriesProperties.candleStyle.upColor": "#66f79a",
    "mainSeriesProperties.candleStyle.downColor": "#ff6b63",
    "mainSeriesProperties.candleStyle.borderUpColor": "#66f79a",
    "mainSeriesProperties.candleStyle.borderDownColor": "#ff6b63",
    "mainSeriesProperties.candleStyle.wickUpColor": "#66f79a",
    "mainSeriesProperties.candleStyle.wickDownColor": "#ff6b63",
    "mainSeriesProperties.candleStyle.drawBorder": false,
    // This CL build names the price-line switch `showPriceLine` and does not
    // expose the line style — the build's own (dotted) style stands.
    // (Its `showSeriesLastValue` path does not exist — the last-value tag is
    // always shown for a streaming price series.)
    "mainSeriesProperties.showPriceLine": true,
    "mainSeriesProperties.priceLineWidth": 1,
    "mainSeriesProperties.priceLineColor": "#3a6a4a",
  },
} as const;

/** True once the container has measurable size — the create gate for the
 *  desk's hidden-but-mounted mobile tab. */
function useElementVisible(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      setVisible(true);
      return;
    }
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}

export function TvPriceChart({ asset, range, className }: TvPriceChartProps) {
  // Read at render, not inside the effect — hooks don't belong in effects,
  // and the services singleton is stable for the page's lifetime.
  const marketData = useServices().marketData;
  const wrapperRef = useRef<HTMLDivElement>(null);
  // The widget's own div: React mounts it once and never reconciles its
  // children — TV populates it with the iframe, and mixing React-managed
  // nodes into it is the classic removeChild teardown crash.
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TvWidgetApi | null>(null);
  const datafeedRef = useRef<TvDatafeedHandle | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rangeRef = useRef(range);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const visible = useElementVisible(wrapperRef);

  // Create once per asset, on the first measurable size.
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    const container = containerRef.current;
    if (!container) return;

    // The oracle settles every listed class; the fallback keeps a mock-only
    // asset resolvable as a symbol rather than crashing the mount.
    const gpuId = ORACLE_PANELS[asset]?.gpuId ?? asset;
    const deps =
      DATA_SOURCE === "mock"
        ? ({ mode: "mock", port: marketData } as const)
        : ({ mode: "oracle", feed: getOracleFeed(), client: createOracleClient() } as const);
    const handle = createTvDatafeed(deps, {
      asset,
      gpuId,
      onSeriesReset: (intervalSec) => {
        // A resync re-bucketed history server-side: reload from the source
        // of truth. Debounced — a resync burst lands as several commits, and
        // only the chart's own interval may react.
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => {
          resetTimerRef.current = null;
          if (RANGE_INTERVAL_SEC[rangeRef.current] === intervalSec) {
            widgetRef.current?.activeChart().resetData();
          }
        }, 500);
      },
    });
    datafeedRef.current = handle;

    void loadTradingView()
      .then((TradingView) => {
        if (disposed) return;
        const widget = new TradingView.widget({
          ...WIDGET_BASE,
          container,
          symbol: gpuId,
          interval: tvResolution(rangeRef.current),
          datafeed: handle.datafeed,
        });
        widgetRef.current = widget;
        widget.onChartReady(() => {
          if (!disposed) setReady(true);
        });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
      // Unsubscribe the datafeed from the store before the widget goes, so
      // a late commit never touches a torn-down chart.
      handle.dispose();
      datafeedRef.current = null;
      widgetRef.current?.remove();
      widgetRef.current = null;
      setReady(false);
    };
  }, [visible, asset, marketData]);

  // The panel header's interval selector is the source of truth for the
  // grain; TV's own switcher is disabled, so this is the only path.
  useEffect(() => {
    rangeRef.current = range;
    if (!ready) return;
    widgetRef.current?.activeChart().setResolution(tvResolution(range), false);
  }, [range, ready]);

  return (
    <div ref={wrapperRef} className={`relative ${className ?? ""}`}>
      <div ref={containerRef} className="h-full w-full" />
      {!ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#090e0b]">
          <span className="slug text-dim">
            {failed ? "CHART LIBRARY UNAVAILABLE" : "LOADING SERIES…"}
          </span>
        </div>
      )}
    </div>
  );
}
