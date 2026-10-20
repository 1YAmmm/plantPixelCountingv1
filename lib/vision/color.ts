import type { HsvRule } from "./settings";

export interface Hsv {
  /** Hue in degrees, [0, 360). */
  h: number;
  /** Saturation in percent, [0, 100]. */
  s: number;
  /** Value (brightness) in percent, [0, 100]. */
  v: number;
}

/** Convert 8-bit RGB to HSV. Writes into `out` to avoid allocations in pixel loops. */
export function rgbToHsv(r: number, g: number, b: number, out: Hsv = { h: 0, s: 0, v: 0 }): Hsv {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const delta = max - min;
  out.v = (max / 255) * 100;
  out.s = max === 0 ? 0 : (delta / max) * 100;
  if (delta === 0) {
    out.h = 0;
  } else if (max === r) {
    out.h = 60 * (((g - b) / delta + 6) % 6);
  } else if (max === g) {
    out.h = 60 * ((b - r) / delta + 2);
  } else {
    out.h = 60 * ((r - g) / delta + 4);
  }
  return out;
}

/** Inclusive hue range test. A range with min > max wraps around 360° (e.g. 340–20 for reds). */
export function hueInRange(h: number, min: number, max: number): boolean {
  return min <= max ? h >= min && h <= max : h >= min || h <= max;
}

export function matchesRule(hsv: Hsv, rule: HsvRule): boolean {
  return hsv.s >= rule.satMin && hsv.v >= rule.valMin && hueInRange(hsv.h, rule.hueMin, rule.hueMax);
}

/** Pixel classes from plan §5 step 5. */
export const PixelClass = {
  Background: 0,
  Leaf: 1,
  Stressed: 2,
} as const;
export type PixelClass = (typeof PixelClass)[keyof typeof PixelClass];

/** Classify one pixel (already white-balanced). Leaf wins if the ranges overlap. */
export function classifyHsv(hsv: Hsv, leaf: HsvRule, stressed: HsvRule): PixelClass {
  if (matchesRule(hsv, leaf)) return PixelClass.Leaf;
  if (matchesRule(hsv, stressed)) return PixelClass.Stressed;
  return PixelClass.Background;
}
