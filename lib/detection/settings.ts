import { z } from "zod";
import { mergeDefaults } from "../vision/settings";

// The status thresholds, on the share of the plant that is yellow or brown (discoloration).
// Starting values; calibrate per species. The camera uses them too (firmware/esp32-cam/esp32-cam.ino).

export const detectionSettingsSchema = z.object({
  /** Discoloration (%) at or above which the status is Needs attention. */
  attentionPct: z.number().min(0).max(100),
  /** Discoloration (%) at or above which the status is Unhealthy. */
  unhealthyPct: z.number().min(0).max(100),
});

export type DetectionSettings = z.infer<typeof detectionSettingsSchema>;

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  attentionPct: 15,
  unhealthyPct: 30,
};

export function parseDetectionSettings(value: unknown): DetectionSettings {
  const parsed = detectionSettingsSchema.safeParse(mergeDefaults(DEFAULT_DETECTION_SETTINGS, value));
  return parsed.success ? parsed.data : DEFAULT_DETECTION_SETTINGS;
}
