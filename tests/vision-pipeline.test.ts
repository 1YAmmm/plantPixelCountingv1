import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { analyzeImage } from "@/lib/vision/analyze";
import { SQUARE_PX } from "@/lib/vision/guide";
import { decodeImage, runPipeline } from "@/lib/vision/node";
import { DEFAULT_VISION_SETTINGS, type VisionSettings } from "@/lib/vision/settings";
import type { RgbImage } from "@/lib/vision/types";
import { COLORS, renderScene, rosetteScene, type SceneSpec } from "./synthetic";

const settings: VisionSettings = DEFAULT_VISION_SETTINGS;

/** Round-trip through JPEG like a real upload, so edges and colours get compression artefacts. */
async function asJpeg(img: RgbImage, quality = 88, blurSigma = 0): Promise<Buffer> {
  let p = sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } });
  if (blurSigma > 0) p = p.blur(blurSigma);
  return p.jpeg({ quality }).toBuffer();
}

async function analyzeScene(spec: SceneSpec, opts: { blur?: number } = {}) {
  const { image, truth } = renderScene(spec);
  const decoded = await decodeImage(await asJpeg(image, 88, opts.blur ?? 0));
  return { analysis: analyzeImage(decoded, { settings }), truth };
}

const relErr = (a: number, b: number) => Math.abs(a - b) / b;
const codes = (a: { issues: { code: string }[] }) => a.issues.map((i) => i.code);

describe("pipeline — leaf cover", () => {
  it("counts a known green shape within 3%", async () => {
    const spec: SceneSpec = {
      width: 1000,
      height: 1000,
      noise: 3,
      shapes: [{ kind: "ellipse", cx: 500, cy: 500, rx: 220, ry: 140, color: COLORS.leaf, class: "leaf" }],
    };
    const { analysis, truth } = await analyzeScene(spec);
    expect(analysis.issues).toEqual([]);
    expect(relErr(analysis.metrics.leafPixels, truth.leafPixels)).toBeLessThan(0.03);
    expect(analysis.metrics.coveragePct).toBeCloseTo(truth.coverPct, 0);
  });

  it("measures a rosette within 3%", async () => {
    const { analysis, truth } = await analyzeScene(rosetteScene({}));
    expect(relErr(analysis.metrics.leafPixels, truth.leafPixels)).toBeLessThan(0.03);
  });

  it("is repeatable: re-analyzing the prepared image gives identical numbers", async () => {
    const { image } = renderScene(rosetteScene({}));
    const a = await runPipeline(await asJpeg(image), { settings, maxLongEdge: SQUARE_PX });
    const b = await runPipeline(a.imageJpeg, { settings, maxLongEdge: "prepared" });
    expect(b.analysis.metrics).toEqual(a.analysis.metrics);
  });

  it("gives the same cover % whatever the camera resolution (square resized to 1000 px)", async () => {
    const big = renderScene(rosetteScene({ size: 1500 }));
    const result = await runPipeline(await asJpeg(big.image), { settings, maxLongEdge: SQUARE_PX });
    expect(result.analysis.width).toBe(SQUARE_PX);
    expect(Math.abs(result.analysis.metrics.coveragePct - big.truth.coverPct)).toBeLessThan(0.5);
  });

  it("keeps cover % when a crop box only removes clutter", async () => {
    const spec = rosetteScene({ extras: [{ kind: "ellipse", cx: 70, cy: 930, rx: 40, ry: 30, color: COLORS.leaf, class: "other" }] });
    const { image } = renderScene(spec);
    const decoded = await decodeImage(await asJpeg(image));
    const whole = analyzeImage(decoded, { settings });
    const cropped = analyzeImage(decoded, { settings, roi: { x: 0.15, y: 0.15, width: 0.7, height: 0.7 } });
    expect(relErr(cropped.metrics.coveragePct, whole.metrics.coveragePct)).toBeLessThan(0.01);
    expect(cropped.metrics.roiPixels).toBeLessThan(whole.metrics.roiPixels);
  });
});

