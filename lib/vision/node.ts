import sharp from "sharp";
import { analyzeImage, type Analysis, type AnalyzeOptions } from "./analyze";
import { renderOverlay } from "./overlay";
import type { RgbImage } from "./types";

// Server-side image I/O around the pure pipeline (plan §5 steps 1, 10). Uses sharp, so Node.js only.

export async function decodeImage(input: Buffer): Promise<RgbImage> {
  const { data, info } = await sharp(input).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
    channels: 3,
  };
}

export async function encodeJpeg(rgb: Uint8Array, width: number, height: number, quality = 85): Promise<Buffer> {
  return sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length), { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
}

/**
 * Step 1 — apply EXIF orientation, resize so the long edge is at most `maxLongEdge` (null keeps the
 * native size) and re-encode as JPEG. The pixels are decoded from that same JPEG, so analyzing the
 * returned JPEG again (e.g. after a crop change) gives identical numbers.
 */
export async function prepareImage(input: Buffer, maxLongEdge: number | null): Promise<{ jpeg: Buffer; image: RgbImage }> {
  let pipeline = sharp(input, { failOn: "error" }).autoOrient();
  if (maxLongEdge) {
    pipeline = pipeline.resize({ width: maxLongEdge, height: maxLongEdge, fit: "inside", withoutEnlargement: true });
  }
  const jpeg = await pipeline.jpeg({ quality: 90 }).toBuffer();
  return { jpeg, image: await decodeImage(jpeg) };
}

export interface PipelineResult {
  /** The normalized image that was analyzed. */
  imageJpeg: Buffer;
  overlayJpeg: Buffer;
  analysis: Analysis;
  totalMs: number;
}

export async function runPipeline(
  input: Buffer,
  opts: AnalyzeOptions & {
    /** Resize long edge; null keeps native size; "prepared" means input is a JPEG this function returned before. */
    maxLongEdge: number | null | "prepared";
  },
): Promise<PipelineResult> {
  const start = performance.now();
  const prepared =
    opts.maxLongEdge === "prepared" ? { jpeg: input, image: await decodeImage(input) } : await prepareImage(input, opts.maxLongEdge);
  const analysis = analyzeImage(prepared.image, opts);
  const overlay = renderOverlay(prepared.image, {
    leaf: analysis.masks.leaf,
    stressed: analysis.masks.stressed,
    region: analysis.masks.region,
    roi: analysis.masks.roi,
  });
  const overlayJpeg = await encodeJpeg(overlay, prepared.image.width, prepared.image.height);
  return { imageJpeg: prepared.jpeg, overlayJpeg, analysis, totalMs: Math.round(performance.now() - start) };
}
