import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { hueInRange, rgbToHsv } from "@/lib/vision/color";
import { rectGap } from "@/lib/vision/geometry";
import { guideRect, SQUARE_PX } from "@/lib/vision/guide";
import { cropGuideSquare } from "@/lib/vision/node";
import { buildRoiMask } from "@/lib/vision/roi";
import { DEFAULT_VISION_SETTINGS, mergeDefaults, parseVisionSettings } from "@/lib/vision/settings";
import { computeWhiteBalance } from "@/lib/vision/white-balance";
import { COLORS, renderScene, rosetteScene } from "./synthetic";

describe("rgbToHsv", () => {
  it("converts primary and neutral colours", () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 100, v: 100 });
    expect(rgbToHsv(0, 255, 0).h).toBe(120);
    expect(rgbToHsv(0, 0, 255).h).toBe(240);
    const gray = rgbToHsv(128, 128, 128);
    expect(gray.s).toBe(0);
    expect(gray.v).toBeCloseTo(50.2, 1);
  });

  it("puts leaf green and yellow in their plan ranges", () => {
    const leaf = rgbToHsv(...COLORS.leaf);
    expect(leaf.h).toBeGreaterThanOrEqual(70);
    expect(leaf.h).toBeLessThanOrEqual(170);
    const yellow = rgbToHsv(...COLORS.yellow);
    expect(yellow.h).toBeGreaterThanOrEqual(20);
    expect(yellow.h).toBeLessThanOrEqual(65);
  });

  it("supports wrapping hue ranges", () => {
    expect(hueInRange(350, 340, 20)).toBe(true);
    expect(hueInRange(10, 340, 20)).toBe(true);
    expect(hueInRange(180, 340, 20)).toBe(false);
  });
});

describe("guideRect", () => {
  it("is a centred square of 80% of the shorter side", () => {
    const r = guideRect(1600, 1200);
    expect(r.width * 1600).toBeCloseTo(960, 6);
    expect(r.height * 1200).toBeCloseTo(960, 6);
    expect(r.x * 1600 + (r.width * 1600) / 2).toBeCloseTo(800, 6);
    expect(r.y * 1200 + (r.height * 1200) / 2).toBeCloseTo(600, 6);
  });

  it("works for portrait photos", () => {
    const r = guideRect(900, 1600);
    expect(r.width * 900).toBeCloseTo(720, 6);
    expect(r.height * 1600).toBeCloseTo(720, 6);
  });
});

describe("cropGuideSquare", () => {
  /** A width × height JPEG: red outside the guide square, white inside, blue corners and a black centre dot inside it. */
  async function markedPhoto(width: number, height: number, orientation?: number) {
    const r = guideRect(width, height);
    const [left, top, side] = [r.x * width, r.y * height, r.width * width];
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = (x - left) / side;
        const v = (y - top) / side;
        const inside = u >= 0 && u < 1 && v >= 0 && v < 1;
        const corner = inside && (u < 0.05 || u > 0.95) && (v < 0.05 || v > 0.95);
        const centre = inside && Math.abs(u - 0.5) < 0.03 && Math.abs(v - 0.5) < 0.03;
        const c = !inside ? [220, 30, 30] : corner ? [30, 30, 220] : centre ? [0, 0, 0] : [240, 240, 240];
        data.set(c, (y * width + x) * 3);
      }
    }
    let img = sharp(data, { raw: { width, height, channels: 3 } });
    // Stored rotated, with the EXIF tag that turns it upright again.
    if (orientation === 6) img = img.rotate(-90).withMetadata({ orientation: 6 });
    return img.jpeg({ quality: 95 }).toBuffer();
  }

  async function pixel(jpeg: Buffer, x: number, y: number) {
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const p = (y * info.width + x) * info.channels;
    return [data[p], data[p + 1], data[p + 2]];
  }

  it.each([
    [1600, 1200, undefined],
    [1280, 1024, undefined],
    [1200, 1600, 6],
  ])("crops the guide square of a %i × %i photo (EXIF %s) to the analyzed size", async (width, height, orientation) => {
    const out = await cropGuideSquare(await markedPhoto(width, height, orientation));
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([SQUARE_PX, SQUARE_PX]);
    for (const [x, y] of [
      [10, 10],
      [990, 10],
      [10, 990],
      [990, 990],
    ]) {
      const [r, g, b] = await pixel(out, x, y);
      expect(b).toBeGreaterThan(150);
      expect(r).toBeLessThan(90);
      expect(g).toBeLessThan(90);
    }
    expect(Math.max(...(await pixel(out, 500, 500)))).toBeLessThan(60);
    // Just inside the edges: the guide square's white, none of the red outside it.
    for (const [x, y] of [
      [500, 3],
      [500, 996],
      [3, 500],
      [996, 500],
    ]) {
      expect(Math.min(...(await pixel(out, x, y)))).toBeGreaterThan(180);
    }
  });
});

describe("geometry", () => {
  it("measures the gap between rectangles", () => {
    expect(rectGap({ x: 0, y: 0, width: 10, height: 10 }, { x: 13, y: 14, width: 5, height: 5 })).toBeCloseTo(5, 6);
    expect(rectGap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(0);
  });
});

describe("buildRoiMask", () => {
  it("uses the whole square or the crop box", () => {
    expect(buildRoiMask(10, 10, null).count).toBe(100);
    expect(buildRoiMask(10, 10, { x: 0, y: 0, width: 0.5, height: 1 }).count).toBe(50);
  });
});

describe("computeWhiteBalance (white backdrop)", () => {
  const wb = DEFAULT_VISION_SETTINGS.whiteBalance;

  it("inverts a warm colour cast", () => {
    const { image } = renderScene(rosetteScene({ size: 200, cast: [1.12, 1, 0.8] }));
    const result = computeWhiteBalance(image, wb);
    expect(result.applied).toBe(true);
    // The backdrop reference is warm (red high, blue low), so red is turned down and blue up.
    const [r, , b] = result.reference!.mean;
    expect(r).toBeGreaterThan(b + 40);
    expect(result.gains[0]).toBeLessThan(1);
    expect(result.gains[2]).toBeGreaterThan(1.2);
    // Reference pixels are the backdrop, not the plant.
    expect(result.reference!.pixels).toBeGreaterThan(200 * 200 * 0.1);
  });

  it("is skipped when no white background is visible", () => {
    const { image } = renderScene({ width: 100, height: 100, background: COLORS.leaf, shapes: [] });
    expect(computeWhiteBalance(image, wb).applied).toBe(false);
  });
});

describe("settings", () => {
  it("fills missing fields from defaults and drops removed ones", () => {
    const s = parseVisionSettings({ leaf: { hueMin: 80 }, marker: { sizeCm: 5 }, phoneLongEdge: 1280 });
    expect(s.leaf.hueMin).toBe(80);
    expect(s.leaf.hueMax).toBe(170);
    expect(s).not.toHaveProperty("marker");
    expect(s).not.toHaveProperty("phoneLongEdge");
  });

  it("falls back to defaults on invalid input", () => {
    expect(parseVisionSettings({ leaf: { hueMin: "x" } })).toEqual(DEFAULT_VISION_SETTINGS);
    expect(mergeDefaults({ a: 1, b: { c: 2 } }, { b: { d: 3 } })).toEqual({ a: 1, b: { c: 2, d: 3 } });
  });
});
