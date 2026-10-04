import type { Metadata } from "next";
import { GATE_API_PATH, safeGateNext } from "@/server/gate";

/**
 * The entry gate — the machine's door. Rendered bare (outside the shell
 * group): nothing on the door may call a resource the lock itself guards.
 * A plain form POST to /api/gate; the browser remembers the phrase's cookie
 * for 30 days, so this screen is seen once per machine per month.
 */

export const metadata: Metadata = {
  title: "Restricted — gUSD",
  robots: { index: false, follow: false },
};

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const denied = params.e === "1";
  const next = safeGateNext(typeof params.next === "string" ? params.next : undefined);

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground px-3">
      <div className="w-full max-w-100">
        <div className="flex items-baseline gap-2.5">
          <span className="disp text-[19px] leading-none text-bright">gUSD</span>
          <span className="slug text-dim">Capital markets for GPU compute</span>
        </div>

        <div className="mt-4 border border-rule-strong bg-panel">
          <div className="flex items-baseline justify-between border-b border-rule-strong px-3.5 py-2">
            <span className="num text-[12px] font-bold text-amber">ACCESS · RESTRICTED</span>
            <span className="slug text-dim">gUSD terminal</span>
          </div>

          <div className="p-3.5">
            <p className="num text-[13px] leading-relaxed text-primary">
              This terminal is restricted. Enter the access phrase to continue.
            </p>

            {denied ? (
              <p
                id="gate-error"
                role="alert"
                className="mt-3 border border-amber/40 bg-amber/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber"
              >
                Access denied — the phrase did not match. Try again.
              </p>
            ) : null}

            <form action={GATE_API_PATH} method="post" className="mt-3.5 flex flex-col gap-2.5">
              {next !== "/" ? <input type="hidden" name="next" value={next} /> : null}
              <div className="flex items-center border border-rule-strong bg-ground transition-colors focus-within:border-amber">
                <span aria-hidden className="num pl-3 text-[15px] font-bold text-amber">
                  &gt;
                </span>
                <input
                  type="password"
                  name="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  spellCheck={false}
                  autoCapitalize="none"
                  aria-label="Access phrase"
                  aria-describedby={denied ? "gate-error" : undefined}
                  placeholder="access phrase"
                  className="num min-w-0 flex-1 bg-transparent px-2.5 py-2.5 text-[15px] font-bold text-amber outline-none placeholder:font-normal placeholder:text-dim focus-visible:shadow-none"
                />
              </div>
              <button type="submit" className="rev slug w-full py-2.5 text-rev-fg transition-opacity hover:opacity-90">
                Enter
              </button>
            </form>

            <p className="slug mt-3.5 border-t border-rule pt-2.5 text-dim">
              One phrase opens the terminal · this browser is remembered for 30 days
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
