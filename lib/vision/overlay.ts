import type { BinaryMask, RgbImage } from "./types";

export const OVERLAY_COLORS = {
  leaf: [34, 197, 94] as const,
  stressed: [249, 115, 22] as const,
  region: [250, 204, 21] as const,
};

export interface OverlayInput {
  leaf: BinaryMask;
  stressed: BinaryMask;
  region?: BinaryMask | null;
  roi?: BinaryMask | null;
}

function outline(mask: BinaryMask, width: number, height: number): BinaryMask {
  const edge = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width]) {
        edge[i] = 1;
      }
    }
  }
  return edge;
}

/**
 * Plan §5 step 10: the photo with leaf pixels tinted green, stressed pixels orange, the plant
 * region outlined thinly and areas outside the crop box dimmed. Returns packed RGB.
 */
export function renderOverlay(img: RgbImage, input: OverlayInput): Uint8Array {
  const { width, height, data, channels } = img;
  const size = width * height;
  const out = new Uint8Array(size * 3);
  const regionEdge = input.region ? outline(input.region, width, height) : null;
  const tint = (o: number, c: readonly [number, number, number], alpha: number) => {
    out[o] = out[o] * (1 - alpha) + c[0] * alpha;
    out[o + 1] = out[o + 1] * (1 - alpha) + c[1] * alpha;
    out[o + 2] = out[o + 2] * (1 - alpha) + c[2] * alpha;
  };
  for (let i = 0, p = 0, o = 0; i < size; i++, p += channels, o += 3) {
    out[o] = data[p];
    out[o + 1] = data[p + 1];
    out[o + 2] = data[p + 2];
    if (input.roi && !input.roi[i]) {
      out[o] *= 0.45;
      out[o + 1] *= 0.45;
      out[o + 2] *= 0.45;
    }
    if (input.leaf[i]) tint(o, OVERLAY_COLORS.leaf, 0.55);
    else if (input.stressed[i]) tint(o, OVERLAY_COLORS.stressed, 0.7);
    if (regionEdge && regionEdge[i]) tint(o, OVERLAY_COLORS.region, 0.8);
  }
  return out;
}

/** Mask preview for the browser: RGBA with transparent background, for drawing over a photo. */
export function renderMaskRgba(width: number, height: number, leaf: BinaryMask, stressed: BinaryMask | null): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const c = leaf[i] ? OVERLAY_COLORS.leaf : stressed && stressed[i] ? OVERLAY_COLORS.stressed : null;
    if (!c) continue;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 150;
  }
  return out;
}
