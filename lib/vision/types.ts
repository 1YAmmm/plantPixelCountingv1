/** Interleaved 8-bit image, RGB (3 channels, from sharp) or RGBA (4 channels, from a canvas). */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  channels: 3 | 4;
}

export interface Point {
  x: number;
  y: number;
}

/** Rectangle in pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rectangle in normalized image coordinates (0–1), so it survives resizing. */
export type NormRect = Rect;

/** Binary mask, one byte per pixel (0 or 1), row-major. */
export type BinaryMask = Uint8Array;
