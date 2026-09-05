/**
 * The authoritative gUSD GPU catalogue.
 *
 * Ordering is load-bearing: `normalizeGpuLabel` walks this array in order and
 * the FIRST match wins — the only tie-break. Variant entries must be listed
 * above generic entries they contain:
 *   - H100 NVL / H100 PCIe above bare H100
 *   - GB200 / GB300 / GH200 above B200 / B300 / H200
 *   - RTX 6000 ADA above RTX A6000 above RTX PRO 6000 catch-alls
 *   - A10G above A10; MI325X above MI300X
 *
 * Plausible bands are screening-only per-SKU USD/GPU-hour ranges. They exist
 * to catch unit/identity mistakes (a $0.01 placeholder, a per-instance price
 * misread as per-GPU), never to define truth.
 */

export type GpuId =
  | "H100_SXM_80GB"
  | "H100_PCIE_80GB"
  | "H100_NVL_94GB"
  | "H200_141GB"
  | "H200_NVL_141GB"
  | "H20_96GB"
  | "B200_192GB"
  | "B300_288GB"
  | "GB200_192GB"
  | "GB300_288GB"
  | "GH200_96GB"
  | "A100_SXM_80GB"
  | "A100_PCIE_80GB"
  | "L40S_48GB"
  | "L40_48GB"
  | "A40_48GB"
  | "L4_24GB"
  | "A10_24GB"
  | "A10G_24GB"
  | "RTX_4090_24GB"
  | "RTX_5090_32GB"
  | "RTX_PRO_6000_96GB"
  | "RTX_6000_ADA_48GB"
  | "RTX_A6000_48GB"
  | "V100_16GB"
  | "MI300X_192GB"
  | "MI325X_256GB";

export type GpuVendor = "nvidia" | "amd";

export type FormFactor = "SXM" | "PCIE" | "NVL" | "OAM" | "CARD" | null;

export interface GpuSku {
  id: GpuId;
  /** Human label used in APIs and docs. */
  label: string;
  vendor: GpuVendor;
  vramGb: number;
  formFactor: FormFactor;
  /** Screening-only plausible range of USD per GPU-hour. */
  plausibleBandUsdPerGpuHour: readonly [number, number];
  /**
   * Ordered pattern strings for the matcher. Already-variant-first; each is
   * normalized by the same pipeline as incoming labels before matching.
   */
  patterns: readonly string[];
}

