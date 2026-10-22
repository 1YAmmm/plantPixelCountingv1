import { PREVIEW_JOBS, type MaskPreview, type PreviewJob } from "./preview";
import type { VisionSettings } from "./settings";
import type { RgbImage } from "./types";

// Web Worker running the browser previews off the main thread (started by
// lib/browser/preview-worker.ts), so the camera, sliders and buttons stay smooth meanwhile.

export interface PreviewRequest {
  id: number;
  job: PreviewJob;
  image: RgbImage;
  settings: VisionSettings;
}

export type PreviewReply = { id: number; result: MaskPreview } | { id: number; error: string };

addEventListener("message", (e: MessageEvent<PreviewRequest>) => {
  const { id, job, image, settings } = e.data;
  try {
    const result = PREVIEW_JOBS[job](image, settings);
    postMessage({ id, result } satisfies PreviewReply, { transfer: [result.maskRgba.buffer] });
  } catch (error) {
    postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies PreviewReply);
  }
});
