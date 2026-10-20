import { describe, expect, it } from "vitest";
import { calibrationBaseline } from "@/lib/detection/baseline";
import { DEFAULT_DETECTION_SETTINGS, parseDetectionSettings } from "@/lib/detection/settings";
import { hasDiscoloration, statusFromIndex, wiltIndex } from "@/lib/detection/status";

const s = DEFAULT_DETECTION_SETTINGS;

describe("wilting index and status", () => {
  it("computes the share of baseline leaf cover that is missing", () => {
    expect(wiltIndex(20, 15)).toBe(25);
    expect(wiltIndex(20, 22)).toBe(-10);
    expect(wiltIndex(0, 5)).toBeNull();
  });

  it("maps the index to the plan's thresholds", () => {
    expect(statusFromIndex(-15, s)).toBe("healthy");
    expect(statusFromIndex(9.9, s)).toBe("healthy");
    expect(statusFromIndex(10, s)).toBe("mild");
    expect(statusFromIndex(24.9, s)).toBe("mild");
    expect(statusFromIndex(25, s)).toBe("wilting");
    expect(statusFromIndex(null, s)).toBe("unknown");
  });

  it("flags discoloration separately", () => {
    expect(hasDiscoloration(15, s)).toBe(true);
    expect(hasDiscoloration(14.9, s)).toBe(false);
  });

  it("parses stored thresholds with defaults", () => {
    expect(parseDetectionSettings({ wiltingPct: 30 })).toEqual({ ...s, wiltingPct: 30 });
    expect(parseDetectionSettings({ wiltingPct: "x" })).toEqual(s);
  });
});

describe("baseline", () => {
  it("averages the calibration photos", () => {
    expect(calibrationBaseline([12, 13, 14])).toBe(13);
    expect(() => calibrationBaseline([])).toThrow();
  });
});