export const CATALOG: readonly GpuSku[] = [
  {
    id: "H100_NVL_94GB",
    label: "H100 NVL",
    vendor: "nvidia",
    vramGb: 94,
    formFactor: "NVL",
    plausibleBandUsdPerGpuHour: [0.3, 30],
    patterns: ["H100 NVL", "H100 NVL 94GB"],
  },
  {
    id: "H100_PCIE_80GB",
    label: "H100 PCIe",
    vendor: "nvidia",
    vramGb: 80,
    formFactor: "PCIE",
    plausibleBandUsdPerGpuHour: [0.2, 25],
    patterns: ["H100 PCIE", "H100 PCI E", "H100 PCI"],
  },
  {
    id: "H100_SXM_80GB",
    label: "H100 SXM",
    vendor: "nvidia",
    vramGb: 80,
    formFactor: "SXM",
    plausibleBandUsdPerGpuHour: [0.2, 25],
    patterns: ["H100 SXM", "H100 SXM 5", "H100 SXM 4", "HGX H100", "H100"],
  },
  {
    id: "H200_NVL_141GB",
    label: "H200 NVL",
    vendor: "nvidia",
    vramGb: 141,
    formFactor: "NVL",
    plausibleBandUsdPerGpuHour: [0.3, 30],
    patterns: ["H200 NVL"],
  },
  {
    id: "H200_141GB",
    label: "H200",
    vendor: "nvidia",
    vramGb: 141,
    formFactor: "SXM",
    plausibleBandUsdPerGpuHour: [0.3, 30],
    patterns: ["H200", "HGX H200"],
  },
  {
    id: "H20_96GB",
    label: "H20",
    vendor: "nvidia",
    vramGb: 96,
    formFactor: null,
    plausibleBandUsdPerGpuHour: [0.1, 10],
    patterns: ["H20"],
  },
  {
    id: "GB300_288GB",
    label: "GB300",
    vendor: "nvidia",
    vramGb: 288,
    formFactor: null,
    plausibleBandUsdPerGpuHour: [1, 60],
    patterns: ["GB300"],
  },
  {
    id: "GB200_192GB",
    label: "GB200",
    vendor: "nvidia",
    vramGb: 192,
    formFactor: null,
    plausibleBandUsdPerGpuHour: [1, 60],
    patterns: ["GB200", "GRACE BLACKWELL"],
  },
  {
    id: "B300_288GB",
    label: "B300",
    vendor: "nvidia",
    vramGb: 288,
    formFactor: "SXM",
    plausibleBandUsdPerGpuHour: [1, 60],
    patterns: ["B300", "HGX B300"],
  },
  {
    id: "B200_192GB",
    label: "B200",
    vendor: "nvidia",
    vramGb: 192,
    formFactor: "SXM",
    plausibleBandUsdPerGpuHour: [0.5, 40],
    patterns: ["B200", "HGX B200"],
  },
  {
    id: "GH200_96GB",
    label: "GH200",
    vendor: "nvidia",
    vramGb: 96,
    formFactor: null,
    plausibleBandUsdPerGpuHour: [0.2, 15],
    patterns: ["GH200", "GRACE HOPPER"],
  },
  {
    id: "MI325X_256GB",
    label: "MI325X",
    vendor: "amd",
    vramGb: 256,
    formFactor: "OAM",
    plausibleBandUsdPerGpuHour: [0.3, 20],
    patterns: ["MI 325 X"],
  },
  {
    id: "MI300X_192GB",
    label: "MI300X",
    vendor: "amd",
    vramGb: 192,
    formFactor: "OAM",
    plausibleBandUsdPerGpuHour: [0.2, 15],
    patterns: ["MI 300 X"],
  },
  {
    id: "A100_PCIE_80GB",
    label: "A100 PCIe",
    vendor: "nvidia",
    vramGb: 80,
    formFactor: "PCIE",
    plausibleBandUsdPerGpuHour: [0.1, 15],
    patterns: ["A100 PCIE", "A100 PCI E"],
  },
  {
    id: "A100_SXM_80GB",
    label: "A100 SXM",
    vendor: "nvidia",
    vramGb: 80,
    formFactor: "SXM",
    plausibleBandUsdPerGpuHour: [0.1, 15],
    patterns: ["A100 SXM", "A100 SXM 4", "A100"],
  },
  {
    id: "L40S_48GB",
    label: "L40S",
    vendor: "nvidia",
    vramGb: 48,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.05, 8],
    patterns: ["L40S"],
  },
  {
    id: "L40_48GB",
    label: "L40",
    vendor: "nvidia",
    vramGb: 48,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.05, 8],
    patterns: ["L40"],
  },
  {
    id: "A40_48GB",
    label: "A40",
    vendor: "nvidia",
    vramGb: 48,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.03, 4],
    patterns: ["A40"],
  },
  {
    id: "L4_24GB",
    label: "L4",
    vendor: "nvidia",
    vramGb: 24,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.02, 2],
    patterns: ["L4"],
  },
  {
    id: "A10G_24GB",
    label: "A10G",
    vendor: "nvidia",
    vramGb: 24,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.03, 3],
    patterns: ["A10G"],
  },
  {
    id: "A10_24GB",
    label: "A10",
    vendor: "nvidia",
    vramGb: 24,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.03, 3],
    patterns: ["A10"],
  },
  {
    id: "RTX_5090_32GB",
    label: "RTX 5090",
    vendor: "nvidia",
    vramGb: 32,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.1, 8],
    patterns: ["RTX 5090", "GEFORCE RTX 5090", "5090"],
  },
  {
    id: "RTX_4090_24GB",
    label: "RTX 4090",
    vendor: "nvidia",
    vramGb: 24,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.05, 5],
    patterns: ["RTX 4090 D", "RTX 4090", "GEFORCE RTX 4090", "GEFORCE 4090", "4090"],
  },
  {
    id: "RTX_6000_ADA_48GB",
    label: "RTX 6000 Ada",
    vendor: "nvidia",
    vramGb: 48,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.1, 6],
    patterns: ["RTX 6000 ADA", "6000 ADA"],
  },
  {
    id: "RTX_PRO_6000_96GB",
    label: "RTX PRO 6000",
    vendor: "nvidia",
    vramGb: 96,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.1, 10],
    patterns: ["RTX PRO 6000", "RTXPRO 6000", "PRO 6000 BLACKWELL", "PRO 6000"],
  },
  {
    id: "RTX_A6000_48GB",
    label: "RTX A6000",
    vendor: "nvidia",
    vramGb: 48,
    formFactor: "CARD",
    plausibleBandUsdPerGpuHour: [0.05, 4],
    patterns: ["RTX A6000", "A6000", "RTX 6000"],
  },
  {
    id: "V100_16GB",
    label: "V100",
    vendor: "nvidia",
    vramGb: 16,
    formFactor: null,
    plausibleBandUsdPerGpuHour: [0.02, 3],
    patterns: ["V100"],
  },
];

export function getGpu(id: GpuId): GpuSku {
  const sku = CATALOG.find((s) => s.id === id);
  if (!sku) throw new Error(`Unknown GPU id: ${id}`);
  return sku;
}

/** Panel ids group catalog GPUs into settlement panels (separate from collection). */
export interface SettlementPanel {
  id: string;
  gpuId: GpuId;
}

/**
 * The full tokenized universe from apps/contracts/PROTOCOL.md §3. Every SKU
 * here is settled each cycle, but panels whose contributor set is thin run on
 * per-panel methodology overrides (reduced quorum, rate-card eligibility —
 * see MethodologyConfig.panelOverrides) and can at best publish `degraded`.
 */
export const SETTLEMENT_PANELS: readonly SettlementPanel[] = [
  { id: "A100_PANEL_V1", gpuId: "A100_SXM_80GB" },
  { id: "H100_PANEL_V1", gpuId: "H100_SXM_80GB" },
  { id: "H200_PANEL_V1", gpuId: "H200_141GB" },
  { id: "B200_PANEL_V1", gpuId: "B200_192GB" },
  { id: "B300_PANEL_V1", gpuId: "B300_288GB" },
  { id: "GB200_PANEL_V1", gpuId: "GB200_192GB" },
  { id: "GB300_PANEL_V1", gpuId: "GB300_288GB" },
];
