// Days and time of the camera's report, for display. The camera keeps the schedule itself, in its
// local time: a fixed UTC offset taken from this device when saving (DST changes need a new save).

/** 0 = Sunday … 6 = Saturday, like Date.getDay(). */
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** Monday first, for display. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "07:00" → "7:00". */
export function formatTime(time: string): string {
  const [hh, mm] = time.split(":");
  return `${Number(hh)}:${mm}`;
}

/** "Every day", "Weekdays" or "Mon, Wed, Fri". */
export function describeDays(days: readonly number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 0) return "No days";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  return WEEK_ORDER.filter((d) => set.has(d))
    .map((d) => DAY_NAMES[d])
    .join(", ");
}

/** "Every day at 7:00". */
export function describeSchedule({ days, time }: { days: readonly number[]; time: string }): string {
  return `${describeDays(days)} at ${formatTime(time)}`;
}

/** This device's offset from UTC now, minutes east (Manila: 480). */
export function localUtcOffset(date = new Date()): number {
  return -date.getTimezoneOffset() || 0;
}

/** 480 → "UTC+8", 330 → "UTC+5:30", -180 → "UTC−3". */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const abs = Math.abs(minutes);
  const mm = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}
