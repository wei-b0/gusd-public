"use client";

/**
 * ConnectDialog — the one connect surface. It is a pure view of the auth
 * port's ConnectFlow: the adapter owns every transition, this component only
 * renders the current step and feeds user instructions back through
 * flowAction. Opened by auth.connect() from any CTA; nothing else mounts it.
 *
 * The world's rules hold: TuiPanel frame, amber function voice, slug/num
 * typography, reverse-video actions, zero radius. Marks are characters —
 * wallets appear as text rows, never logos.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectFlow } from "@/domain/types";
import { TuiPanel } from "@/components/ui/panel";
import { useConnectFlow, useServices } from "@/data/services";
import { subscribeWalletDiscovery } from "@/data/auth/wallet-discovery";

export function ConnectDialog() {
  const { auth } = useServices();
  const flow = useConnectFlow();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const open = flow.step !== "closed";

  // Announced wallets land after the flow opens — re-render on each one.
  const [, bump] = useState(0);
  useEffect(() => subscribeWalletDiscovery(() => bump((n) => n + 1)), []);

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

  // Step change: put focus on the step's first control (the input on the
  // form steps, the first row on the method step).
  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>("input, button:not([disabled])")
      ?.focus();
  }, [open, flow.step]);

  // ESC cancels from anywhere while the flow is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") auth.cancelConnect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, auth]);

  if (!open) return null;

  // Focus trap: Tab cycles inside the panel.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      "input:not([disabled]), button:not([disabled])",
    );
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

  return (
    <div className="fixed inset-0 z-40">
      <div
        aria-hidden
        onClick={() => auth.cancelConnect()}
        className="absolute inset-0 bg-ground/70"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative z-50 mx-auto mt-[16vh] w-[min(20rem,calc(100vw-1.5rem))] outline-none"
      >
        <TuiPanel
          no="01"
          title="Connect"
          right={
            <button
              type="button"
              onClick={() => auth.cancelConnect()}
              className="slug text-dim transition-colors hover:text-amber"
            >
              ESC
            </button>
          }
        >
          <div aria-live="polite" className="p-3.5">
            {flow.step === "method" && <MethodStep flow={flow} />}
            {flow.step === "email" && <EmailStep flow={flow} />}
            {flow.step === "oauth" && (
              <>
                <Pending label="CONTINUE IN THE POPUP…" meta="google" />
                {flow.error && <FlowError message={flow.error} />}
                <RetryRow onClick={() => auth.flowAction({ type: "back-to-method" })} />
              </>
            )}
            {flow.step === "wallet" && (
              <>
                {flow.error ? (
                  <FlowError message={flow.error} />
                ) : (
                  <Pending label="CONNECTING…" meta={flow.walletLabel} />
                )}
                <RetryRow onClick={() => auth.flowAction({ type: "back-to-method" })} />
              </>
            )}
            {flow.step === "signature" && (
              <>
                {flow.error ? (
                  <FlowError message={flow.error} />
                ) : (
                  <Pending label="AWAITING SIGNATURE…" meta={flow.walletLabel} />
                )}
                <RetryRow onClick={() => auth.flowAction({ type: "back-to-method" })} />
              </>
            )}
            {flow.step === "provisioning" && <Pending label="PREPARING WALLET…" />}
          </div>
        </TuiPanel>
      </div>
    </div>
  );
}

type MethodFlow = Extract<ConnectFlow, { step: "method" }>;
type EmailFlow = Extract<ConnectFlow, { step: "email" }>;

/**
 * Method step: wallets are the dominant path — one bordered cell each,
 * first in the panel, first in the tab order. Email and Google demote below
 * the hairline as the fallback route.
 */
