// When the camera sends its report, for display: at a time on some days, or every so many minutes
// round the clock. The camera keeps the schedule itself, in its local time: a fixed UTC offset
// taken from this device when saving (DST changes need a new save).

/** 0 = Sunday … 6 = Saturday, like Date.getDay(). */
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** Monday first, for display. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The intervals offered, each dividing a day, so the reports fall on the same clock times every day (every 30 minutes: :00 and :30). */
export const EVERY_MINUTES = [1, 2, 5, 10, 15, 30] as const;
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;

/** "07:00" → "7:00 AM", "18:30" → "6:30 PM", "00:15" → "12:15 AM". */
export function formatTime(time: string): string {
  const [hh, mm] = time.split(":");
  const h = Number(hh);
  return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** "Every minute", "Every 30 minutes", "Every hour", "Every 12 hours". */
export function describeEvery(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
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

/** "Every day at 7:00 AM", or "Every 30 minutes". */
export function describeSchedule({ days, time, everyMinutes }: { days: readonly number[]; time: string; everyMinutes?: number }): string {
  return everyMinutes ? describeEvery(everyMinutes) : `${describeDays(days)} at ${formatTime(time)}`;
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
