/**
 * Deterministic PRNG for the mock universe. The whole prototype dataset is a
 * pure function of the seed, so server render and client hydration agree
 * exactly; live ticks start only after mount.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Approximate normal via central limit. */
  normal(mean: number, sd: number): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

export function rng(seed: number): Rng {
  const base = mulberry32(seed);
  const r: Rng = {
    next: base,
    range(min, max) {
      return min + base() * (max - min);
    },
    normal(mu, sigma) {
      return mu + (base() + base() + base() + base() - 2) * 0.8165 * sigma;
    },
    int(min, max) {
      return Math.floor(min + base() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(base() * items.length)] as T;
    },
  };
  return r;
}

/** Stable string hash for per-entity seeds. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
