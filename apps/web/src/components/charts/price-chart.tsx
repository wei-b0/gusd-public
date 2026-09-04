"use client";

/**
 * PriceChart — the dominant plate.
 *
 * TradingView Lightweight Charts renders the market as candles; the Index
 * runs as the wire line; the basis band between market close and Index is
 * drawn by a series primitive as a flat translucent tint — amber for
 * premium, cyan for discount. Terminal dark theme throughout.
 */

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  ChartOptions,
  DeepPartial,
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartRange, IndexPoint } from "@/domain/types";
import { fmtAxisTime, fmtGusdLegend, fmtPctSigned, fmtUsdLegend } from "@/domain/format";

export interface PriceChartProps {
  candles: Candle[];
  index: IndexPoint[];
  range: ChartRange;
  /** Live market price; when it moves, the last candle's close re-engraves. */
  livePrice?: number;
  className?: string;
}

const TEXT = "#3ecf72";
const TEXT_MUTE = "#2a9455";
const WIRE = "#45d4e8";
const RULE = "#24402e";
const GRID = "rgba(26, 43, 32, 0.55)";
const CROSSHAIR = "#3a6a4a";
const UP = "#66f79a";
const DOWN = "#ff6b63";
/** Strokes the market-close edge of the basis band. */
const BOUNDARY = "rgba(102, 247, 154, 0.30)";

interface LegendState {
  o: number;
  h: number;
  l: number;
  c: number;
  idx: number;
  basisPct: number;
}

const CHART_BASE: DeepPartial<ChartOptions> = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: "transparent" },
    textColor: TEXT_MUTE,
    fontSize: 10,
    fontFamily: "var(--font-jb), ui-monospace, 'SF Mono', monospace",
    attributionLogo: false,
  },
  grid: {
    vertLines: { color: GRID },
    horzLines: { color: GRID },
  },
  rightPriceScale: { borderColor: RULE },
  timeScale: { borderColor: RULE, timeVisible: true, secondsVisible: false },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: CROSSHAIR, width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: RULE },
    horzLine: { color: CROSSHAIR, width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: RULE },
  },
};

function toChartTime(t: number): UTCTimestamp {
  return Math.floor(t / 1000) as UTCTimestamp;
}

/**
 * The basis band: a series primitive on the wire line that fills the area
 * between market close and Index as a flat translucent tint — amber for
 * premium, cyan for discount — and strokes the market-close boundary. Sits
 * under the series ink (zOrder "bottom").
 */
class BasisBand implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<"Line"> | null = null;
  private chart: IChartApi | null = null;
  private source: () => { candles: Candle[]; index: IndexPoint[] } = () => ({ candles: [], index: [] });

  constructor(source: () => { candles: Candle[]; index: IndexPoint[] }) {
    this.source = source;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series as ISeriesApi<"Line">;
    this.chart = param.chart;
  }

  detached(): void {
    this.series = null;
    this.chart = null;
  }

  setSource(source: () => { candles: Candle[]; index: IndexPoint[] }): void {
    this.source = source;
  }

  paneViews(): IPrimitivePaneView[] {
    return [new BasisBandPaneView(this)];
  }

  updateAllViews(): void {
    // Views read live state at draw time; nothing to precompute.
  }

  /** Fills the premium/discount band between market close and Index. */
  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return;
    const { candles, index } = this.source();
    const n = Math.min(candles.length, index.length);
    if (n < 2) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(n - 1, Math.ceil(range.to));
    if (to - from < 1) return;

    target.useBitmapCoordinateSpace(
      ({ context, horizontalPixelRatio, verticalPixelRatio }) => {
        const pts: BandPt[] = [];
        for (let k = from; k <= to; k++) {
          const candle = candles[k];
          const wire = index[k];
          const x = ts.logicalToCoordinate(k as Logical);
          if (!candle || !wire || x == null) continue;
          const m = series.priceToCoordinate(candle.close);
          const i = series.priceToCoordinate(wire.value);
          if (m == null || i == null) continue;
          pts.push({
            x: x * horizontalPixelRatio,
            m: m * verticalPixelRatio,
            i: i * verticalPixelRatio,
          });
        }
        if (pts.length < 2) return;
        drawBandSegments(context, pts, horizontalPixelRatio);
      },
    );
  }
}

class BasisBandPaneView implements IPrimitivePaneView {
  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  constructor(private band: BasisBand) {}

  renderer(): IPrimitivePaneRenderer {
    return { draw: (target: CanvasRenderingTarget2D) => this.band.draw(target) };
  }
}

/** One sampled coordinate pair in bitmap pixels. */
interface BandPt {
  x: number;
  m: number;
  i: number;
}

/** Fills each same-sign run of the band; crossings are interpolated. */
function drawBandSegments(
  ctx: CanvasRenderingContext2D,
  pts: BandPt[],
  hr: number,
): void {
  const premium = "rgba(255, 176, 0, 0.10)";
  const discount = "rgba(69, 212, 232, 0.09)";
  let s = 0;
  while (s < pts.length - 1) {
    const first = pts[s]!;
    // Canvas y grows downward: market above the wire (m < i) is a premium.
    const sign = Math.sign(first.i - first.m) || 1;
    let e = s + 1;
    while (e < pts.length && (Math.sign(pts[e]!.i - pts[e]!.m) || 1) === sign) e++;
    const run = pts.slice(s, e);
    const top: BandPt[] = [...run];
    if (e < pts.length) {
      const a = run[run.length - 1]!;
      const b = pts[e]!;
      const da = a.m - a.i;
      const db = b.m - b.i;
      const f = da / (da - db);
      const xc = a.x + (b.x - a.x) * f;
      const yc = a.m + (b.m - a.m) * f;
      top.push({ x: xc, m: yc, i: yc });
    }
    const bottom: BandPt[] = top
      .map((p) => ({ x: p.x, m: p.i, i: p.m }))
      .reverse();
    fillBandPolygon(ctx, top, bottom, sign > 0 ? premium : discount);
    strokeMarketBoundary(ctx, top, hr);
    if (e >= pts.length) break;
    s = e - 1;
  }
}

