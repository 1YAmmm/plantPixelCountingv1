import { z } from "zod";
import { BASELINE_SAMPLES } from "../detection/baseline";
import { detectionSettingsSchema } from "../detection/settings";
import type { Status } from "../detection/status";
import { visionSettingsSchema } from "../vision/settings";
import { recipientsSchema, scheduleSchema, type Schedule } from "./schedule";

// What the daily report keeps on the server (newplan.md steps 1 and 5), shared by the route
// handlers and the Settings card. No Node.js dependencies.

/** The analysis settings copied from the browser that set up the report (they live in localStorage). */
export const analysisSnapshotSchema = z.object({
  vision: visionSettingsSchema,
  thresholds: detectionSettingsSchema,
  /** Leaf cover % of the ESP32 baseline photos; empty = no baseline yet. */
  baselineCoverPcts: z.array(z.number().min(0).max(100)).max(BASELINE_SAMPLES),
  /** ISO time. */
  copiedAt: z.string(),
});

export type AnalysisSnapshot = z.infer<typeof analysisSnapshotSchema>;

export interface AutomationConfig {
  schedule?: Schedule;
  /** ISO time the schedule was last changed: earlier set times are not photographed. */
  scheduleSince?: string;
  recipients?: string[];
  analysis?: AnalysisSnapshot;
  /** "manual-<ms>": a test photo was asked for from the Settings page. */
  captureNow?: string;
}

export interface DeviceRecord {
  /** ISO time of the camera's last poll. */
  lastSeenAt: string;
  firmware: string | null;
  ip: string | null;
  rssi: number | null;
  freeHeap: number | null;
}

export interface ReportSummary {
  slotId: string;
  /** "processing" while the photo is being analyzed and emailed. */
  state: "processing" | "done";
  /** ISO time the photo arrived. */
  receivedAt: string;
  /** ISO scheduled time; null for a test photo. */
  scheduledAt: string | null;
  late: boolean;
  status: Status;
  wilt: number | null;
  coverPct: number;
  discolorationPct: number;
  baselinePct: number | null;
  issues: string[];
  /** Addresses the email went to (empty if it failed). */
  sentTo: string[];
  emailError: string | null;
}

/** PUT /api/automation: each setup step saves its own part. */
export const automationUpdateSchema = z.object({
  recipients: recipientsSchema.optional(),
  schedule: scheduleSchema.optional(),
  analysis: analysisSnapshotSchema.optional(),
});

export type AutomationUpdate = z.input<typeof automationUpdateSchema>;

/** GET /api/automation (and the PUT reply). */
export interface AutomationState {
  schedule: Schedule | null;
  recipients: string[];
  analysis: AnalysisSnapshot | null;
  /** ISO time of the next scheduled photo, null when off. */
  nextRunAt: string | null;
  device: DeviceRecord | null;
  lastReport: ReportSummary | null;
  /** A test photo waiting for the camera's next poll. */
  captureNow: string | null;
  /** Sent to the camera during WiFi setup; null when DEVICE_API_KEY is not set. */
  deviceKey: string | null;
  /** Whether GMAIL_USER and GMAIL_APP_PASSWORD are set. */
  emailConfigured: boolean;
  /** ISO server time, to compare with lastSeenAt without trusting the browser's clock. */
  serverTime: string;
}

export interface AutomationError {
  error: string;
}
