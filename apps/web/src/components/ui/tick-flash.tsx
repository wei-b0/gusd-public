"use client";

/**
 * TickFlash — a figure that re-prints when its value moves.
 *
 * The cell flashes once via a keyed remount: the new value mounts with the
 * flash animation running. "move" flashes in the move color (up teal, down
 * red); "wire" flashes cyan for Index ticks, keeping the hue quarantine.
 * First render never flashes — a landing tick does, not the initial print.
 */

import { useEffect, useRef } from "react";

export interface TickFlashProps {
  value: number;
  className?: string;
  /** "move" (default) flashes up/down; "wire" flashes cyan either way. */
  flash?: "move" | "wire";
  children: React.ReactNode;
}

export function TickFlash({ value, className = "", flash = "move", children }: TickFlashProps) {
  const prev = useRef<number | null>(null);
  const dir =
    prev.current == null || value === prev.current ? 0 : Math.sign(value - prev.current);

  useEffect(() => {
    prev.current = value;
  }, [value]);

  const tone =
    flash === "wire"
      ? dir !== 0
        ? "flash-wire"
        : ""
      : dir > 0
        ? "flash-up"
        : dir < 0
          ? "flash-down"
          : "";
  return (
    <span key={value} className={`${className} ${tone}`.trim()}>
      {children}
    </span>
  );
}
