import { describe, expect, it } from "vitest";
import { DEFAULT_DETECTION_SETTINGS, parseDetectionSettings } from "@/lib/detection/settings";
import { statusFromDiscoloration } from "@/lib/detection/status";

const s = DEFAULT_DETECTION_SETTINGS;

describe("status from one photo", () => {
  it("rates the plant by how much of it is yellow or brown", () => {
    expect(statusFromDiscoloration(0, s)).toBe("healthy");
    expect(statusFromDiscoloration(14.9, s)).toBe("healthy");
    expect(statusFromDiscoloration(15, s)).toBe("attention");
    expect(statusFromDiscoloration(29.9, s)).toBe("attention");
    expect(statusFromDiscoloration(30, s)).toBe("unhealthy");
    expect(statusFromDiscoloration(null, s)).toBe("unknown");
    expect(statusFromDiscoloration(Number.NaN, s)).toBe("unknown");
  });

  it("parses stored settings with defaults", () => {
    expect(parseDetectionSettings({ unhealthyPct: 40 })).toEqual({ ...s, unhealthyPct: 40 });
    expect(parseDetectionSettings({ unhealthyPct: "x" })).toEqual(s);
  });
});
