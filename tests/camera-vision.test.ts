import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DEFAULT_DETECTION_SETTINGS } from "@/lib/detection/settings";
import { analyzeImage } from "@/lib/vision/analyze";
import { CAMERA_SQUARE_PX, GUIDE_FRACTION, SQUARE_PX } from "@/lib/vision/guide";
import { cameraSquare, cropGuideSquare, runPipeline } from "@/lib/vision/node";
import { CAMERA_VISION_SETTINGS, DEFAULT_VISION_SETTINGS } from "@/lib/vision/settings";

// The camera analyzes the guide square at CAMERA_SQUARE_PX, box-averaged, with CAMERA_VISION_SETTINGS
// (firmware/esp32-cam/vision.cpp). These tests check that this gives the same answers as the
// 1000 px pipeline, and that the firmware uses these numbers. On the camera itself, the serial
// command "analyze:<bytes>" analyzes a JPEG sent from the PC (see the README).

const fixtures = path.join(import.meta.dirname, "../test-images/synthetic");
const names = Object.keys(JSON.parse(readFileSync(path.join(fixtures, "manifest.json"), "utf8")));
const codes = (a: { issues: { code: string }[] }) => a.issues.map((i) => i.code);

describe("camera analysis", () => {
  it.each(names)("%s: same leaf cover, discoloration and photo checks as the 1000 px pipeline", async (name) => {
    const jpeg = await readFile(path.join(fixtures, name));
    const square = await cameraSquare(jpeg);
    expect([square.width, square.height]).toEqual([CAMERA_SQUARE_PX, CAMERA_SQUARE_PX]);
    const camera = analyzeImage(square, { settings: CAMERA_VISION_SETTINGS });
    const full = (await runPipeline(await cropGuideSquare(jpeg), { settings: DEFAULT_VISION_SETTINGS, maxLongEdge: SQUARE_PX })).analysis;
    expect(Math.abs(camera.metrics.coveragePct - full.metrics.coveragePct)).toBeLessThan(0.1);
    expect(Math.abs(camera.metrics.discolorationPct - full.metrics.discolorationPct)).toBeLessThan(0.5);
    expect(codes(camera)).toEqual(codes(full));
  });

  it("averages each cell of the guide square", async () => {
    // A 1250 × 1000 photo: the guide square is 800 px at (225, 100), 1.6 photo pixels per cell;
    // its left half (400 px, cells 0–249) is dark.
    const width = 1250;
    const height = 1000;
    const data = Buffer.alloc(width * height * 3, 200);
    for (let y = 100; y < 900; y++) data.fill(40, (y * width + 225) * 3, (y * width + 625) * 3);
    const png = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const square = await cameraSquare(png);
    expect(square.width).toBe(CAMERA_SQUARE_PX);
    const row = 250 * CAMERA_SQUARE_PX * 3;
    expect(square.data[row]).toBe(40);
    expect(square.data[row + (CAMERA_SQUARE_PX - 1) * 3]).toBe(200);
    expect(square.data[row + 249 * 3]).toBe(40);
    expect(square.data[row + 250 * 3]).toBe(200);
  });
});

