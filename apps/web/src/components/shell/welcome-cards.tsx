"use client";

/**
 * WelcomeCards — the first-run cue cards: three short modals that orient a
 * new visitor (what this machine is, what lives where) and point the first
 * action (connect, then mint). Fired once per browser by the welcome store;
 * replayable from the command line (`help`). Reading stays public — the
 * cards are an overlay, never a wall: ESC, the scrim, and SKIP dismiss from
 * every card, and dismissal is permanent.
 *
 * The grammar is ConnectDialog's: TuiPanel frame over a ground scrim, focus
 * trap, invoker regains focus on close, aria-live body. Marks are
 * characters — the desk map on card 02 is drawn in slug keys and a command
 * line, never a screenshot.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { TuiPanel } from "@/components/ui/panel";
import { WalletlessNote } from "@/components/ui/walletless-note";
import { PRIVY_ENABLED } from "@/data/auth/privy-config";
import { useServices } from "@/data/services";
import { welcome } from "@/data/onboarding/welcome-store";

function useWelcomeOpen(): boolean {
  // Arrow wrappers keep `this` bound — the store's methods can't be passed
  // to useSyncExternalStore as bare references.
  return useSyncExternalStore(
    (onStoreChange) => welcome.subscribe(onStoreChange),
    () => welcome.isOpen(),
    () => false,
  );
}

export function WelcomeCards() {
  const router = useRouter();
  const { auth } = useServices();
  const open = useWelcomeOpen();
  const [step, setStep] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // First shell mount: auto-fire for a browser that hasn't seen this
  // sequence version. Replay opens through the same store.
  useEffect(() => {
    welcome.maybeFire();
  }, []);

  // Open: remember the invoker, take focus. Close: hand it back.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open]);

  // Card change: focus the card's primary action (the reverse-video CTA —
  // the head's ESC key renders earlier in the DOM but is never the target).
  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>("button.rev")
      ?.focus();
  }, [open, step]);

  // ESC dismisses from anywhere while the cards are open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") welcome.dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  // Focus trap: Tab cycles inside the panel.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const focusables =
      panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
    if (!focusables || focusables.length === 0) return;
    const list = Array.from(focusables);
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function connect() {
    // One modal owns focus at a time: the cards close first, then the
    // connect flow opens over the page.
    welcome.dismiss();
    void auth.connect();
  }

  function browse() {
    welcome.dismiss();
    router.push("/");
  }

  return (
    <div className="fixed inset-0 z-40">
      <div
        aria-hidden
        onClick={() => welcome.dismiss()}
        className="absolute inset-0 bg-ground/70"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to gUSD"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative z-50 mx-auto mt-[14vh] w-[min(21rem,calc(100vw-1.5rem))] outline-none"
      >
        {step === 0 && (
          <WelcomeCard
            no="01"
            title="Welcome"
            meta="1 / 3"
            onNext={() => setStep(1)}
            onSkip={() => welcome.dismiss()}
          >
            <h3 className="disp text-[20px] leading-tight text-primary">
              Capital markets for GPU compute.
            </h3>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-primary">
              This desk builds markets on GPU compute prices — H100, H200,
              L40S, RTX 4090 — each settling against a live benchmark the
              oracle publishes. Reading is open to everyone; a wallet is
              needed only to trade.
            </p>
          </WelcomeCard>
        )}
        {step === 1 && (
          <WelcomeCard
            no="02"
            title="The desk"
            meta="2 / 3"
            onNext={() => setStep(2)}
            onSkip={() => welcome.dismiss()}
          >
            <h3 className="disp text-[20px] leading-tight text-primary">
              Everything is one key away.
            </h3>
            <DeskMap />
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-dim">
              The command line answers product names — markets, spot H200,
              perps H200, gusd — and a bare GPU code opens that desk.
            </p>
            <p className="mt-2.5 border border-rule-strong px-3 py-2.5 text-[11.5px] leading-relaxed text-primary">
              <span className="text-wire">Index</span> ≠ market — the Index is
              the benchmark every market is measured against, never the market
              price itself.
            </p>
          </WelcomeCard>
        )}
        {step === 2 && (
          <WelcomeCard
            no="03"
            title="First steps"
            meta="3 / 3"
            onNext={PRIVY_ENABLED ? connect : browse}
            nextLabel={PRIVY_ENABLED ? "Connect" : "Go to markets"}
            onSkip={() => welcome.dismiss()}
            skipLabel="I'll explore on my own"
          >
            <h3 className="disp text-[20px] leading-tight text-primary">
              Connect, then mint gUSD.
            </h3>
            <div className="mt-3 space-y-2.5">
              <Step
                n="01"
                label="Connect"
                body="Connect a wallet — or continue with email and one is provisioned for you."
              />
              <Step
                n="02"
                label="Mint"
                body="On the gUSD desk, convert a supported stable into gUSD. The desk prices every route, bridge origins included."
              />
            </div>
            {!PRIVY_ENABLED && (
              <div className="mt-3">
                <WalletlessNote />
              </div>
            )}
          </WelcomeCard>
        )}
      </div>
    </div>
  );
}

/** One card: TuiPanel frame, control row, the replay foot. */
function WelcomeCard({
  no,
  title,
  meta,
  onNext,
  nextLabel = "Next",
  onSkip,
  skipLabel = "Skip",
  children,
}: {
  no: string;
  title: string;
  meta: string;
  onNext: () => void;
  nextLabel?: string;
  onSkip: () => void;
  skipLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <TuiPanel
      no={no}
      title={title}
      meta={meta}
      right={
        <button
          type="button"
          onClick={onSkip}
          className="slug text-dim transition-colors hover:text-amber"
        >
          ESC
        </button>
      }
    >
      <div aria-live="polite" className="p-3.5 pb-1.5">
        {children}
        <div className="mt-3.5 flex items-stretch gap-2">
          <button type="button" onClick={onNext} className="rev slug flex-1 py-1.5">
            {nextLabel}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="slug border border-rule-strong px-3 py-1.5 text-dim transition-colors hover:border-amber hover:text-amber"
          >
            {skipLabel}
          </button>
        </div>
      </div>
      <p className="slug border-t border-rule px-3.5 py-2 text-center text-[9.5px] text-dim">
        Replay — type help at the command line
      </p>
    </TuiPanel>
  );
}

