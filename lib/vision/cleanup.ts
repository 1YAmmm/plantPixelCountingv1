import { fromMask, Mask } from "image-js";
import { rectGap } from "./geometry";
import type { VisionSettings } from "./settings";
import type { BinaryMask, Rect } from "./types";

// Plan §5 step 6, mask cleanup with image-js. Server-side only (the browser preview stops at step 5).

export interface CleanupResult {
  mask: BinaryMask;
  /** Blobs after morphology, before filtering. */
  blobCount: number;
  /** Blobs kept (main plant + nearby blobs). */
  keptBlobs: number;
  /** Bounding box of the kept plant, or null if nothing was kept. */
  plantBox: Rect | null;
}

function squareKernel(size: number): number[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1));
}

/** Morphological opening with a size×size square; size 0 or 1 returns the input. */
export function openMask(mask: BinaryMask, width: number, height: number, size: number): BinaryMask {
  if (size <= 1) return mask;
  const m = new Mask(width, height, { data: mask.slice() });
  return m.open({ kernel: squareKernel(size) }).getRawImage().data;
}

export function cleanupLeafMask(
  leaf: BinaryMask,
  width: number,
  height: number,
  roi: BinaryMask,
  roiPixels: number,
  settings: VisionSettings["cleanup"],
): CleanupResult {
  let m = new Mask(width, height, { data: leaf.slice() });
  // 1. Opening removes speckle noise. 2. Closing fills small holes inside leaves.
  if (settings.openSize > 1) m = m.open({ kernel: squareKernel(settings.openSize) });
  if (settings.closeSize > 1) m = m.close({ kernel: squareKernel(settings.closeSize) });
  const data = m.getRawImage().data;
  // Closing may grow into excluded areas (marker, outside the crop); clip back to the ROI.
  for (let i = 0; i < data.length; i++) if (!roi[i]) data[i] = 0;

  const manager = fromMask(new Mask(width, height, { data }), { allowCorners: true });
  const rois = manager.getRois({ kind: "white" });
  const out = new Uint8Array(width * height);
  if (rois.length === 0) return { mask: out, blobCount: 0, keptBlobs: 0, plantBox: null };

  // 3. Drop blobs smaller than minBlobPct of the ROI (moss, reflections, debris).
  const minArea = (settings.minBlobPct / 100) * roiPixels;
  const big = rois.filter((r) => r.surface >= minArea);
  if (big.length === 0) return { mask: out, blobCount: rois.length, keptBlobs: 0, plantBox: null };

  // 4. Keep the largest blob plus any blob within mergeDistance of it.
  const rect = (r: (typeof rois)[number]): Rect => ({ x: r.origin.column, y: r.origin.row, width: r.width, height: r.height });
  const main = big.reduce((a, b) => (b.surface > a.surface ? b : a));
  const mainRect = rect(main);
  const maxGap = (settings.mergeDistancePct / 100) * Math.max(width, height);
  const kept = big.filter((r) => r === main || rectGap(rect(r), mainRect) <= maxGap);
  const keepIds = new Set(kept.map((r) => r.id));

  const map = manager.getMap().data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const r of kept) {
    minX = Math.min(minX, r.origin.column);
    minY = Math.min(minY, r.origin.row);
    maxX = Math.max(maxX, r.origin.column + r.width - 1);
    maxY = Math.max(maxY, r.origin.row + r.height - 1);
  }
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * width + x;
      if (keepIds.has(map[i])) out[i] = 1;
    }
  }
  return {
    mask: out,
    blobCount: rois.length,
    keptBlobs: kept.length,
    plantBox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}