describe("firmware", () => {
  const dir = path.join(import.meta.dirname, "../firmware/esp32-cam");
  const header = readFileSync(path.join(dir, "vision.h"), "utf8");
  const vision = readFileSync(path.join(dir, "vision.cpp"), "utf8");
  const constant = (name: string) => Number(vision.match(new RegExp(`\\b${name} = ([\\d.]+)f?;`))?.[1]);
  const rule = (name: string) => vision.match(new RegExp(`\\b${name} = \\{([^}]+)\\};`))?.[1].split(",").map(Number);
  const s = CAMERA_VISION_SETTINGS;

  it("analyzes the same square as CAMERA_SQUARE_PX", () => {
    expect(Number(header.match(/#define VISION_SQUARE_PX (\d+)/)?.[1])).toBe(CAMERA_SQUARE_PX);
    expect(constant("GUIDE_FRACTION")).toBe(GUIDE_FRACTION);
  });

  it("uses CAMERA_VISION_SETTINGS", () => {
    expect(rule("LEAF")).toEqual([s.leaf.hueMin, s.leaf.hueMax, s.leaf.satMin, s.leaf.valMin]);
    expect(rule("STRESSED")).toEqual([s.stressed.hueMin, s.stressed.hueMax, s.stressed.satMin, s.stressed.valMin]);
    expect({
      maxSaturation: constant("WB_MAX_SATURATION"),
      minValue: constant("WB_MIN_VALUE"),
      targetGray: constant("WB_TARGET_GRAY"),
      openSize: constant("OPEN_SIZE"),
      closeSize: constant("CLOSE_SIZE"),
      stressedOpenSize: constant("STRESSED_OPEN_SIZE"),
      minBlobPct: constant("MIN_BLOB_PCT"),
      mergeDistancePct: constant("MERGE_DISTANCE_PCT"),
      minBrightness: constant("MIN_BRIGHTNESS"),
      maxBrightness: constant("MAX_BRIGHTNESS"),
      minSharpness: constant("MIN_SHARPNESS"),
    }).toEqual({
      maxSaturation: s.whiteBalance.maxSaturation,
      minValue: s.whiteBalance.minValue,
      targetGray: s.whiteBalance.targetGray,
      openSize: s.cleanup.openSize,
      closeSize: s.cleanup.closeSize,
      stressedOpenSize: s.cleanup.stressedOpenSize,
      minBlobPct: s.cleanup.minBlobPct,
      mergeDistancePct: s.cleanup.mergeDistancePct,
      minBrightness: s.quality.minBrightness,
      maxBrightness: s.quality.maxBrightness,
      minSharpness: s.quality.minSharpness,
    });
    // The firmware has no switches for these: white balance always on and normalizing exposure.
    expect([s.whiteBalance.enabled, s.whiteBalance.normalizeExposure]).toEqual([true, true]);
  });

  it("uses the status thresholds of lib/detection", () => {
    const sketch = readFileSync(path.join(dir, "esp32-cam.ino"), "utf8");
    const value = (name: string) => Number(sketch.match(new RegExp(`\\b${name} = ([\\d.]+);`))?.[1]);
    expect({ attentionPct: value("ATTENTION_PCT"), unhealthyPct: value("UNHEALTHY_PCT") }).toEqual(DEFAULT_DETECTION_SETTINGS);
  });
});

describe("firmware JPEG encoder tables", () => {
  const jpeg = readFileSync(path.join(import.meta.dirname, "../firmware/esp32-cam/jpeg.cpp"), "utf8");
  const table = (name: string) =>
    jpeg
      .match(new RegExp(`\\b${name}\\[\\d+\\] = \\{([^}]+)\\}`))?.[1]
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map(Number) ?? [];

  it("maps each block position to its zigzag position", () => {
    const zigzag = new Array<number>(64);
    let k = 0;
    for (let s = 0; s < 15; s++) {
      const rows = Array.from({ length: 8 }, (_, r) => r).filter((r) => s - r >= 0 && s - r < 8);
      for (const r of s % 2 ? rows : rows.reverse()) zigzag[r * 8 + (s - r)] = k++;
    }
    expect(table("ZIGZAG")).toEqual(zigzag);
  });

  it("has complete Huffman tables: every DC size and every AC run/size symbol, each once", () => {
    const acSymbols = [0x00, 0xf0, ...Array.from({ length: 160 }, (_, i) => ((i / 10) << 4) | ((i % 10) + 1))].sort((a, b) => a - b);
    const tables = [
      ["DC_LUMA_BITS", "DC_VALUES", Array.from({ length: 12 }, (_, i) => i)],
      ["DC_CHROMA_BITS", "DC_VALUES", Array.from({ length: 12 }, (_, i) => i)],
      ["AC_LUMA_BITS", "AC_LUMA_VALUES", acSymbols],
      ["AC_CHROMA_BITS", "AC_CHROMA_VALUES", acSymbols],
    ] as const;
    for (const [bitsName, valuesName, symbols] of tables) {
      const bits = table(bitsName);
      const values = table(valuesName);
      expect(bits).toHaveLength(16);
      expect(bits.reduce((a, b) => a + b, 0)).toBe(values.length);
      expect([...values].sort((a, b) => a - b)).toEqual(symbols);
      // A canonical prefix code: the codes of each length fit in that many bits.
      let code = 0;
      bits.forEach((count, i) => {
        code += count;
        expect(code).toBeLessThanOrEqual(2 ** (i + 1));
        code *= 2;
      });
    }
  });
});
