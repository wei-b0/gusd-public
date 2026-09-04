import { describe, expect, it } from "vitest";
import { CATALOG, getGpu, type GpuId, SETTLEMENT_PANELS } from "./catalog.js";
import { normalizeGpuLabel, normalizeLabelText, plausibleBandFor } from "./normalize.js";

describe("catalog invariants", () => {
  it("has unique ids, positive vram, valid bands", () => {
    const ids = new Set<string>();
    for (const sku of CATALOG) {
      expect(ids.has(sku.id)).toBe(false);
      ids.add(sku.id);
      expect(sku.vramGb).toBeGreaterThan(0);
      const [lo, hi] = sku.plausibleBandUsdPerGpuHour;
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeGreaterThan(lo);
    }
  });

  it("every settlement panel references a catalog gpu", () => {
    for (const panel of SETTLEMENT_PANELS) {
      expect(() => getGpu(panel.gpuId)).not.toThrow();
    }
  });

  it("required brief GPUs are present", () => {
    const required: GpuId[] = [
      "H100_SXM_80GB",
      "H100_PCIE_80GB",
      "H100_NVL_94GB",
      "H200_141GB",
      "B200_192GB",
      "B300_288GB",
      "A100_SXM_80GB",
      "A100_PCIE_80GB",
      "L40S_48GB",
      "RTX_4090_24GB",
      "RTX_5090_32GB",
      "RTX_PRO_6000_96GB",
      "MI300X_192GB",
      "MI325X_256GB",
    ];
    for (const id of required) {
      expect(() => getGpu(id)).not.toThrow();
    }
  });
});

describe("identity confusion cases (the whole point)", () => {
  it("A10 does not match A100", () => {
    expect(normalizeGpuLabel("A10").gpuId).toBe("A10_24GB");
    expect(normalizeGpuLabel("A100").gpuId).toBe("A100_SXM_80GB");
    expect(normalizeGpuLabel("A10G").gpuId).toBe("A10G_24GB");
    expect(normalizeGpuLabel("NVIDIA A10 24GB").gpuId).toBe("A10_24GB");
  });

  it("B200 does not match GB200 and vice versa", () => {
    expect(normalizeGpuLabel("B200").gpuId).toBe("B200_192GB");
    expect(normalizeGpuLabel("GB200").gpuId).toBe("GB200_192GB");
    expect(normalizeGpuLabel("HGX B200").gpuId).toBe("B200_192GB");
    expect(normalizeGpuLabel("NVIDIA GB200 192GB").gpuId).toBe("GB200_192GB");
    expect(normalizeGpuLabel("B300").gpuId).toBe("B300_288GB");
    expect(normalizeGpuLabel("GB300").gpuId).toBe("GB300_288GB");
  });

  it("H20 does not match H200", () => {
    expect(normalizeGpuLabel("H20").gpuId).toBe("H20_96GB");
    expect(normalizeGpuLabel("H200").gpuId).toBe("H200_141GB");
    expect(normalizeGpuLabel("H100").gpuId).toBe("H100_SXM_80GB");
  });

  it("H100 PCIe NVLink maps to PCIe, not NVL", () => {
    expect(normalizeGpuLabel("H100 PCIe NVLink").gpuId).toBe("H100_PCIE_80GB");
    expect(normalizeGpuLabel("H100 NVL").gpuId).toBe("H100_NVL_94GB");
  });

  it("H800 does not silently become H100", () => {
    expect(normalizeGpuLabel("H800").gpuId).toBeNull();
    expect(normalizeGpuLabel("H800").rejectReason).toBe("unmapped");
  });
});

