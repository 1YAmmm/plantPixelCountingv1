import type { VisionSettings } from "./settings";
import type { RgbImage } from "./types";

/** Mean luma (Rec. 601) as percent, sampling every other pixel in each direction. */
export function meanBrightness(img: RgbImage): number {
  const { width, height, data, channels } = img;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const p = (y * width + x) * channels;
      sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      n++;
    }
  }
  return n ? (sum / n / 255) * 100 : 0;
}

/** Grayscale copy, box-downsampled so the long edge is at most `maxEdge` (makes the score resolution-independent). */
function grayscale(img: RgbImage, maxEdge: number): { gray: Float32Array; width: number; height: number } {
  const scale = Math.max(1, Math.max(img.width, img.height) / maxEdge);
  const w = Math.max(1, Math.floor(img.width / scale));
  const h = Math.max(1, Math.floor(img.height / scale));
  const gray = new Float32Array(w * h);
  const counts = new Uint16Array(w * h);
  const { data, channels, width } = img;
  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < img.width; x++) {
      const tx = Math.min(w - 1, Math.floor(x / scale));
      const p = (y * width + x) * channels;
      const t = ty * w + tx;
      gray[t] += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      counts[t]++;
    }
  }
  for (let i = 0; i < gray.length; i++) gray[i] /= counts[i] || 1;
  return { gray, width: w, height: h };
}

/**
 * Sharpness score (0–~100): mean Sobel edge strength of the strongest 0.5% of pixels at 640 px,
 * divided by the image's contrast range (1st–99th percentile of luma). Large flat areas (the
 * backdrop) do not dilute it, exposure does not change it, and blur lowers it because it spreads
 * every edge out. A step edge scores ~100; a Gaussian blur of σ px (at 640 px) scores roughly 40/σ.
 */
export function sharpnessScore(img: RgbImage): number {
  const { gray, width, height } = grayscale(img, 640);
  if (width < 3 || height < 3) return 0;

  const lumaBins = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) lumaBins[Math.min(255, Math.round(gray[i]))]++;
  const percentile = (p: number) => {
    const target = gray.length * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += lumaBins[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  const contrast = Math.max(20, percentile(0.99) - percentile(0.01));

  const bins = new Uint32Array(400);
  let total = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = gray[i - width - 1];
      const t = gray[i - width];
      const tr = gray[i - width + 1];
      const l = gray[i - 1];
      const r = gray[i + 1];
      const bl = gray[i + width - 1];
      const b = gray[i + width];
      const br = gray[i + width + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      const mag = Math.min(399, Math.round(Math.hypot(gx, gy) / 4));
      bins[mag]++;
      total++;
    }
  }
  const take = Math.max(1, Math.round(total * 0.005));
  let taken = 0;
  let sum = 0;
  for (let m = bins.length - 1; m >= 0 && taken < take; m--) {
    const n = Math.min(bins[m], take - taken);
    sum += n * m;
    taken += n;
  }
  return (100 * sum) / taken / contrast;
}

export type QualityCode = "too_dark" | "too_bright" | "blurry";

export interface QualityIssue {
  code: QualityCode;
  message: string;
}

export interface ImageQualityInput {
  brightnessPct: number;
  sharpness: number;
}

/** Plan §5 step 9 image checks: brightness and blur. */
export function imageQualityIssues(input: ImageQualityInput, q: VisionSettings["quality"]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (input.brightnessPct < q.minBrightness) {
    issues.push({ code: "too_dark", message: `Too dark (${input.brightnessPct.toFixed(0)}% brightness)` });
  } else if (input.brightnessPct > q.maxBrightness) {
    issues.push({ code: "too_bright", message: `Too bright (${input.brightnessPct.toFixed(0)}% brightness)` });
  }
  if (input.sharpness < q.minSharpness) {
    issues.push({ code: "blurry", message: `Blurry (sharpness ${input.sharpness.toFixed(0)})` });
  }
  return issues;
}
