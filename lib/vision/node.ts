import sharp from "sharp";
import { analyzeImage, type Analysis, type AnalyzeOptions } from "./analyze";
import { CAMERA_SQUARE_PX, guideBox, SQUARE_PX } from "./guide";
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

/**
 * The centred guide square of a full camera photo, scaled to SQUARE_PX × SQUARE_PX: the reference
 * for the crop the camera's firmware does before analyzing (cameraSquare), so every photo is framed the same way.
 */
export async function cropGuideSquare(input: Buffer): Promise<Buffer> {
  const { autoOrient } = await sharp(input, { failOn: "error" }).metadata();
  const { left, top, side } = guideBox(autoOrient.width, autoOrient.height);
  return sharp(input, { failOn: "error" })
    .autoOrient()
    .extract({ left, top, width: side, height: side })
    .resize(SQUARE_PX, SQUARE_PX)
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * The crop the camera does (firmware/esp32-cam/vision.cpp), to check its numbers: the guide square
 * shrunk to CAMERA_SQUARE_PX by averaging the photo pixels in each cell, rounded like the firmware.
 */
export async function cameraSquare(input: Buffer): Promise<RgbImage> {
  const { width, height, data } = await decodeImage(input);
  const { left, top, side } = guideBox(width, height);
  const n = Math.min(CAMERA_SQUARE_PX, side);
  const cell = (s: number) => Math.floor((s * n) / side);
  // Photo pixels per grid row (and column), so a cell has cells[row] × cells[column].
  const cells = new Uint32Array(n);
  for (let s = 0; s < side; s++) cells[cell(s)]++;
  const sums = new Uint32Array(n * n * 3);
  for (let y = 0; y < side; y++) {
    const row = cell(y) * n;
    for (let x = 0; x < side; x++) {
      const p = ((top + y) * width + left + x) * 3;
      const t = (row + cell(x)) * 3;
      sums[t] += data[p];
      sums[t + 1] += data[p + 1];
      sums[t + 2] += data[p + 2];
    }
  }
  const out = new Uint8Array(n * n * 3);
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const count = cells[ty] * cells[tx];
      const t = (ty * n + tx) * 3;
      for (let k = 0; k < 3; k++) out[t + k] = Math.floor((sums[t + k] + (count >> 1)) / count);
    }
  }
  return { width: n, height: n, data: out, channels: 3 };
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
