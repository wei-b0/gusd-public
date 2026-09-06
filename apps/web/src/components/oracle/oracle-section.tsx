"use client";

/**
 * The tabbed Oracle section — Overview | Benchmarks | Methodology | Health |
 * Developers. Tabpanels stay mounted when hidden (the gUSD precedent), so a
 * selected benchmark, a chart range, or a loaded receipt survives a tab
 * switch.
 *
 * Deep links: ?tab=&bench= is adopted by a Suspense-wrapped sync child (the
 * only useSearchParams on the route — the boundary keeps the prerendered
 * page buildable), and in-page switches mirror back into the URL with
 * history.replaceState — no navigation, no refetch, back-button-friendly.
 * bench is only mirrored on the benchmarks tab (it means nothing elsewhere)
 * and only when it differs from the default.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { parseAssetId, type AssetId } from "@/domain/types";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import { OverviewTab } from "@/components/oracle/overview-tab";
import { BenchmarksTab } from "@/components/oracle/benchmarks-tab";
import { MethodologyTab } from "@/components/oracle/methodology-tab";
import { HealthTab } from "@/components/oracle/health-tab";
import { DevelopersTab } from "@/components/oracle/developers-tab";
import { TabBar, type TabEntry } from "@/components/ui/tab-bar";

const TABS = ["overview", "benchmarks", "methodology", "health", "developers"] as const;
type OracleTab = (typeof TABS)[number];

const TAB_LABELS: Record<OracleTab, string> = {
  overview: "Overview",
  benchmarks: "Benchmarks",
  methodology: "Methodology",
  health: "Health",
  developers: "Developers",
};

const TAB_ENTRIES: readonly TabEntry[] = TABS.map((id) => ({ id, label: TAB_LABELS[id] }));

function isTab(value: string | null): value is OracleTab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

export function OracleSection() {
  const [tab, setTab] = useState<OracleTab>("overview");
  const [bench, setBench] = useState<AssetId>("H100");

  /** Adopt deep-link params; unknown values fall back to the current state. */
  const adopt = useCallback((nextTab: string | null, nextBench: string | null) => {
    if (isTab(nextTab)) setTab((cur) => (cur === nextTab ? cur : nextTab));
    if (nextBench !== null) {
      const id = parseAssetId(nextBench);
      if (id !== null && id in ORACLE_PANELS) setBench((cur) => (cur === id ? cur : id));
    }
  }, []);

  /** Mirror an in-page switch into the URL without navigating. */
  const mirror = useCallback((t: OracleTab, b: AssetId) => {
    const qs =
      t === "overview"
        ? ""
        : `?tab=${t}${t === "benchmarks" && b !== "H100" ? `&bench=${b}` : ""}`;
    window.history.replaceState(null, "", `/oracle${qs}`);
  }, []);

  const switchTab = useCallback(
    (next: string) => {
      if (!isTab(next)) return;
      setTab((cur) => {
        if (cur !== next) mirror(next, bench);
        return next;
      });
    },
    [bench, mirror],
  );

  const switchBench = useCallback(
    (id: AssetId) => {
      setBench((cur) => {
        if (cur !== id) mirror(tab, id);
        return id;
      });
    },
    [tab, mirror],
  );

  return (
    <div>
      <Suspense fallback={null}>
        <OracleParamSync adopt={adopt} />
      </Suspense>
      <TabBar tabs={TAB_ENTRIES} active={tab} onChange={switchTab} label="Oracle sections" />

      <div role="tabpanel" hidden={tab !== "overview"} className="mt-5">
        <OverviewTab />
      </div>
      <div role="tabpanel" hidden={tab !== "benchmarks"} className="mt-5">
        <BenchmarksTab bench={bench} onBench={switchBench} />
      </div>
      <div role="tabpanel" hidden={tab !== "methodology"} className="mt-5">
        <MethodologyTab />
      </div>
      <div role="tabpanel" hidden={tab !== "health"} className="mt-5">
        <HealthTab />
      </div>
      <div role="tabpanel" hidden={tab !== "developers"} className="mt-5">
        <DevelopersTab />
      </div>
    </div>
  );
}

/**
 * Reads ?tab=&bench= and adopts changes. Keyed on the query string so a
 * same-route navigation (the command line while already on /oracle) adopts
 * too — query changes do not remount this route.
 */
function OracleParamSync({ adopt }: { adopt: (tab: string | null, bench: string | null) => void }) {
  const params = useSearchParams();
  const prev = useRef<string | null>(null);

  useEffect(() => {
    const qs = params.toString();
    if (prev.current === qs) return;
    prev.current = qs;
    adopt(params.get("tab"), params.get("bench"));
  }, [params, adopt]);

  return null;
}
