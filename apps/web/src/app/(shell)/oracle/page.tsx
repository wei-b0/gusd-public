/**
 * Oracle — GPU compute benchmarks and the protocol's reference prices. A thin
 * shell over the tabbed section: the header renders statically, and the
 * section's own Suspense boundary hosts the deep-link sync (the route's only
 * useSearchParams), keeping this page prerenderable.
 */

import { OracleSection } from "@/components/oracle/oracle-section";

export default function OraclePage() {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Oracle</h1>
        <p className="slug text-dim">Live GPU compute benchmarks · protocol reference prices · public data</p>
      </div>
      <OracleSection />
    </div>
  );
}
