import { z } from "zod";

// All thresholds are starting values (plan §5), tuned during calibration on the Settings page.

const hsvRule = z.object({
  /** Hue range in degrees. If hueMin > hueMax the range wraps around 360°. */
  hueMin: z.number().min(0).max(360),
  hueMax: z.number().min(0).max(360),
  /** Minimum saturation, percent. */
  satMin: z.number().min(0).max(100),
  /** Minimum value (brightness), percent. */
  valMin: z.number().min(0).max(100),
});

export const visionSettingsSchema = z.object({
  leaf: hsvRule,
  stressed: hsvRule,
  whiteBalance: z.object({
    enabled: z.boolean(),
    /** Backdrop reference pixels must be at most this saturated (percent)… */
    maxSaturation: z.number().min(0).max(100),
    /** …and at least this bright (percent). */
    minValue: z.number().min(0).max(100),
    /**
     * Also scale the backdrop to `targetGray` (0–255), which normalizes exposure as well as colour.
     * If false, the backdrop keeps its own brightness and only the colour cast is removed.
     */
    normalizeExposure: z.boolean(),
    targetGray: z.number().min(50).max(255),
  }),
  cleanup: z.object({
    /** Opening kernel size (px) for speckle removal. 0 disables it. */
    openSize: z.number().int().min(0).max(15),
    /** Closing kernel size (px) to fill small holes in leaves. 0 disables it. */
    closeSize: z.number().int().min(0).max(25),
    /** Opening kernel size for the stressed mask. 0 disables it. */
    stressedOpenSize: z.number().int().min(0).max(15),
    /** Drop blobs smaller than this percent of the region of interest. */
    minBlobPct: z.number().min(0).max(100),
    /** Keep blobs whose bounding box lies within this percent of the image's long edge of the main blob. */
    mergeDistancePct: z.number().min(0).max(100),
  }),
  plantRegion: z.object({
    /** "hull": convex hull of the leaf mask; "dilate": leaf mask grown by dilatePx. */
    mode: z.enum(["hull", "dilate"]),
    dilatePx: z.number().int().min(0).max(200),
  }),
  quality: z.object({
    /** Mean brightness limits, percent. */
    minBrightness: z.number().min(0).max(100),
    maxBrightness: z.number().min(0).max(100),
    /** Minimum edge-strength score (see quality.ts). */
    minSharpness: z.number().min(0),
  }),
});

export type VisionSettings = z.infer<typeof visionSettingsSchema>;
export type HsvRule = z.infer<typeof hsvRule>;

export const DEFAULT_VISION_SETTINGS: VisionSettings = {
  leaf: { hueMin: 70, hueMax: 170, satMin: 16, valMin: 16 },
  stressed: { hueMin: 20, hueMax: 65, satMin: 25, valMin: 15 },
  whiteBalance: { enabled: true, maxSaturation: 35, minValue: 25, normalizeExposure: true, targetGray: 230 },
  cleanup: { openSize: 3, closeSize: 5, stressedOpenSize: 3, minBlobPct: 0.1, mergeDistancePct: 5 },
  plantRegion: { mode: "hull", dilatePx: 15 },
  quality: { minBrightness: 20, maxBrightness: 90, minSharpness: 25 },
};

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively fill missing keys of `value` from `defaults`. Arrays and scalars in `value` win. */
export function mergeDefaults<T>(defaults: T, value: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(value)) {
    return (value === undefined || value === null ? defaults : value) as T;
  }
  const out: PlainObject = { ...defaults };
  for (const [key, v] of Object.entries(value)) {
    out[key] = key in defaults ? mergeDefaults((defaults as PlainObject)[key], v) : v;
  }
  return out as T;
}

/** Parse stored (possibly partial or outdated) settings, falling back to defaults for missing fields. */
export function parseVisionSettings(value: unknown): VisionSettings {
  const merged = mergeDefaults(DEFAULT_VISION_SETTINGS, value);
  const parsed = visionSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_VISION_SETTINGS;
}
