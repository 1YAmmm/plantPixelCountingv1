import { classifyHsv, PixelClass, rgbToHsv } from "./color";
import type { HsvRule } from "./settings";
import type { BinaryMask, RgbImage } from "./types";

export interface Classification {
  leaf: BinaryMask;
  stressed: BinaryMask;
  leafCount: number;
  stressedCount: number;
}

/**
 * Plan §5 step 5: white-balance each pixel inside the ROI, convert to HSV and classify it as
 * leaf (green), stressed (yellow/brown) or background. Shared by the browser preview and the server.
 */
export function classifyPixels(
  img: RgbImage,
  roi: BinaryMask | null,
  rules: { leaf: HsvRule; stressed: HsvRule },
  gains: [number, number, number] = [1, 1, 1],
): Classification {
  const { width, height, data, channels } = img;
  const size = width * height;
  const leaf = new Uint8Array(size);
  const stressed = new Uint8Array(size);
  const [gr, gg, gb] = gains;
  const hsv = { h: 0, s: 0, v: 0 };
  let leafCount = 0;
  let stressedCount = 0;
  for (let i = 0, p = 0; i < size; i++, p += channels) {
    if (roi && !roi[i]) continue;
    const r = Math.min(255, data[p] * gr);
    const g = Math.min(255, data[p + 1] * gg);
    const b = Math.min(255, data[p + 2] * gb);
    const cls = classifyHsv(rgbToHsv(r, g, b, hsv), rules.leaf, rules.stressed);
    if (cls === PixelClass.Leaf) {
      leaf[i] = 1;
      leafCount++;
    } else if (cls === PixelClass.Stressed) {
      stressed[i] = 1;
      stressedCount++;
    }
  }
  return { leaf, stressed, leafCount, stressedCount };
}
