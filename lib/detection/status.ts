import type { DetectionSettings } from "./settings";

export type Status = "healthy" | "attention" | "unhealthy" | "unknown";

export const STATUS_LABELS: Record<Status, string> = {
  healthy: "Healthy",
  attention: "Needs attention",
  unhealthy: "Unhealthy",
  unknown: "Can't tell",
};

/**
 * The status straight from one photo: how much of the plant is yellow or brown. Unknown without
 * a measurement (a photo problem, or no plant in view).
 */
export function statusFromDiscoloration(pct: number | null | undefined, s: DetectionSettings): Status {
  if (pct == null || Number.isNaN(pct)) return "unknown";
  if (pct >= s.unhealthyPct) return "unhealthy";
  if (pct >= s.attentionPct) return "attention";
  return "healthy";
}
