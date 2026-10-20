import type { BinaryMask } from "./types";

export interface Metrics {
  leafPixels: number;
  stressedPixels: number;
  roiPixels: number;
  /**
   * Leaf cover: leaf pixels as percent of the whole guide square. The square is the scale
   * reference, so a crop box that only removes clutter does not change it.
   */
  coveragePct: number;
  discolorationPct: number;
  /** Top-most to bottom-most leaf pixel (meaningful for side views), null if no leaf pixels. */
  plantHeightPx: number | null;
}

/** Plan §5 step 8. */
export function measure(leaf: BinaryMask, stressedInRegion: BinaryMask, width: number, roiPixels: number): Metrics {
  let leafPixels = 0;
  let stressedPixels = 0;
  let top = -1;
  let bottom = -1;
  for (let i = 0; i < leaf.length; i++) {
    if (leaf[i]) {
      leafPixels++;
      const y = Math.floor(i / width);
      if (top < 0) top = y;
      bottom = y;
    }
    if (stressedInRegion[i]) stressedPixels++;
  }
  const plantPixels = leafPixels + stressedPixels;
  return {
    leafPixels,
    stressedPixels,
    roiPixels,
    coveragePct: leaf.length > 0 ? (leafPixels / leaf.length) * 100 : 0,
    discolorationPct: plantPixels > 0 ? (stressedPixels / plantPixels) * 100 : 0,
    plantHeightPx: top < 0 ? null : bottom - top + 1,
  };
}
