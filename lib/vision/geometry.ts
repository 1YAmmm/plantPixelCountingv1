import type { BinaryMask, Point, Rect } from "./types";

/** Convex hull (Andrew's monotone chain). Returns vertices counter-clockwise, without repeating the first. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Outline points of a mask: for each row, the outer corners of its leftmost and rightmost pixel.
 * Using pixel corners (not centres) makes the hull of a solid w×h block exactly w×h.
 */
function rowExtremeCorners(mask: BinaryMask, width: number, minY: number, maxY: number): Point[] {
  const points: Point[] = [];
  for (let y = minY; y <= maxY; y++) {
    const row = y * width;
    let left = -1;
    let right = -1;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (left < 0) continue;
    points.push({ x: left, y }, { x: left, y: y + 1 }, { x: right + 1, y }, { x: right + 1, y: y + 1 });
  }
  return points;
}

/** Convex hull of all set pixels of a mask (empty if the mask is empty). */
export function maskHull(mask: BinaryMask, width: number, height: number): Point[] {
  let minY = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (minY < 0) minY = y;
        maxY = y;
        break;
      }
    }
  }
  if (minY < 0) return [];
  return convexHull(rowExtremeCorners(mask, width, minY, maxY));
}

/** Rasterize a convex polygon (pixel-corner coordinates): a pixel is inside if its centre is. */
export function fillConvexPolygon(poly: Point[], width: number, height: number): BinaryMask {
  const out = new Uint8Array(width * height);
  if (poly.length < 3) return out;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y === b.y) continue;
      if ((a.y <= cy && b.y >= cy) || (b.y <= cy && a.y >= cy)) {
        const x = a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (left > right) continue;
    const xs = Math.max(0, Math.ceil(left - 0.5));
    const xe = Math.min(width - 1, Math.floor(right - 0.5));
    if (xe >= xs) out.fill(1, y * width + xs, y * width + xe + 1);
  }
  return out;
}

/** Binary dilation with a (2r+1)×(2r+1) square, separable (rows then columns). */
export function dilateSquare(mask: BinaryMask, width: number, height: number, radius: number): BinaryMask {
  if (radius <= 0) return mask.slice();
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let last = -Infinity;
    // Forward pass remembers the last set pixel; backward pass covers pixels to the left of a set pixel.
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) last = x;
      if (x - last <= radius) tmp[row + x] = 1;
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[row + x]) last = x;
      if (last - x <= radius) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height; y++) {
      if (tmp[y * width + x]) last = y;
      if (y - last <= radius) out[y * width + x] = 1;
    }
    last = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (tmp[y * width + x]) last = y;
      if (last - y <= radius) out[y * width + x] = 1;
    }
  }
  return out;
}

/** Gap in pixels between two rectangles (0 if they touch or overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}