describe("form-factor and variant ordering", () => {
  it("bare H100 defaults to SXM", () => {
    expect(normalizeGpuLabel("h100").gpuId).toBe("H100_SXM_80GB");
    expect(normalizeGpuLabel("NVIDIA H100 80GB").gpuId).toBe("H100_SXM_80GB");
  });

  it("SXM/PCIe variants normalize across separator noise", () => {
    expect(normalizeGpuLabel("H100SXM").gpuId).toBe("H100_SXM_80GB");
    expect(normalizeGpuLabel("h100-sxm5-80gb").gpuId).toBe("H100_SXM_80GB");
    expect(normalizeGpuLabel("H100 SXM5").gpuId).toBe("H100_SXM_80GB");
    expect(normalizeGpuLabel("A100-SXM4-80GB").gpuId).toBe("A100_SXM_80GB");
    expect(normalizeGpuLabel("A100 PCIE").gpuId).toBe("A100_PCIE_80GB");
  });

  it("RTX family ordering: 6000 ADA before PRO 6000 before A6000 catch-all", () => {
    expect(normalizeGpuLabel("RTX 6000 Ada").gpuId).toBe("RTX_6000_ADA_48GB");
    expect(normalizeGpuLabel("RTX PRO 6000").gpuId).toBe("RTX_PRO_6000_96GB");
    expect(normalizeGpuLabel("RTXPro6000").gpuId).toBe("RTX_PRO_6000_96GB");
    expect(normalizeGpuLabel("RTX A6000").gpuId).toBe("RTX_A6000_48GB");
    expect(normalizeGpuLabel("A6000").gpuId).toBe("RTX_A6000_48GB");
  });

  it("4090D matches RTX 4090 without confusing 5090", () => {
    expect(normalizeGpuLabel("RTX 4090").gpuId).toBe("RTX_4090_24GB");
    expect(normalizeGpuLabel("RTX4090").gpuId).toBe("RTX_4090_24GB");
    expect(normalizeGpuLabel("RTX 4090D").gpuId).toBe("RTX_4090_24GB");
    expect(normalizeGpuLabel("GeForce RTX 4090 24GB").gpuId).toBe("RTX_4090_24GB");
    expect(normalizeGpuLabel("RTX 5090").gpuId).toBe("RTX_5090_32GB");
    expect(normalizeGpuLabel("5090").gpuId).toBe("RTX_5090_32GB");
  });

  it("L4 does not match L40 or L40S", () => {
    expect(normalizeGpuLabel("L4").gpuId).toBe("L4_24GB");
    expect(normalizeGpuLabel("L40").gpuId).toBe("L40_48GB");
    expect(normalizeGpuLabel("L40S").gpuId).toBe("L40S_48GB");
    expect(normalizeGpuLabel("l40s").gpuId).toBe("L40S_48GB");
  });

  it("MI300X and MI325X are distinct", () => {
    expect(normalizeGpuLabel("MI300X").gpuId).toBe("MI300X_192GB");
    expect(normalizeGpuLabel("MI 300 X").gpuId).toBe("MI300X_192GB");
    expect(normalizeGpuLabel("MI325X").gpuId).toBe("MI325X_256GB");
    expect(normalizeGpuLabel("AMD MI300X 192GB").gpuId).toBe("MI300X_192GB");
  });

  it("GH200 and V100 with SXM2 noise", () => {
    expect(normalizeGpuLabel("GH200").gpuId).toBe("GH200_96GB");
    expect(normalizeGpuLabel("Tesla V100 SXM2 16GB").gpuId).toBe("V100_16GB");
  });
});

describe("VRAM deviation guard", () => {
  it("rejects 40GB A100 impersonating 80GB", () => {
    const r = normalizeGpuLabel("A100 SXM4 40GB");
    expect(r.gpuId).toBeNull();
    expect(r.rejectReason).toBe("vram_deviation");
  });

  it("rejects MIG slices", () => {
    const r = normalizeGpuLabel("H100 MIG 2g.10gb");
    expect(r.gpuId).toBeNull();
    expect(r.rejectReason).toBe("vram_deviation");
  });

  it("accepts stated VRAM within tolerance", () => {
    expect(normalizeGpuLabel("H100 80GB").gpuId).toBe("H100_SXM_80GB");
    expect(normalizeGpuLabel("H200 141GB").gpuId).toBe("H200_141GB");
    expect(normalizeGpuLabel("B300 288GB").gpuId).toBe("B300_288GB");
    expect(normalizeGpuLabel("RTX PRO 6000 96GB").gpuId).toBe("RTX_PRO_6000_96GB");
  });
});

describe("never guess", () => {
  it("unmapped labels return null with reason", () => {
    for (const raw of ["", "  ", "N/A", "-", "unknown", "Tensor Core T4", "Radeon Pro W7900"]) {
      const r = normalizeGpuLabel(raw);
      expect(r.gpuId).toBeNull();
      expect(r.rejectReason).toBe("unmapped");
      expect(r.matchedPattern).toBeNull();
    }
  });

  it("preserves the normalized label for the worklist", () => {
    const r = normalizeGpuLabel("h800-pcie-94gb");
    expect(r.normalizedLabel).toBe("H 800 PCIE 94 GB");
  });
});

describe("label normalization primitives", () => {
  it("splits alpha/digit boundaries on both sides", () => {
    expect(normalizeLabelText("RTX4090")).toBe("RTX 4090");
    expect(normalizeLabelText("h100_sxm")).toBe("H 100 SXM");
    expect(normalizeLabelText("A100–SXM4")).toBe("A 100 SXM 4");
    expect(normalizeLabelText("MI300X")).toBe("MI 300 X");
  });

  it("plausible bands are readable", () => {
    const [lo, hi] = plausibleBandFor("H100_SXM_80GB");
    expect(lo).toBe(0.2);
    expect(hi).toBe(25);
  });
});
