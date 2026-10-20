import { dilateSquare, fillConvexPolygon, maskHull } from "./geometry";
import type { VisionSettings } from "./settings";
import type { BinaryMask, Point } from "./types";

export interface PlantRegion {
  mask: BinaryMask;
  /** Hull outline when mode = "hull" (for drawing), else empty. */
  hull: Point[];
}

/**
 * Plan §5 step 7: the area in which yellow/brown pixels count as discoloration — the convex hull
 * of the cleaned leaf mask, or the leaf mask dilated by a fixed radius.
 */
export function plantRegion(
  leaf: BinaryMask,
  width: number,
  height: number,
  settings: VisionSettings["plantRegion"],
): PlantRegion {
  if (settings.mode === "dilate") {
    return { mask: dilateSquare(leaf, width, height, settings.dilatePx), hull: [] };
  }
  const hull = maskHull(leaf, width, height);
  return { mask: fillConvexPolygon(hull, width, height), hull };
}
