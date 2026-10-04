/**
 * The welcome cards' shared mutable core — a module singleton, because the
 * cards are shell UI, not a service port (the store has no adapter behind
 * it; both the cards and the command line import it directly).
 *
 * Two pieces of state: one `open` flag for useSyncExternalStore, and one
 * localStorage-backed record of which sequence version this browser has
 * already seen. Storage is fail-soft: blocked or corrupted storage reads as
 * "unseen", so the cards fire every visit — the honest failure mode for a
 * once-per-browser overlay that never blocks the page.
 */

/** Bump to re-fire the sequence for browsers that saw an older version. */
const VERSION = 1;
const STORAGE_KEY = "gusd.welcome.v1";

interface WelcomeRecord {
  version: number;
  completed: boolean;
}

/** Version 0 = never seen. */
const UNSEEN: WelcomeRecord = Object.freeze({ version: 0, completed: false });

function loadRecord(): WelcomeRecord {
  if (typeof window === "undefined") return UNSEEN;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return UNSEEN;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as WelcomeRecord).version !== "number" ||
      typeof (parsed as WelcomeRecord).completed !== "boolean"
    ) {
      return UNSEEN;
    }
    const { version, completed } = parsed as WelcomeRecord;
    return { version, completed };
  } catch {
    return UNSEEN;
  }
}

class WelcomeStore {
  private listeners = new Set<() => void>();
  private record: WelcomeRecord = UNSEEN;
  private open = false;

  /** Snapshot for the open flag. Server render always sees `false`. */
  isOpen(): boolean {
    return this.open;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    for (const listener of this.listeners) listener();
  }

  /** Auto-fire: open once per browser, per sequence version. */
  maybeFire(): void {
    if (this.open) return;
    if (this.record === UNSEEN) this.record = loadRecord();
    if (this.record.version !== VERSION) this.setOpen(true);
  }

  /** Replay via the command line — opens regardless of the record. */
  replay(): void {
    this.setOpen(true);
  }

  /** Dismiss: mark this version seen, persist, close. */
  dismiss(): void {
    this.record = { version: VERSION, completed: true };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.record));
    } catch {
      // Storage blocked — dismissal lives for this page load only.
    }
    this.setOpen(false);
  }
}

/** The one welcome store. */
export const welcome = new WelcomeStore();
