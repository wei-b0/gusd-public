"use client";

/**
 * IndexChart — the wire alone. A single cyan line tracing the gUSD Index
 * for one GPU-hour, with a crosshair legend. No candles, no basis band:
 * this plate exists to show the reference series itself.
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
import type { ChartRange, IndexPoint } from "@/domain/types";
import { fmtAxisTime, fmtUsdLegend } from "@/domain/format";

const TEXT_MUTE = "#2a9455";
const WIRE = "#45d4e8";
const RULE = "#24402e";
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

interface LegendState {
  idx: number;
  t: number;
}

export function IndexChart({
  points,
  range,
  className,
}: {
  points: IndexPoint[];
  range: ChartRange;
  className?: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [legend, setLegend] = useState<LegendState | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const chart = createChart(el, {
      ...CHART_BASE,
      // The wire moves in basis points; margins keep the line off the pane edges.
      rightPriceScale: { borderColor: RULE, scaleMargins: { top: 0.18, bottom: 0.18 } },
      timeScale: {
        ...CHART_BASE.timeScale,
        tickMarkFormatter: (time: Time) => fmtAxisTime(Number(time) * 1000, rangeRef.current),
      },
    });
    const series = chart.addSeries(LineSeries, {
      color: WIRE,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerBorderColor: WIRE,
      crosshairMarkerBackgroundColor: WIRE,
      // The Index walks basis points per day: without 4dp the whole day
      // rounds to one tick string and the scale prints no labels at all.
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
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
      setLegend({ idx: d.value, t: t * 1000 });
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
      points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.value })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [points, range]);

  const last = points[points.length - 1];

  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-3 top-2 z-10 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {legend ? (
          <>
            <span className="slug text-wire">Index</span>
            <span className="num text-[12px] font-bold text-wire">{fmtUsdLegend(legend.idx)}</span>
            <span className="num text-[10px] text-dim">{fmtAxisTime(legend.t, range)}</span>
          </>
        ) : last ? (
          <>
            <span className="slug text-wire">Index</span>
            <span className="num text-[12px] font-bold text-wire">{fmtUsdLegend(last.value)}</span>
            <span className="num text-[10px] text-dim">{fmtAxisTime(last.t, range)}</span>
          </>
        ) : null}
      </div>
      <div ref={holder} className={className} />
    </div>
  );
}
