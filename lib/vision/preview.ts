import { classifyPixels } from "./classify";
import { renderMaskRgba } from "./overlay";
import { imageQualityIssues, meanBrightness, sharpnessScore, type QualityIssue } from "./quality";
import type { VisionSettings } from "./settings";
import type { RgbImage } from "./types";
import { computeWhiteBalance, type WhiteBalance } from "./white-balance";

export interface MaskPreview {
  width: number;
  height: number;
  whiteBalance: WhiteBalance;
  leafPixels: number;
  stressedPixels: number;
  /** Raw (uncleaned) leaf cover of the square; the server result after cleanup is the official one. */
  estimatedCoverPct: number;
  /** RGBA mask for drawing over the photo. */
  maskRgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface PreviewResult extends MaskPreview {
  brightnessPct: number;
  sharpness: number;
  issues: QualityIssue[];
}

/**
 * Plan §5 steps 3–5 (white balance, classification) on a downscaled square image, using the same
 * modules as the server so the preview matches the result. Without `showStressed` the mask shows
 * leaf pixels only.
 */
export function maskPreview(img: RgbImage, settings: VisionSettings, showStressed = true): MaskPreview {
  const { width, height } = img;
  const whiteBalance = computeWhiteBalance(img, settings.whiteBalance);
  const cls = classifyPixels(img, null, settings, whiteBalance.gains);
  return {
    width,
    height,
    whiteBalance,
    leafPixels: cls.leafCount,
    stressedPixels: cls.stressedCount,
    estimatedCoverPct: (cls.leafCount / (width * height)) * 100,
    maskRgba: renderMaskRgba(width, height, cls.leaf, showStressed ? cls.stressed : null),
  };
}

/** Browser preview step: the mask preview plus the quality checks. */
export function previewAnalyze(img: RgbImage, settings: VisionSettings): PreviewResult {
  const brightnessPct = meanBrightness(img);
  const sharpness = sharpnessScore(img);
  return {
    ...maskPreview(img, settings),
    brightnessPct,
    sharpness,
    issues: imageQualityIssues({ brightnessPct, sharpness }, settings.quality),
  };
}
