"use client";

/**
 * CodeBlock — a code sample with its language slug and a COPY key. The copy
 * flash follows the house grammar (COPY → COPIED, self-clearing).
 */

import { useEffect, useRef, useState } from "react";

export function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function copy() {
    try {
      void navigator.clipboard.writeText(code).then(
        () => {
          if (timer.current) clearTimeout(timer.current);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 1_600);
        },
        () => {},
      );
    } catch {
      // Clipboard unavailable (insecure context) — the sample stays readable.
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 border-b border-rule px-3.5 py-2">
        <span className="slug text-dim">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="slug text-dim transition-colors hover:text-amber"
        >
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>
      <pre className="num overflow-x-auto p-3.5 text-[11px] leading-[1.65] text-data">{code}</pre>
    </div>
  );
}
