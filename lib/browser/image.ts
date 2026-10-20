import { guideRect, SQUARE_PX } from "../vision/guide";
import type { RgbImage } from "../vision/types";

// Browser image helpers: plan §5 step 1 on the client (orientation, guide-square crop, resize).

/** Draw any image source into a new canvas whose long edge is at most `maxEdge`. */
export function drawScaled(source: CanvasImageSource, width: number, height: number, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Crop the centred guide square of a width × height source and scale it to `size` × `size`.
 * Live captures and uploads both go through this, so every analyzed photo has the same framing.
 */
export function cropToGuide(source: CanvasImageSource, width: number, height: number, size = SQUARE_PX): HTMLCanvasElement {
  const r = guideRect(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, r.x * width, r.y * height, r.width * width, r.height * height, 0, 0, size, size);
  return canvas;
}

/** Decode a photo file (EXIF orientation applied) and crop its guide square. */
export async function fileToSquare(file: Blob, size = SQUARE_PX): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return cropToGuide(bitmap, bitmap.width, bitmap.height, size);
  } finally {
    bitmap.close();
  }
}

export function videoToSquare(video: HTMLVideoElement, size = SQUARE_PX): HTMLCanvasElement {
  return cropToGuide(video, video.videoWidth, video.videoHeight, size);
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the photo"))), "image/jpeg", quality),
  );
}

export function canvasToRgb(canvas: HTMLCanvasElement): RgbImage {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width, height, data, channels: 4 };
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

/** Small JPEG data URL of a canvas or image (the ghost overlay kept in browser storage). */
export function thumbnailDataUrl(source: HTMLCanvasElement | HTMLImageElement, maxEdge = 480): string {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  return drawScaled(source, w, h, maxEdge).toDataURL("image/jpeg", 0.7);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}
