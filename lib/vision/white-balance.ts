import { rgbToHsv } from "./color";
import type { VisionSettings } from "./settings";
import type { RgbImage } from "./types";

// Plan §5 step 3 without a printed white patch: the matte white / light-gray backdrop (plan §4.1)
// is the neutral reference. Its pixels are the brightest low-saturation ones in the square.

export interface WhiteBalance {
  applied: boolean;
  /** Per-channel multipliers (1 = no change). */
  gains: [number, number, number];
  /** Mean R, G, B of the backdrop reference before correction, and how many pixels it used. */
  reference: { mean: [number, number, number]; pixels: number } | null;
}

const NO_CORRECTION: WhiteBalance = { applied: false, gains: [1, 1, 1], reference: null };

/** Reference = pixels in the top 20% of luma… */
const BRIGHT_SHARE = 0.2;
/** …and at least this share of the image must qualify, or the backdrop is not visible enough. */
const MIN_REFERENCE_SHARE = 0.02;

export function computeWhiteBalance(img: RgbImage, settings: VisionSettings["whiteBalance"]): WhiteBalance {
  if (!settings.enabled) return NO_CORRECTION;
  const { data, channels } = img;
  const size = img.width * img.height;

  // Luma threshold at the 80th percentile.
  const lumaBins = new Uint32Array(256);
  const luma = new Uint8Array(size);
  for (let i = 0, p = 0; i < size; i++, p += channels) {
    const l = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
    luma[i] = l;
    lumaBins[l]++;
  }
  let threshold = 255;
  for (let acc = 0; threshold > 0; threshold--) {
    acc += lumaBins[threshold];
    if (acc >= size * BRIGHT_SHARE) break;
  }

  const hsv = { h: 0, s: 0, v: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0, p = 0; i < size; i++, p += channels) {
    if (luma[i] < threshold) continue;
    rgbToHsv(data[p], data[p + 1], data[p + 2], hsv);
    if (hsv.s > settings.maxSaturation || hsv.v < settings.minValue) continue;
    r += data[p];
    g += data[p + 1];
    b += data[p + 2];
    n++;
  }
  if (n < size * MIN_REFERENCE_SHARE) return NO_CORRECTION;

  const mean: [number, number, number] = [r / n, g / n, b / n];
  const gray = settings.normalizeExposure ? settings.targetGray : (mean[0] + mean[1] + mean[2]) / 3;
  const clamp = (x: number) => Math.min(3, Math.max(0.5, x));
  return {
    applied: true,
    gains: [clamp(gray / Math.max(1, mean[0])), clamp(gray / Math.max(1, mean[1])), clamp(gray / Math.max(1, mean[2]))],
    reference: { mean, pixels: n },
  };
}
