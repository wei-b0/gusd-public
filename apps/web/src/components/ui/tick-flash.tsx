"use client";

/**
 * TickFlash — a figure that re-prints when its displayed value moves.
 *
 * The cell flashes once via a keyed remount: the new value mounts with the
 * pulse running — brighter ink over one wash of the role color. "move"
 * flashes up/down; "wire" flashes cyan either way, keeping the hue
 * quarantine. Change is judged on the printed datum (`precision`), so
 * sub-display jitter never flashes, and a rapid re-tick restarts the one
 * pulse rather than stacking. First render never flashes — a landing tick
 * does, not the initial print.
 *
 * A string value (the publication hash) carries no direction and flashes
 * wire on any change — it marks that data *arrived*, independent of any
 * price moving.
 *
 * `arrow` prints the tick's direction beside the figure: "pop" rides the
 * pulse and fades, absolutely positioned so no figure ever shifts (table
 * prices); "hold" keeps the last tick's direction on show until the next
 * one (the desk's hero price).
 */

import { useEffect, useRef } from "react";

export interface TickFlashProps {
  value: number | string;
  className?: string;
  /** "move" (default) flashes up/down; "wire" flashes cyan either way. */
  flash?: "move" | "wire";
  /** Decimal places the figure prints at; the flash is judged there. */
  precision?: number;
  /** Direction glyph beside the figure: "pop" fades with the pulse, "hold"
   *  stays until the next tick. */
  arrow?: "pop" | "hold";
  children: React.ReactNode;
}

export function TickFlash({
  value,
  className = "",
  flash = "move",
  precision,
  arrow,
  children,
}: TickFlashProps) {
  // The printed datum is what the desk read: quantize to display precision
  // so a change invisible at print time never flashes. Strings (hashes)
  // pass through whole — they change only when data truly lands.
  const printed: number | string =
    typeof value === "number" && precision !== undefined
      ? Number(value.toFixed(precision))
      : value;
  const prev = useRef<number | string | null>(null);
  const changed = prev.current !== null && printed !== prev.current;
  // Guard the numeric diff: Math.sign(NaN) is truthy, which would flash on
  // every render. Strings have no direction — they only mark arrival.
  const dir =
    changed && typeof printed === "number" && typeof prev.current === "number"
      ? Math.sign(printed - prev.current)
      : 0;

  // The held arrow outlives each keyed remount, so it lives on the component;
  // this tick's direction prints with the remount — a frame is too late.
  const lastDir = useRef(0);
  const shownDir = dir !== 0 ? dir : lastDir.current;

  // The pulse's class must outlive the tick's render. Every landing of ANY
  // panel re-renders the whole table, and dropping the class on those
  // unrelated re-renders would cancel the running CSS animation a few
  // hundred ms in — the "flash appears, then an immediate refresh erases
  // it" bug. So the tone sticks until the next tick (a completed animation
  // holds its final keyframe — transparent — and a same-value class never
  // restarts one; only the keyed remount at the next tick does).
  const toneRef = useRef("");
  const tone = changed
    ? flash === "wire"
      ? "flash-wire"
      : dir > 0
        ? "flash-up"
        : dir < 0
          ? "flash-down"
          : ""
    : toneRef.current;

  useEffect(() => {
    if (dir !== 0) lastDir.current = dir;
    if (changed) {
      toneRef.current =
        flash === "wire" ? "flash-wire" : dir > 0 ? "flash-up" : dir < 0 ? "flash-down" : "";
    }
    prev.current = printed;
  }, [changed, dir, flash, printed]);
  return (
    <span
      key={printed}
      className={`${className} ${tone} ${arrow === "pop" ? "relative" : ""}`.trim()}
    >
      {children}
      {arrow === "pop" && tone !== "" && (
        <span aria-hidden className="tick-pop">
          {shownDir > 0 ? "▲" : "▼"}
        </span>
      )}
      {arrow === "hold" && (
        <span
          aria-hidden
          className={`tick-hold ${shownDir > 0 ? "text-up" : shownDir < 0 ? "text-down" : "opacity-0"}`}
        >
          {shownDir >= 0 ? "▲" : "▼"}
        </span>
      )}
    </span>
  );
}
