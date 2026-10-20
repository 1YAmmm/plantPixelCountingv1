import { classifyPixels } from "./classify";
import { cleanupLeafMask, openMask, type CleanupResult } from "./cleanup";
import { measure, type Metrics } from "./measure";
import { imageQualityIssues, meanBrightness, sharpnessScore, type QualityIssue } from "./quality";
import { plantRegion } from "./region";
import { buildRoiMask } from "./roi";
import type { VisionSettings } from "./settings";
import type { BinaryMask, NormRect, RgbImage } from "./types";
import { computeWhiteBalance, type WhiteBalance } from "./white-balance";

export interface AnalyzeOptions {
  settings: VisionSettings;
  /** Crop box inside the square, normalized. Null = the whole square. */
  roi?: NormRect | null;
}

export interface Analysis {
  width: number;
  height: number;
  whiteBalance: WhiteBalance;
  metrics: Metrics;
  brightnessPct: number;
  sharpness: number;
  /** Quality problems (brightness, blur). Any issue means the photo should be retaken. */
  issues: QualityIssue[];
  cleanup: Omit<CleanupResult, "mask">;
  masks: {
    leaf: BinaryMask;
    stressed: BinaryMask;
    roi: BinaryMask;
    region: BinaryMask;
  };
  timingsMs: Record<string, number>;
}

/**
 * Steps 3–9 of plan §5 on the prepared square image (the on-screen square guide replaces the
 * printed marker of step 2, so results are leaf cover in % of the square). Pure: no I/O.
 */
export function analyzeImage(img: RgbImage, opts: AnalyzeOptions): Analysis {
  const { settings } = opts;
  const { width, height } = img;
  const timingsMs: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timingsMs[name] = Math.round((now - t) * 10) / 10;
    t = now;
  };

  // Step 3 — white balance from the white backdrop.
  const whiteBalance = computeWhiteBalance(img, settings.whiteBalance);
  lap("whiteBalance");

  // Step 4 — region of interest: the square, optionally narrowed by a crop box.
  const roi = buildRoiMask(width, height, opts.roi);
  lap("roi");

  // Step 5 — pixel classification.
  const cls = classifyPixels(img, roi.mask, settings, whiteBalance.gains);
  lap("classify");

  // Step 6 — mask cleanup.
  const cleaned = cleanupLeafMask(cls.leaf, width, height, roi.mask, roi.count, settings.cleanup);
  lap("cleanup");

  // Step 7 — plant region; stressed pixels count only inside it and not where the leaf mask already is.
  const region = plantRegion(cleaned.mask, width, height, settings.plantRegion);
  const stressedOpen = openMask(cls.stressed, width, height, settings.cleanup.stressedOpenSize);
  const stressed = new Uint8Array(width * height);
  for (let i = 0; i < stressed.length; i++) {
    if (stressedOpen[i] && region.mask[i] && !cleaned.mask[i] && roi.mask[i]) stressed[i] = 1;
  }
  lap("region");

  // Step 8 — measurements.
  const metrics = measure(cleaned.mask, stressed, width, roi.count);
  lap("measure");

  // Step 9 — image quality.
  const brightnessPct = meanBrightness(img);
  const sharpness = sharpnessScore(img);
  const issues = imageQualityIssues({ brightnessPct, sharpness }, settings.quality);
  lap("quality");

  return {
    width,
    height,
    whiteBalance,
    metrics,
    brightnessPct,
    sharpness,
    issues,
    cleanup: { blobCount: cleaned.blobCount, keptBlobs: cleaned.keptBlobs, plantBox: cleaned.plantBox },
    masks: { leaf: cleaned.mask, stressed, roi: roi.mask, region: region.mask },
    timingsMs,
  };
}