function fillBandPolygon(
  ctx: CanvasRenderingContext2D,
  top: BandPt[],
  bottom: BandPt[],
  fill: string,
): void {
  ctx.beginPath();
  ctx.moveTo(top[0]!.x, top[0]!.m);
  for (const p of top) ctx.lineTo(p.x, p.m);
  for (const p of bottom) ctx.lineTo(p.x, p.m);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeMarketBoundary(
  ctx: CanvasRenderingContext2D,
  pts: BandPt[],
  hr: number,
): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.m);
  for (const p of pts) ctx.lineTo(p.x, p.m);
  ctx.strokeStyle = BOUNDARY;
  ctx.lineWidth = hr;
  ctx.stroke();
}

export function PriceChart({ candles, index, range, livePrice, className }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const wireRef = useRef<ISeriesApi<"Line"> | null>(null);
  const dataRef = useRef({ candles, index });
  dataRef.current = { candles, index };
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [legend, setLegend] = useState<LegendState | null>(null);

  // The chart is created once per mount; paper theme, series, primitive.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      ...CHART_BASE,
      timeScale: {
        ...CHART_BASE.timeScale,
        tickMarkFormatter: (time: Time) => {
          const ms = Number(time) * 1000;
          return fmtAxisTime(ms, rangeRef.current);
        },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const wireSeries = chart.addSeries(LineSeries, {
      color: WIRE,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const band = new BasisBand(() => dataRef.current);
    wireSeries.attachPrimitive(band);

    chartRef.current = chart;
    candleRef.current = candleSeries;
    wireRef.current = wireSeries;

    chart.subscribeCrosshairMove((param) => {
      const { candles, index } = dataRef.current;
      if (!param.time) {
        setLegend(legendFor(candles, index, candles.length - 1));
        return;
      }
      const i = candles.findIndex((c) => Math.floor(c.t / 1000) === Number(param.time));
      if (i >= 0 && index[i]) setLegend(legendFor(candles, index, i));
      else setLegend(legendFor(candles, index, candles.length - 1));
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      wireRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data lands whenever the snapshot changes; the plate re-engraves.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    const wireSeries = wireRef.current;
    if (!chart || !candleSeries || !wireSeries) return;

    candleSeries.setData(
      candles.map((c) => ({
        time: toChartTime(c.t),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    wireSeries.setData(index.map((p) => ({ time: toChartTime(p.t), value: p.value })));

    // Full range with breathing room: the live candle must never clip the seam.
    const pad = Math.max(0.6, candles.length * 0.03);
    chart.timeScale().setVisibleLogicalRange({ from: -0.6, to: candles.length - 1 + pad });
    setLegend(legendFor(candles, index, candles.length - 1));
  }, [candles, index, range]);

  // Live price: the last candle's close re-engraves as the tape prints.
  useEffect(() => {
    const candleSeries = candleRef.current;
    const last = candles[candles.length - 1];
    if (!candleSeries || !last || livePrice == null) return;
    candleSeries.update({
      time: toChartTime(last.t),
      open: last.open,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      close: livePrice,
    });
  }, [livePrice, candles]);

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      {legend && (
        <div className="pointer-events-none absolute left-3 top-2 z-10 flex flex-wrap items-baseline gap-x-3.5 gap-y-1 border border-rule bg-panel/90 px-2.5 py-1.5">
          <LegendCell label="O" value={fmtGusdLegend(legend.o)} />
          <LegendCell label="H" value={fmtGusdLegend(legend.h)} />
          <LegendCell label="L" value={fmtGusdLegend(legend.l)} />
          <LegendCell label="C" value={fmtGusdLegend(legend.c)} />
          <span aria-hidden className="h-3.5 w-px bg-rule-strong" />
          <LegendCell label="Index" value={fmtUsdLegend(legend.idx)} tone="wire" />
          <LegendCell
            label="Premium / Discount"
            value={fmtPctSigned(legend.basisPct)}
            tone={legend.basisPct >= 0 ? "amber" : "wire"}
          />
        </div>
      )}
    </div>
  );
}

function LegendCell({ label, value, tone }: { label: string; value: string; tone?: "wire" | "amber" }) {
  const color = tone === "wire" ? "text-wire" : tone === "amber" ? "text-amber" : "text-data";
  return (
    <span className="flex items-baseline gap-1">
      <span className="slug text-[9px] text-dim">{label}</span>
      <span className={`num text-[11px] ${color}`}>{value}</span>
    </span>
  );
}

function legendFor(candles: Candle[], index: IndexPoint[], i: number): LegendState | null {
  const candle = candles[i];
  const wire = index[i];
  if (!candle || !wire) return null;
  return {
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    idx: wire.value,
    basisPct: (candle.close / wire.value - 1) * 100,
  };
}


