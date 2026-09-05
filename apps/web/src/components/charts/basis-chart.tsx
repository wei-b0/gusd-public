"use client";

/**
 * BasisChart — premium / discount history. One amber line tracing the gap
 * between the market and the Index over the selected range; the zero rule
 * separates premium (above) from discount (below). The crosshair legend
 * reads the gap at any point.
 */

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
} from "lightweight-charts";
import type {
  ChartOptions,
  DeepPartial,
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartRange, IndexPoint } from "@/domain/types";
import { fmtAxisTime, fmtPctSigned } from "@/domain/format";

const TEXT_MUTE = "#2a9455";
const AMBER = "#ffb000";
const RULE = "#24402e";
const ZERO = "#3a6a4a";
const GRID = "rgba(26, 43, 32, 0.55)";
const CROSSHAIR = "#3a6a4a";

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

export interface BasisPoint {
  t: number;
  pct: number;
}

/** Join tolerance: an Index publication is paired with the market close
 *  within an hour of it; beyond that the pair is meaningless. */
const BASIS_JOIN_TOLERANCE_MS = 3_600_000;

/** Zips the market's closes against the Index into a premium/discount series.
 *  Joins by nearest timestamp, not array position — the Index series carries
 *  real publication timestamps and may be sparse or short next to the market
 *  candles. Both series are time-ascending, so one forward walk pairs each
 *  candle with its closest Index point. */
export function buildBasisPoints(candles: Candle[], index: IndexPoint[]): BasisPoint[] {
  const pts: BasisPoint[] = [];
  let j = 0;
  for (const candle of candles) {
    while (
      j < index.length - 1 &&
      Math.abs(index[j]!.t - candle.t) > Math.abs(index[j + 1]!.t - candle.t)
    ) {
      j++;
    }
    const wire = index[j];
    if (!wire || Math.abs(wire.t - candle.t) > BASIS_JOIN_TOLERANCE_MS) continue;
    pts.push({ t: candle.t, pct: (candle.close / wire.value - 1) * 100 });
  }
  return pts;
}

export function BasisChart({
  points,
  range,
  className,
}: {
  points: BasisPoint[];
  range: ChartRange;
  className?: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [legend, setLegend] = useState<{ pct: number; t: number } | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const chart = createChart(el, {
      ...CHART_BASE,
      // The gap lives in whole-percent territory; margins keep both edges clear.
      rightPriceScale: { borderColor: RULE, scaleMargins: { top: 0.24, bottom: 0.24 } },
      timeScale: {
        ...CHART_BASE.timeScale,
        tickMarkFormatter: (time: Time) => fmtAxisTime(Number(time) * 1000, rangeRef.current),
      },
    });
    const series = chart.addSeries(LineSeries, {
      color: AMBER,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerBorderColor: AMBER,
      crosshairMarkerBackgroundColor: AMBER,
      priceFormat: { type: "percent", precision: 2, minMove: 0.01 },
    });
    // The zero rule: above it a premium, below it a discount.
    series.createPriceLine({
      price: 0,
      color: ZERO,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const onMove = (param: MouseEventParams<Time>) => {
      if (param.logical === undefined || param.point === undefined) {
        setLegend(null);
        return;
      }
      const d = param.seriesData.get(series) as { value: number } | undefined;
      const t = param.time as UTCTimestamp;
      if (!d || typeof t !== "number") {
        setLegend(null);
        return;
      }
      setLegend({ pct: d.value, t: t * 1000 });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Re-plot when the data (range or asset) changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(
      points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.pct })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [points, range]);

  const last = points[points.length - 1];

  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-3 top-2 z-10 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {legend ? (
          <>
            <span className={`slug ${legend.pct >= 0 ? "text-amber" : "text-wire"}`}>
              {legend.pct >= 0 ? "Premium" : "Discount"}
            </span>
            <span className="num text-[12px] font-bold text-amber">{fmtPctSigned(legend.pct)}</span>
            <span className="num text-[10px] text-dim">{fmtAxisTime(legend.t, range)}</span>
          </>
        ) : last ? (
          <>
            <span className={`slug ${last.pct >= 0 ? "text-amber" : "text-wire"}`}>
              {last.pct >= 0 ? "Premium" : "Discount"}
            </span>
            <span className="num text-[12px] font-bold text-amber">{fmtPctSigned(last.pct)}</span>
            <span className="num text-[10px] text-dim">{fmtAxisTime(last.t, range)}</span>
          </>
        ) : null}
      </div>
      <div ref={holder} className={className} />
    </div>
  );
}
