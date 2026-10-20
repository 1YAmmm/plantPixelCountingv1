import type { BinaryMask, NormRect, Rect } from "./types";

export function clampNormRect(r: NormRect): NormRect {
  const x = Math.min(1, Math.max(0, r.x));
  const y = Math.min(1, Math.max(0, r.y));
  return {
    x,
    y,
    width: Math.min(1 - x, Math.max(0, r.width)),
    height: Math.min(1 - y, Math.max(0, r.height)),
  };
}

export function normToPixels(r: NormRect, width: number, height: number): Rect {
  const c = clampNormRect(r);
  const x = Math.round(c.x * width);
  const y = Math.round(c.y * height);
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(c.width * width))),
    height: Math.max(1, Math.min(height - y, Math.round(c.height * height))),
  };
}

export function isFullFrame(r: NormRect | null | undefined): boolean {
  return !r || (r.x <= 0 && r.y <= 0 && r.width >= 1 && r.height >= 1);
}

/** Plan §5 step 4: the region of interest (an optional crop box inside the square) as a mask. */
export function buildRoiMask(width: number, height: number, rect: NormRect | null | undefined): { mask: BinaryMask; count: number } {
  const mask = new Uint8Array(width * height);
  const r = rect && !isFullFrame(rect) ? normToPixels(rect, width, height) : { x: 0, y: 0, width, height };
  for (let y = r.y; y < r.y + r.height; y++) {
    mask.fill(1, y * width + r.x, y * width + r.x + r.width);
  }
  return { mask, count: r.width * r.height };
}
