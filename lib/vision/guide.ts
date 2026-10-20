import type { NormRect } from "./types";

// The on-screen square guide that replaces a printed marker: every photo is cropped to the same
// centred square and scaled to the same size, so leaf cover is comparable between photos as long
// as the plant is framed the same way (pot rim on the circle, phone held flat).

/** Square side as a fraction of the photo's shorter side. */
export const GUIDE_FRACTION = 0.8;
/** The analyzed image is always SQUARE_PX × SQUARE_PX. */
export const SQUARE_PX = 1000;
/** Pot-rim circle diameter as a fraction of the square side. */
export const POT_CIRCLE_FRACTION = 0.5;
/** The phone counts as level within this many degrees of flat. */
export const LEVEL_TOLERANCE_DEG = 5;

/** The centred guide square of a width × height photo, normalized (0–1). */
export function guideRect(width: number, height: number, fraction = GUIDE_FRACTION): NormRect {
  const side = Math.min(width, height) * fraction;
  return {
    x: (width - side) / 2 / width,
    y: (height - side) / 2 / height,
    width: side / width,
    height: side / height,
  };
}
