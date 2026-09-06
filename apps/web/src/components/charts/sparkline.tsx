"use client";

/**
 * Sparkline — one market's recent trace at board scale, drawn in the data
 * phosphor. Movement is carried by the change cells beside it, never by the
 * trace's color; the live end burns amber, the function hue.
 */

export function Sparkline({
  values,
  className,
  width = 112,
  height = 30,
  stretch = false,
}: {
  values: number[];
  /** When set, the SVG scales to the box (viewBox locked to 112×30). */
  className?: string;
  width?: number;
  height?: number;
  /** Fill the whole box, distorting the aspect — for slots whose width is
   *  fluid (a rail row), where letterboxing would read as broken. */
  stretch?: boolean;
}) {
  if (values.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]!);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={stretch ? "none" : undefined}
      width={className ? undefined : width}
      height={className ? undefined : height}
      className={className}
      aria-hidden
      role="presentation"
    >
      <path
        d={d}
        fill="none"
        stroke="var(--ph-data)"
        strokeWidth={1.25}
        strokeLinecap="square"
        strokeLinejoin="round"
        vectorEffect={stretch ? "non-scaling-stroke" : undefined}
      />
      <circle cx={lastX} cy={lastY} r={2} fill="var(--color-amber)" />
    </svg>
  );
}
