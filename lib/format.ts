export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
}

export function formatPct(pct: number | null | undefined, digits = 1): string {
  return pct == null ? "—" : `${pct.toFixed(digits)}%`;
}

/** Wilting index for display: growth (negative) shows as 0%. */
export function formatWilt(pct: number | null | undefined): string {
  return pct == null ? "—" : `${Math.max(0, pct).toFixed(1)}%`;
}

export function formatNumber(n: number | null | undefined): string {
  return n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n));
}
