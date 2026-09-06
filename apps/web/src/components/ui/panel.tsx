/**
 * TuiPanel — the world's frame: a 1px box with the function title on its
 * top rule. The filler line after the title is the box-drawing stroke
 * continued; `no` is the panel's address, `meta`/`right` sit at the rule's
 * far end. Amber is the function hue: the address and title wear it.
 */

import type { ReactNode } from "react";

export interface TuiPanelProps {
  /** Panel address: "01". */
  no?: string;
  /** ReactNode so pair/benchmark titles can keep canonical casing in caps copy. */
  title: ReactNode;
  /** Small note just after the title, before the filler rule. */
  note?: string;
  meta?: ReactNode;
  /** Control cluster pinned to the rule's right end (tabs, links). */
  right?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function TuiPanel({
  no,
  title,
  note,
  meta,
  right,
  className = "",
  bodyClassName = "",
  children,
}: TuiPanelProps) {
  return (
    <section className={`border border-rule-strong bg-panel ${className}`}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-rule px-3 py-1.5">
        {no ? (
          <span className="num text-[12px] font-bold leading-none text-amber">{no}</span>
        ) : null}
        <h2 className="slug font-extrabold text-amber">{title}</h2>
        {note ? <span className="slug text-dim">{note}</span> : null}
        <span aria-hidden className="h-px min-w-4 flex-1 bg-rule" />
        {meta ? <span className="num text-[10px] text-dim">{meta}</span> : null}
        {right ? (
          /* ml-auto is inert on one line (the filler owns the slack) and
             right-aligns the cluster when a narrow viewport wraps it. */
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
            {right}
          </div>
        ) : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