describe("pipeline — cleanup and discoloration", () => {
  it("ignores small specks and a distant green object", async () => {
    const spec = rosetteScene({
      extras: [
        { kind: "ellipse", cx: 70, cy: 930, rx: 40, ry: 30, color: COLORS.leaf, class: "other" },
        { kind: "rect", cx: 150, cy: 120, rx: 2, ry: 2, color: COLORS.leaf, class: "other" },
      ],
    });
    const { analysis, truth } = await analyzeScene(spec);
    expect(relErr(analysis.metrics.leafPixels, truth.leafPixels)).toBeLessThan(0.03);
  });

  it("counts yellow patches inside the plant region as discoloration", async () => {
    const healthy = await analyzeScene(rosetteScene({}));
    const spots = Array.from({ length: 7 }, (_, k) => {
      const r = (k / 7) * 2 * Math.PI;
      return {
        kind: "ellipse" as const,
        cx: 500 + Math.cos(r) * 100,
        cy: 500 + Math.sin(r) * 100,
        rx: 40,
        ry: 25,
        angleDeg: (k / 7) * 360,
        color: COLORS.yellow,
        class: "stressed" as const,
      };
    });
    const spotted = await analyzeScene(rosetteScene({ extras: spots }));
    const truthPct = (100 * spotted.truth.stressedPixels) / (spotted.truth.leafPixels + spotted.truth.stressedPixels);
    expect(healthy.analysis.metrics.discolorationPct).toBeLessThan(1);
    expect(Math.abs(spotted.analysis.metrics.discolorationPct - truthPct)).toBeLessThan(2);
  });

  it("only partly counts fully yellow outer leaves (they lie outside the green hull)", async () => {
    // Plan §5 step 7: the region is the hull of the *green* mask. Yellowed leaves still lower the
    // green leaf cover, which is what drives the wilting index.
    const healthy = await analyzeScene(rosetteScene({}));
    const yellowed = await analyzeScene(rosetteScene({ yellowLeaves: 2 }));
    expect(yellowed.analysis.metrics.discolorationPct).toBeGreaterThan(2);
    expect(yellowed.analysis.metrics.coveragePct).toBeLessThan(healthy.analysis.metrics.coveragePct * 0.8);
  });

  it("does not count brown objects outside the plant region", async () => {
    const { analysis } = await analyzeScene(rosetteScene({ extras: [{ kind: "rect", cx: 880, cy: 880, rx: 70, ry: 50, color: COLORS.brown, class: "other" }] }));
    expect(analysis.metrics.discolorationPct).toBeLessThan(1);
  });

  it("shows a drooped plant as less leaf cover", async () => {
    const healthy = await analyzeScene(rosetteScene({ leafLength: 220 }));
    const wilted = await analyzeScene(rosetteScene({ leafLength: 176 }));
    const index = (1 - wilted.analysis.metrics.coveragePct / healthy.analysis.metrics.coveragePct) * 100;
    // Area scales with length² → expected index ≈ 36%.
    expect(index).toBeGreaterThan(30);
    expect(index).toBeLessThan(42);
  });
});

describe("pipeline — white balance from the backdrop", () => {
  it("corrects a warm colour cast", async () => {
    const neutral = await analyzeScene(rosetteScene({}));
    const warm = await analyzeScene(rosetteScene({ cast: [1.12, 1.0, 0.8] }));
    expect(warm.analysis.whiteBalance.applied).toBe(true);
    expect(relErr(warm.analysis.metrics.leafPixels, neutral.analysis.metrics.leafPixels)).toBeLessThan(0.03);
  });

  it("normalizes exposure so a dim photo gives the same cover", async () => {
    const neutral = await analyzeScene(rosetteScene({}));
    const dim = await analyzeScene(rosetteScene({ cast: [0.4, 0.4, 0.4] }));
    expect(dim.analysis.issues).toEqual([]);
    expect(relErr(dim.analysis.metrics.leafPixels, neutral.analysis.metrics.leafPixels)).toBeLessThan(0.03);
  });
});

describe("pipeline — quality checks", () => {
  it("flags dark and over-exposed photos", async () => {
    const dark = await analyzeScene(rosetteScene({ cast: [0.18, 0.18, 0.18] }));
    expect(codes(dark.analysis)).toContain("too_dark");
    const bright = await analyzeScene(rosetteScene({ background: [252, 252, 252], cast: [1.08, 1.08, 1.08] }));
    expect(codes(bright.analysis)).toContain("too_bright");
  });

  it("flags blurry photos but not sharp or slightly soft ones", async () => {
    expect(codes((await analyzeScene(rosetteScene({}))).analysis)).not.toContain("blurry");
    expect(codes((await analyzeScene(rosetteScene({}), { blur: 2 })).analysis)).not.toContain("blurry");
    expect(codes((await analyzeScene(rosetteScene({}), { blur: 10 })).analysis)).toContain("blurry");
  });

  it("scores sharpness independently of exposure", async () => {
    const normal = await analyzeScene(rosetteScene({}));
    const dim = await analyzeScene(rosetteScene({ cast: [0.4, 0.4, 0.4] }));
    expect(relErr(dim.analysis.sharpness, normal.analysis.sharpness)).toBeLessThan(0.1);
  });
});

describe("pipeline — performance", () => {
  it("processes a 1000 px square well under 2 s", async () => {
    const { image } = renderScene(rosetteScene({}));
    const result = await runPipeline(await asJpeg(image), { settings, maxLongEdge: SQUARE_PX });
    expect(result.totalMs).toBeLessThan(2000);
  });
});
