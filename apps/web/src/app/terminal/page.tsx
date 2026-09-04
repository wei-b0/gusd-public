import type { Metadata } from "next";
import { TerminalDesk } from "@/components/terminal/terminal-desk";

export const metadata: Metadata = {
  title: "Terminal — gUSD",
};

/** The professional desk, opened on the top-volume market. */
export default function TerminalPage() {
  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Terminal</h1>
        <p className="slug text-dim">Professional desk · analyse and execute</p>
      </div>
      <TerminalDesk initial="H100" />
    </div>
  );
}
