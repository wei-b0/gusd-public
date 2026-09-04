"use client";

/**
 * TabBar — the task switcher. On the dense surfaces it turns a phone's
 * sequential page into tasks; on the gUSD section it switches between the
 * two product flows on every viewport. The active task reverses amber.
 * Labels are ReactNode so pair/unit casing (gUSD, sGUSD) survives the slug
 * caps the same way it does everywhere else.
 */

import type { ReactNode } from "react";

export interface TabEntry {
  id: string;
  label: ReactNode;
}

export function TabBar({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly TabEntry[];
  active: string;
  onChange: (tab: string) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="grid grid-flow-col auto-cols-fr border border-rule-strong bg-panel"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`slug border-r border-rule py-2.5 transition-colors last:border-r-0 ${
            active === tab.id ? "rev" : "text-dim hover:text-data"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
