/**
 * Minimal ambient typings for the self-hosted TradingView Advanced Charts
 * library (public/charting_library/, CL v31.2.0). The licensed distribution
 * ships no TypeScript declarations; this types exactly the surface we call —
 * the widget constructor, the three chart methods we drive, and the
 * datafeed contract the library calls back into. Everything else stays
 * `unknown` on purpose: a wider surface typed loosely would invite drift
 * from the library's own runtime contract.
 */

/** One OHLC bar. `time` is the bar's interval open **in epoch milliseconds**
 *  — the library consumes bar times as ms (its reference datafeeds pass
 *  ms open times straight through), while history-request periodParams are
 *  seconds. */
export interface TvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** History request window. `from`/`to` are epoch seconds; `countBack` is the
 *  minimum bars the chart actually wants; `firstDataRequest` is true for the
 *  chart's initial load. */
export interface TvPeriodParams {
  from: number;
  to: number;
  countBack: number;
  firstDataRequest: boolean;
}

/** Symbol description the chart renders titles/axes/legend from. No volume
 *  fields — benchmark candles are OHLC-only until real swap volume exists. */
export interface TvSymbolInfo {
  ticker: string;
  name: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: string;
  pricescale: number;
  minmov: number;
  has_intraday: boolean;
  has_daily: boolean;
  supported_resolutions: string[];
  data_status: "streaming" | "endofday" | "delayed_streaming";
}

/** Datafeed configuration delivered from the onReady callback. The library
 *  stores it as its global `configurationData` and reads
 *  `configurationData.is_tradingview_data` unguarded in this build — a bare
 *  `callback()` crashes session/resolution handling, so onReady must always
 *  deliver a config object. */
export interface TvDatafeedConfiguration {
  supported_resolutions: string[];
  supports_search?: boolean;
  supports_group_request?: boolean;
  supports_marks?: boolean;
  supports_timescale_marks?: boolean;
  supports_time?: boolean;
}

export interface TvDatafeedChartApi {
  onReady(callback: (configurationData: TvDatafeedConfiguration) => void): void;
  resolveSymbol(
    symbolName: string,
    onResolve: (symbolInfo: TvSymbolInfo) => void,
    onError: (reason: string) => void,
  ): void;
  getBars(
    symbolInfo: TvSymbolInfo,
    resolution: string,
    periodParams: TvPeriodParams,
    onHistory: (bars: TvBar[], meta: { noData: boolean }) => void,
    onError: (reason: string) => void,
  ): void;
  subscribeBars(
    symbolInfo: TvSymbolInfo,
    resolution: string,
    onTick: (bar: TvBar) => void,
    listenerGuid: string,
  ): void;
  unsubscribeBars(listenerGuid: string): void;
  getServerTime?(callback: (serverTime: number) => void): void;
}

/** The widget methods we drive. Reset/reload lives on the active chart. */
export interface TvWidgetApi {
  onChartReady(callback: () => void): void;
  activeChart(): {
    setResolution(resolution: string, timeout?: boolean | object): void;
    resetData(): void;
  };
  remove(): void;
}

/** The standalone bundle defines the global directly (`var TradingView=…`)
 *  and exposes `version` + `widget` — there is no `TradingView.charting_library`
 *  namespace in this distribution. */
declare global {
  interface Window {
    TradingView?: {
      version: string;
      widget: new (options: Record<string, unknown>) => TvWidgetApi;
    };
  }
}

export {};
