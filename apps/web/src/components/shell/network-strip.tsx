"use client";

/**
 * NetworkStrip — the one persistent shell element the wallet layer adds. A
 * wallet parked on a foreign chain silently breaks every signing action, so
 * that condition earns a global surface: a full-width amber system strip
 * under the SystemBar while `connected && networkOk === false`. Amber system
 * speech; SWITCH drives the port's switchChain (adding the chain when the
 * wallet lacks it); DISMISS yields until the condition clears and returns.
 */

import { useEffect, useState } from "react";
import { useServices, useWalletSession } from "@/data/services";
import { getActiveChain } from "@/data/web3/chains";

export function NetworkStrip() {
  const { auth } = useServices();
  const session = useWalletSession();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const wrongNetwork = session.status === "connected" && session.networkOk === false;

  // Dismissal is per-condition: a resolved switch, a chain change, or a new
  // session brings the strip back when the condition returns.
  useEffect(() => {
    if (!wrongNetwork) setDismissed(false);
  }, [wrongNetwork]);

  if (!wrongNetwork || dismissed) return null;

  const active = getActiveChain();

  async function switchBack() {
    setBusy(true);
    try {
      // A declined switch leaves the wallet where it was — the strip stays.
      await auth.switchChain(active.id);
    } catch {
      // The strip is the error surface; nothing to add.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="status" className="border-b border-amber/40 bg-amber/10">
      <div className="mx-auto flex w-full max-w-360 items-center justify-between gap-3 px-3 py-1.5 md:px-5">
        <p className="slug truncate text-amber">
          Wrong network — this desk trades on {active.name}
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={switchBack}
            disabled={busy}
            className="rev slug px-2 py-0.5"
          >
            {busy ? "Switching…" : "Switch"}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="slug text-amber/70 transition-colors hover:text-amber"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
