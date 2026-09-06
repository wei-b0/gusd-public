/**
 * Loader for the self-hosted TradingView Advanced Charts standalone bundle.
 *
 * Plain client-side script injection, not `next/script`: the widget builds an
 * iframe document under `library_path` and only needs the global present
 * before `new TradingView.widget(...)`, which our chart component awaits.
 * The promise is module-cached so React StrictMode's double-mount (and any
 * number of consumers) triggers exactly one injection, and a failed load is
 * surfaced as a rejection the component can render honestly.
 */

let loadPromise: Promise<NonNullable<Window["TradingView"]>> | null = null;

export function loadTradingView(): Promise<NonNullable<Window["TradingView"]>> {
  loadPromise ??= new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("TradingView loader requires a browser"));
      return;
    }
    if (window.TradingView) {
      resolve(window.TradingView);
      return;
    }
    // A previous loader instance (hot reload, aborted mount) may have left a
    // tag in the DOM — reuse it instead of stacking duplicates.
    const existing = document.querySelector<HTMLScriptElement>("script[data-tv-lib]");
    const script = existing ?? document.createElement("script");
    script.dataset.tvLib = "true";
    script.onload = () => {
      if (window.TradingView) resolve(window.TradingView);
      else reject(new Error("charting_library loaded but the TradingView global is missing"));
    };
    script.onerror = () => reject(new Error("charting_library.standalone.js failed to load"));
    if (!existing) {
      script.src = "/charting_library/charting_library.standalone.js";
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return loadPromise;
}
