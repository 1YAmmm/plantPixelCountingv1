import { classifyPixels } from "./classify";
import { renderMaskRgba } from "./overlay";
import { imageQualityIssues, meanBrightness, sharpnessScore, type QualityIssue } from "./quality";
import type { VisionSettings } from "./settings";
import type { RgbImage } from "./types";
import { computeWhiteBalance, type WhiteBalance } from "./white-balance";

export interface PreviewResult {
  width: number;
  height: number;
  whiteBalance: WhiteBalance;
  leafPixels: number;
  stressedPixels: number;
  /** Raw (uncleaned) leaf cover of the square; the server result after cleanup is the official one. */
  estimatedCoverPct: number;
  brightnessPct: number;
  sharpness: number;
  issues: QualityIssue[];
  /** RGBA mask for drawing over the photo. */
  maskRgba: Uint8ClampedArray;
}

/**
 * Browser preview: plan §5 steps 3–5 (white balance, classification) and the quality checks on a
 * downscaled square image, using the same modules as the server so the preview matches the result.
 */
export function previewAnalyze(img: RgbImage, settings: VisionSettings): PreviewResult {
  const { width, height } = img;
  const whiteBalance = computeWhiteBalance(img, settings.whiteBalance);
  const cls = classifyPixels(img, null, settings, whiteBalance.gains);
  const brightnessPct = meanBrightness(img);
  const sharpness = sharpnessScore(img);
  return {
    width,
    height,
    whiteBalance,
    leafPixels: cls.leafCount,
    stressedPixels: cls.stressedCount,
    estimatedCoverPct: (cls.leafCount / (width * height)) * 100,
    brightnessPct,
    sharpness,
    issues: imageQualityIssues({ brightnessPct, sharpness }, settings.quality),
    maskRgba: renderMaskRgba(width, height, cls.leaf, cls.stressed),
  };
}

/** Live camera mask preview on a small frame of the square. */
export function liveMask(img: RgbImage, settings: VisionSettings): Uint8ClampedArray {
  const whiteBalance = computeWhiteBalance(img, settings.whiteBalance);
  const cls = classifyPixels(img, null, settings, whiteBalance.gains);
  return renderMaskRgba(img.width, img.height, cls.leaf, null);
}
