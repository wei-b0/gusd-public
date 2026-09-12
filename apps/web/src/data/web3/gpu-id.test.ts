import { describe, expect, it } from "vitest";
import {
  assetForGpuId,
  gpuIdForAsset,
  gpuIdToString,
} from "./gpu-id";
import { ASSET_IDS, type AssetId } from "@/domain/types";

const ASSETS: AssetId[] = [...ASSET_IDS];

describe("gpu-id", () => {
  it("round-trips every settlement SKU through the bytes32 form", () => {
    for (const asset of ASSETS) {
      const gpuId = gpuIdForAsset(asset);
      expect(gpuId.length).toBe(66);
      expect(gpuId.startsWith("0x")).toBe(true);
      expect(assetForGpuId(gpuId)).toBe(asset);
    }
  });

  it("decodes H100 to the catalog SKU with zero padding", () => {
    const gpuId = gpuIdForAsset("H100");
    expect(gpuIdToString(gpuId)).toBe("H100_SXM_80GB");
    // Left-aligned ASCII: the string bytes lead, the padding trails.
    expect(gpuId.startsWith("0x483130305f53584d5f38304742")).toBe(true);
    expect(gpuId.endsWith("0".repeat(26))).toBe(true);
  });

  it("matches the contract's bytes32(bytes(...)) encoding", () => {
    // GpuId.sol encodes left-aligned ASCII; spot-check RTX 4090's exact SKU.
    expect(gpuIdToString(gpuIdForAsset("RTX4090"))).toBe("RTX_4090_24GB");
  });

  it("refuses assets without an oracle settlement panel", () => {
    // ORACLE_PANELS is derived from the catalog; every ASSETS entry has a
    // panel today, so the refusal path is exercised via an unknown gpuId.
    expect(assetForGpuId("0x0000")).toBeNull();
  });
});
