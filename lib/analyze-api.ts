import type { Metrics } from "./vision/measure";
import type { QualityIssue } from "./vision/quality";
import type { NormRect, Rect } from "./vision/types";

// Shape of the /api/analyze response, shared by the route handler and the browser.

export interface AnalyzeResponse {
  width: number;
  height: number;
  /** Crop box used (normalized), null = the whole square. */
  roi: NormRect | null;
  metrics: Metrics;
  whiteBalance: { applied: boolean; gains: [number, number, number] };
  brightnessPct: number;
  sharpness: number;
  /** Any issue means the photo should be retaken (plan §5 step 9). */
  issues: QualityIssue[];
  cleanup: { blobCount: number; keptBlobs: number; plantBox: Rect | null };
  timingsMs: Record<string, number>;
  totalMs: number;
  /** The normalized square photo that was analyzed. Send it back with prepared=true to re-analyze. */
  imageDataUrl: string;
  overlayDataUrl: string;
}

export interface AnalyzeError {
  error: string;
}
