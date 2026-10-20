import { z } from "zod";
import { mergeDefaults } from "../vision/settings";

// Plan §6.3 status thresholds. Starting values; calibrate per species.

export const detectionSettingsSchema = z.object({
  /** Wilting index (%) at or above which the status is Mild Wilting. */
  mildPct: z.number().min(0).max(100),
  /** Wilting index (%) at or above which the status is Wilting. */
  wiltingPct: z.number().min(0).max(100),
  /** Discoloration (%) at or above which a note is shown. Does not change the status. */
  discolorationPct: z.number().min(0).max(100),
});

export type DetectionSettings = z.infer<typeof detectionSettingsSchema>;

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  mildPct: 10,
  wiltingPct: 25,
  discolorationPct: 15,
};

export function parseDetectionSettings(value: unknown): DetectionSettings {
  const parsed = detectionSettingsSchema.safeParse(mergeDefaults(DEFAULT_DETECTION_SETTINGS, value));
  return parsed.success ? parsed.data : DEFAULT_DETECTION_SETTINGS;
}