function MethodStep({ flow }: { flow: MethodFlow }) {
  const { auth } = useServices();
  const [email, setEmail] = useState("");
  const wallets = auth.listConnectableWallets();

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    auth.flowAction({ type: "submit-email", email });
  }

  return (
    <>
      {flow.error && <FlowError message={flow.error} />}

      {wallets.length > 0 ? (
        <>
          <p className="slug mb-2 text-dim">Connect a wallet</p>
          <div className="space-y-2">
            {wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => auth.flowAction({ type: "choose-wallet", walletId: w.id })}
                className="slug flex w-full items-center justify-between border border-rule-strong px-3 py-2.5 text-data transition-colors hover:border-amber hover:text-amber"
              >
                {w.label}
                <span aria-hidden className="num text-[13px] font-bold text-amber">
                  &gt;
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="border border-rule-strong px-3 py-2.5 text-[11.5px] leading-relaxed text-dim">
          No wallet detected in this browser — continue with email below.
        </p>
      )}

      <div className="mt-4 border-t border-rule pt-3">
        <p className="slug mb-2 text-dim">Or continue with email</p>
        <form onSubmit={submitEmail}>
          <div className="flex items-stretch border border-rule-strong bg-ground focus-within:border-amber">
            <span aria-hidden className="num flex items-center px-2 text-[15px] font-bold text-amber">
              &gt;
            </span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              spellCheck={false}
              aria-label="Email address"
              placeholder="you@work.com"
              className="num w-full min-w-0 bg-transparent py-2 pr-2 text-[13px] text-data outline-none placeholder:font-normal placeholder:text-dim"
            />
          </div>
          <button type="submit" className="rev slug mt-2.5 w-full py-1.5">
            Continue
          </button>
        </form>
        <button
          type="button"
          onClick={() => auth.flowAction({ type: "choose-google" })}
          className="slug block w-full py-1.5 text-left text-dim transition-colors hover:text-amber"
        >
          Google
        </button>
        {/*
          Wallet Connect is intentionally absent: no transport package is
          installed, so a row would promise a connect the app can't do.
          It ships with the transport, behind the same flowAction seam.
        */}
      </div>
    </>
  );
}

/** Email step: the code line, verify/resend/change. */
function EmailStep({ flow }: { flow: EmailFlow }) {
  const { auth } = useServices();
  const [code, setCode] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    auth.flowAction({ type: "submit-code", code });
  }

  return (
    <>
      <p className="text-[11.5px] leading-relaxed text-data">
        Check <span className="text-bright">{flow.email}</span> — enter the 6-digit code.
      </p>
      <form onSubmit={submit} className="mt-2.5">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="6-digit code"
          className="num w-full border border-rule-strong bg-ground py-2 text-center text-[15px] tracking-[0.4em] text-data outline-none focus:border-amber"
        />
        <button type="submit" disabled={flow.busy} className="rev slug mt-2.5 w-full py-1.5">
          {flow.busy ? "Verifying…" : "Verify"}
        </button>
      </form>
      <div className="mt-2.5 flex items-baseline justify-between">
        <button
          type="button"
          disabled={flow.busy}
          onClick={() => auth.flowAction({ type: "resend-code" })}
          className="slug text-dim transition-colors hover:text-amber"
        >
          Resend
        </button>
        <button
          type="button"
          onClick={() => auth.flowAction({ type: "back-to-method" })}
          className="slug text-dim transition-colors hover:text-amber"
        >
          Change email
        </button>
      </div>
      {flow.error && <FlowError message={flow.error} />}
    </>
  );
}

/** A waiting state: amber text, blinking cursor, dim context line. */
function Pending({ label, meta }: { label: string; meta?: string | null }) {
  return (
    <p role="status" className="py-3 text-center">
      <span className="slug text-amber">{label}</span>
      <span aria-hidden className="ml-1 inline-block animate-pulse text-amber">
        ▌
      </span>
      {meta ? <span className="slug mt-1.5 block text-dim">{meta}</span> : null}
    </p>
  );
}

/** The amber error voice — the world's one error box grammar. */
function FlowError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mb-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber"
    >
      {message}
    </p>
  );
}

/** Dim way back to the method list — the retry is picking again from there. */
function RetryRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="slug mt-3 w-full border border-rule-strong py-1.5 text-dim transition-colors hover:border-amber hover:text-amber"
    >
      Try again
    </button>
  );
}