/**
 * Card 02's map: the function-key rail and the command line, drawn in the
 * machine's own characters — slug keys in the rail's order, Oracle keyless
 * at the far end.
 */
function DeskMap() {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {[
          ["F1", "Markets"],
          ["F2", "Spot"],
          ["F3", "Perps"],
          ["F4", "gUSD"],
          ["F5", "Portfolio"],
        ].map(([key, name]) => (
          <span
            key={key}
            className="slug flex items-baseline gap-1 border border-rule-strong px-1.5 py-1 text-dim"
          >
            <span aria-hidden className="num text-[9px] font-normal text-dim">
              {key}
            </span>
            {name}
          </span>
        ))}
        <span aria-hidden className="h-px min-w-2 flex-1 bg-rule" />
        <span className="slug border border-rule px-1.5 py-1 text-wire">Oracle</span>
      </div>
      <div className="flex items-center border border-rule-strong bg-ground px-2 py-1.5">
        <span aria-hidden className="num text-[15px] font-bold text-amber">
          &gt;
        </span>
        <span className="num ml-1 text-[13px] font-bold text-amber">spot H200</span>
        <span aria-hidden className="rev slug ml-auto px-2 py-0.5">
          GO
        </span>
      </div>
    </div>
  );
}

/** A numbered step: amber address, slug label, dim body. */
function Step({ n, label, body }: { n: string; label: string; body: string }) {
  return (
    <div className="border-b border-rule pb-2.5 last:border-b-0 last:pb-0">
      <div className="flex items-baseline gap-2">
        <span className="num text-[12px] font-bold text-amber">{n}</span>
        <span className="slug text-data">{label}</span>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-dim">{body}</p>
    </div>
  );
}
