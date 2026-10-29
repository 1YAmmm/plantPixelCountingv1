import { z } from "zod";

// When the daily photo is taken (newplan.md step 2). The server owns the schedule: the camera just
// polls and is told when to take a photo. Pure, no I/O; time zones use Intl only (DST included).

/** 0 = Sunday … 6 = Saturday, like Date.getDay(). */
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** Monday first, for display. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A photo missed at the set time (camera offline) is still taken up to this long after. */
export const LATE_LIMIT_MS = 3 * 60 * 60 * 1000;
/** A photo taken more than this after the set time is reported as late. */
export const LATE_AFTER_MS = 15 * 60 * 1000;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const scheduleSchema = z.object({
  enabled: z.boolean(),
  days: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"),
  timeZone: z.string().refine(isTimeZone, "Unknown time zone"),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export const DEFAULT_SCHEDULE: Schedule = { enabled: false, days: [...ALL_DAYS], time: "07:00", timeZone: "UTC" };

export const MAX_RECIPIENTS = 20;

export const recipientsSchema = z
  .array(z.string().trim().toLowerCase().pipe(z.email("Not a valid email address")))
  .transform((list) => [...new Set(list)])
  .refine((list) => list.length >= 1, "Add at least one email")
  .refine((list) => list.length <= MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} emails`);

/** Split what was typed in the recipients box: one per line, or separated by commas/semicolons. */
export function splitRecipients(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface DateParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock date and time of `ms` in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): DateParts & { hour: number; minute: number; second: number } {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** UTC offset of `timeZone` at instant `ms`, in ms (Manila: +8 h). */
function offsetMs(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(whole, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * The instant (epoch ms) when it is `time` ("HH:MM") on `date` in `timeZone`. A time skipped by a
 * DST change (02:30 on the spring-forward day) moves forward by the gap; a repeated one (fall back)
 * resolves to the first occurrence.
 */
export function zonedToUtc(date: DateParts, time: string, timeZone: string): number {
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(date.year, date.month - 1, date.day, hh, mm);
  const o1 = offsetMs(guess, timeZone);
  const t1 = guess - o1;
  const o2 = offsetMs(t1, timeZone);
  if (o1 === o2) return t1;
  const t2 = guess - o2;
  return offsetMs(t2, timeZone) === o2 ? t2 : t1;
}

function addDays(date: DateParts, days: number): DateParts {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekday(date: DateParts): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Scheduled times (epoch ms) from `fromDay` days to `toDay` days relative to today in the schedule's zone. */
function slotTimes(schedule: Schedule, now: number, fromDay: number, toDay: number): number[] {
  const today = zonedParts(now, schedule.timeZone);
  const times: number[] = [];
  for (let k = fromDay; k <= toDay; k++) {
    const date = addDays(today, k);
    if (schedule.days.includes(weekday(date))) times.push(zonedToUtc(date, schedule.time, schedule.timeZone));
  }
  return times;
}

export interface Slot {
  /** "sched-<UTC ISO>"; the key of its report, so each slot is photographed once. */
  id: string;
  /** Scheduled time, epoch ms. */
  at: number;
}

export function slotId(at: number): string {
  return `sched-${new Date(at).toISOString()}`;
}

/** The scheduled time of a "sched-…" slot id, or null for anything else (manual photos). */
export function slotTime(id: string): number | null {
  if (!id.startsWith("sched-")) return null;
  const at = Date.parse(id.slice(6));
  return Number.isFinite(at) ? at : null;
}

/**
 * The latest scheduled time that is ≤ now and at most LATE_LIMIT_MS ago, or null. The caller
 * checks whether it was already photographed. `notBefore` (epoch ms) skips times before the
 * schedule was saved, so saving 07:00 at 08:00 does not take a photo straight away.
 */
export function dueSlot(schedule: Schedule, now: number, notBefore = 0): Slot | null {
  if (!schedule.enabled || schedule.days.length === 0) return null;
  const due = slotTimes(schedule, now, -1, 0).filter((t) => t <= now && now - t <= LATE_LIMIT_MS && t >= notBefore);
  if (due.length === 0) return null;
  const at = Math.max(...due);
  return { id: slotId(at), at };
}

/** The next scheduled time after now (epoch ms), or null when the schedule is off or has no days. */
export function nextRunAt(schedule: Schedule, now: number): number | null {
  if (!schedule.enabled || schedule.days.length === 0) return null;
  return slotTimes(schedule, now, 0, 8).find((t) => t > now) ?? null;
}

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
export function describeSchedule(schedule: Pick<Schedule, "days" | "time">): string {
  return `${describeDays(schedule.days)} at ${formatTime(schedule.time)}`;
}

/** "Tue 29 Oct 2026, 7:00" in the given zone. */
export function formatZoned(ms: number, timeZone: string, { year = true }: { year?: boolean } = {}): string {
  const p = zonedParts(ms, timeZone);
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(p.year, p.month - 1, 1)));
  const day = DAY_NAMES[weekday(p)];
  return `${day} ${p.day} ${month}${year ? ` ${p.year}` : ""}, ${p.hour}:${String(p.minute).padStart(2, "0")}`;
}
