import type { DetectionSettings } from "./settings";

export type Status = "healthy" | "mild" | "wilting" | "unknown";

export const STATUS_LABELS: Record<Status, string> = {
  healthy: "Healthy",
  mild: "Mild Wilting",
  wilting: "Wilting",
  unknown: "Unknown",
};

/**
 * Plan §6.2: wilting index % = (baseline − current) ÷ baseline × 100, here on leaf cover (% of the
 * guide square). Negative = growth. Null when there is no usable baseline.
 */
export function wiltIndex(baselineCoverPct: number, currentCoverPct: number): number | null {
  if (!(baselineCoverPct > 0)) return null;
  return ((baselineCoverPct - currentCoverPct) / baselineCoverPct) * 100;
}

/** Plan §6.3. Negative values (growth) count as 0. */
export function statusFromIndex(pct: number | null | undefined, s: Pick<DetectionSettings, "mildPct" | "wiltingPct">): Status {
  if (pct == null || Number.isNaN(pct)) return "unknown";
  const clamped = Math.max(0, pct);
  if (clamped >= s.wiltingPct) return "wilting";
  if (clamped >= s.mildPct) return "mild";
  return "healthy";
}

export function hasDiscoloration(pct: number | null | undefined, s: Pick<DetectionSettings, "discolorationPct">): boolean {
  return pct != null && pct >= s.discolorationPct;
}
