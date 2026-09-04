import { CATALOG, type GpuId, type GpuSku } from "./catalog.js";

/**
 * Deterministic GPU label → canonical SKU normalization.
 *
 * Design (ported from the study of computable/gpu-index's catalog and
 * gputable's alias table — reimplemented independently):
 *
 * 1. Text normalization: uppercase; unicode dashes → '-'; separators
 *    (`-_.+,/;:()[]`) → space; whitespace collapsed; a space inserted at
 *    alpha↔digit boundaries. The SAME pipeline is applied to incoming labels
 *    AND to catalog patterns, so `RTX4090 ≡ RTX 4090` and `H100SXM ≡ H100 SXM`.
 * 2. Boundary-guarded matching: each pattern is compiled with lookarounds
 *    `(?<![A-Z0-9])PATTERN(?![A-Z0-9])` so a token never matches inside a
 *    longer alphanumeric run — B200 never matches inside GB200, A10 never
 *    inside A100, H20 never inside H200, L4 never inside L40/L40S.
 * 3. Compacted variant: patterns are also matched against the label with all
 *    spaces removed, catching runs the boundary split cannot fix
 *    (`RTXPro6000` → `RTXPRO 6000`).
 * 4. First match wins across the catalog IN FILE ORDER — the only tie-break.
 *    Variant entries are listed above the generics they contain.
 * 5. VRAM deviation guard: if the label itself states a VRAM figure that
 *    deviates >25% from the matched SKU, the label is rejected
 *    (`vram_deviation`) instead of impersonating the canonical SKU — an
 *    "A100 40GB" or an MIG slice cannot pose as an 80GB card.
 * 6. Never guess: no fuzzy/prefix fallback. No hit → `unmapped` and the
 *    caller records the raw label in the unmapped worklist.
 */

export interface GpuNormalization {
  gpuId: GpuId | null;
  normalizedLabel: string;
  matchedPattern: string | null;
  rejectReason: null | "unmapped" | "vram_deviation";
}

/** Unicode dashes (en/em/minus/hyphen variants) that must behave like '-'. */
const UNICODE_DASHES = /[‐-―⁃−﹘﹣－]/g;
const SEPARATORS = /[-_.+,/;:()[\]]/g;
const WHITESPACE = /\s+/g;
const ALPHA_DIGIT_SPLIT = /(?<=[A-Z])(?=\d)|(?<=\d)(?=[A-Z])/g;
const VRAM_RE = /(\d{2,4})\s?G\s?B\b/;

export function normalizeLabelText(raw: string): string {
  return raw
    .toUpperCase()
    .replace(UNICODE_DASHES, "-")
    .replace(SEPARATORS, " ")
    .replace(WHITESPACE, " ")
    .trim()
    .replace(ALPHA_DIGIT_SPLIT, " ");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledPattern {
  sku: GpuSku;
  pattern: string;
  direct: RegExp;
  compact: RegExp;
}

function compile(pattern: string): { direct: RegExp; compact: RegExp } {
  const norm = normalizeLabelText(pattern);
  const compact = norm.replace(/ /g, "");
  return {
    direct: new RegExp(`(?<![A-Z0-9])${escapeRegex(norm)}(?![A-Z0-9])`),
    compact: new RegExp(`(?<![A-Z0-9])${escapeRegex(compact)}(?![A-Z0-9])`),
  };
}

const COMPILED: readonly { sku: GpuSku; pattern: string; direct: RegExp; compact: RegExp }[] =
  CATALOG.flatMap((sku) =>
    sku.patterns.map((pattern) => ({ sku, pattern, ...compile(pattern) })),
  );

/** VRAM deviation tolerance: a stated VRAM within 25% of the SKU is accepted. */
const VRAM_TOLERANCE = 0.25;

export function normalizeGpuLabel(raw: string): GpuNormalization {
  const normalizedLabel = normalizeLabelText(raw);

  let matched: { sku: GpuSku; pattern: string } | null = null;
  for (const c of COMPILED) {
    if (c.direct.test(normalizedLabel) || c.compact.test(normalizedLabel.replace(/ /g, ""))) {
      matched = { sku: c.sku, pattern: c.pattern };
      break;
    }
  }

  if (!matched) {
    return { gpuId: null, normalizedLabel, matchedPattern: null, rejectReason: "unmapped" };
  }

  // VRAM deviation guard — guards against MIG slices, 40GB A100s, and
  // mislabeled multi-GPU nodes impersonating the canonical SKU.
  const vramMatch = VRAM_RE.exec(normalizedLabel);
  if (vramMatch) {
    const statedVram = Number(vramMatch[1]);
    const skuVram = matched.sku.vramGb;
    if (Math.abs(statedVram - skuVram) / skuVram > VRAM_TOLERANCE) {
      return {
        gpuId: null,
        normalizedLabel,
        matchedPattern: matched.pattern,
        rejectReason: "vram_deviation",
      };
    }
  }

  return { gpuId: matched.sku.id, normalizedLabel, matchedPattern: matched.pattern, rejectReason: null };
}

/** Screening-only: the plausible USD/GPU-hour band for a catalog GPU. */
export function plausibleBandFor(id: GpuId): readonly [number, number] {
  return CATALOG.find((s) => s.id === id)!.plausibleBandUsdPerGpuHour;
}
