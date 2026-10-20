import { describe, expect, it } from "vitest";
import { hueInRange, rgbToHsv } from "@/lib/vision/color";
import { convexHull, dilateSquare, fillConvexPolygon, maskHull, rectGap } from "@/lib/vision/geometry";
import { guideRect } from "@/lib/vision/guide";
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

describe("geometry", () => {
  it("finds the convex hull", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 2, y: 2 },
      { x: 1, y: 3 },
    ];
    expect(convexHull(pts)).toHaveLength(4);
  });

  it("rasterizes a polygon by pixel centres", () => {
    const square = [
      { x: 2, y: 2 },
      { x: 6, y: 2 },
      { x: 6, y: 5 },
      { x: 2, y: 5 },
    ];
    expect(fillConvexPolygon(square, 10, 10).reduce((s, v) => s + v, 0)).toBe(12);
  });

  it("fills the hull of an L-shaped mask", () => {
    // 3×3 L: hull covers the missing corner's half → filled hull includes the L plus the diagonal half.
    const m = new Uint8Array([1, 0, 0, 1, 0, 0, 1, 1, 1]);
    const filled = fillConvexPolygon(maskHull(m, 3, 3), 3, 3);
    for (let i = 0; i < 9; i++) if (m[i]) expect(filled[i]).toBe(1);
  });

  it("dilates with a square kernel", () => {
    const m = new Uint8Array(25);
    m[12] = 1;
    expect(dilateSquare(m, 5, 5, 1).reduce((s, v) => s + v, 0)).toBe(9);
    expect(dilateSquare(m, 5, 5, 2).reduce((s, v) => s + v, 0)).toBe(25);
  });

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
